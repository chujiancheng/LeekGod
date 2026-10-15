/**
 * 数据库连接与表结构（SQLite，单文件）
 *
 * 写入方只有一个：游戏主循环。所以用 WAL + synchronous=NORMAL 就够了——
 * 进程被强杀（server.py 用 taskkill /F）不会丢已提交的事务，
 * 只有整机断电这种 OS 层崩溃才可能丢掉最后几笔，此时靠轮转全量扫描兜底。
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 账户：玩家与 NPC 共用（NPC 的现金/持仓必须落盘，否则流通盘对不上）
CREATE TABLE IF NOT EXISTS accounts (
  name          TEXT PRIMARY KEY,
  is_npc        INTEGER NOT NULL DEFAULT 0,
  role          TEXT NOT NULL,
  cash          REAL NOT NULL,
  order_frozen  REAL NOT NULL DEFAULT 0,
  short_margin  REAL NOT NULL DEFAULT 0,
  realized_pnl  REAL NOT NULL DEFAULT 0,
  initial_long  INTEGER NOT NULL DEFAULT 0,
  last_order_at INTEGER,
  created_at    INTEGER NOT NULL,
  -- 终身累计加钱额（旧档缺列时由 openDatabase 迁移补上）
  deposited     REAL NOT NULL DEFAULT 0,
  -- 融券池挂借量 + 出借累计利息（旧档缺列时迁移补上）
  lend_offered          INTEGER NOT NULL DEFAULT 0,
  lend_interest_earned  REAL NOT NULL DEFAULT 0,
  lend_interest_debt    REAL NOT NULL DEFAULT 0
);

-- 持仓批次：FIFO 顺序靠 seq，T+锁仓靠 ts（空头批次没有 ts，也无锁仓概念）
-- margin = 空头保证金；debt = 多头融资负债（旧档缺列时由 openDatabase 迁移补上）
CREATE TABLE IF NOT EXISTS lots (
  account  TEXT NOT NULL,
  stock_id TEXT NOT NULL,
  side     TEXT NOT NULL,
  seq      INTEGER NOT NULL,
  qty      INTEGER NOT NULL,
  price    REAL NOT NULL,
  ts       INTEGER,
  reserved INTEGER NOT NULL DEFAULT 0,
  margin   REAL NOT NULL DEFAULT 0,
  debt     REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (account, stock_id, side, seq)
);

-- 委托：live 的是活动委托（重启后回填订单簿），其余是已完结的委托历史
CREATE TABLE IF NOT EXISTS orders (
  id       TEXT PRIMARY KEY,
  account  TEXT NOT NULL,
  stock_id TEXT NOT NULL,
  seq      INTEGER NOT NULL,
  action   TEXT NOT NULL,
  side     TEXT NOT NULL,
  price    REAL NOT NULL,
  qty      INTEGER NOT NULL,
  filled   INTEGER NOT NULL DEFAULT 0,
  frozen   REAL NOT NULL DEFAULT 0,
  ts       INTEGER NOT NULL,
  status   TEXT NOT NULL DEFAULT 'live'
);
CREATE INDEX IF NOT EXISTS idx_orders_account ON orders(account, seq);

-- 成交流水：一笔成交记两行（主动方 / 被动方），是玩家成交记录的来源
CREATE TABLE IF NOT EXISTS trades (
  id        INTEGER PRIMARY KEY,
  account   TEXT NOT NULL,
  role      TEXT NOT NULL,
  order_id  TEXT NOT NULL,
  stock_id  TEXT NOT NULL,
  action    TEXT NOT NULL,
  side      TEXT NOT NULL,
  price     REAL NOT NULL,
  qty       INTEGER NOT NULL,
  fee       REAL NOT NULL DEFAULT 0,
  trade_seq INTEGER NOT NULL,
  t         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_account ON trades(account, id);
CREATE INDEX IF NOT EXISTS idx_trades_tape ON trades(role, trade_seq);

-- 会话令牌（重启后玩家不用重新登录）
CREATE TABLE IF NOT EXISTS sessions (
  token   TEXT PRIMARY KEY,
  account TEXT NOT NULL
);

-- 行情断点：重启后接着上一局走，而不是从开盘价重新开始
CREATE TABLE IF NOT EXISTS market_state (
  stock_id       TEXT PRIMARY KEY,
  last_price     REAL NOT NULL,
  prev_close     REAL NOT NULL,
  open           REAL NOT NULL,
  high           REAL NOT NULL,
  low            REAL NOT NULL,
  volume         INTEGER NOT NULL,
  turnover       REAL NOT NULL,
  short_interest INTEGER NOT NULL,
  order_seq      INTEGER NOT NULL,
  trade_seq      INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- 分时序列（客户端分时图的历史）
CREATE TABLE IF NOT EXISTS prices (
  t     INTEGER PRIMARY KEY,
  price REAL NOT NULL,
  vol   INTEGER NOT NULL
);

-- 玩家自动化交易策略（动作日志只存内存，不落盘）
CREATE TABLE IF NOT EXISTS auto_strategies (
  id         TEXT PRIMARY KEY,
  account    TEXT NOT NULL,
  type       TEXT NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  done       INTEGER NOT NULL DEFAULT 0,
  params     TEXT NOT NULL,
  state      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auto_account ON auto_strategies(account);
`;

/** 打开（必要时创建）数据库并保证表结构就绪 */
function openDatabase(file) {
  const dir = path.dirname(path.resolve(file));
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(DDL);

  // 老存档缺列：SQLite 的 ALTER 不支持 IF NOT EXISTS，先查表结构再补。
  // 补列是纯增量迁移，schema_version 不动，旧局可以直接续跑
  const accCols = db.pragma('table_info(accounts)').map((c) => c.name);
  if (!accCols.includes('deposited')) {
    db.exec('ALTER TABLE accounts ADD COLUMN deposited REAL NOT NULL DEFAULT 0');
  }
  if (!accCols.includes('lend_offered')) {
    db.exec('ALTER TABLE accounts ADD COLUMN lend_offered INTEGER NOT NULL DEFAULT 0');
    db.exec('ALTER TABLE accounts ADD COLUMN lend_interest_earned REAL NOT NULL DEFAULT 0');
    db.exec('ALTER TABLE accounts ADD COLUMN lend_interest_debt REAL NOT NULL DEFAULT 0');
  }
  const lotCols = db.pragma('table_info(lots)').map((c) => c.name);
  if (!lotCols.includes('debt')) {
    db.exec('ALTER TABLE lots ADD COLUMN debt REAL NOT NULL DEFAULT 0');
  }

  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  if (!row) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  } else if (Number(row.value) !== SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `存档表结构版本为 ${row.value}，当前代码期望 ${SCHEMA_VERSION}：` +
        `旧存档无法直接读取。确认不需要旧数据后，删除存档文件重开新局。`
    );
  }
  return db;
}

module.exports = { openDatabase, SCHEMA_VERSION };
