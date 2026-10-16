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

// 3：日线（daily_bars 表）+ 资金流向（market_state 的内外盘列）
// 2：多股票（prices 主键加 stock_id、融券改按股票记账、自动策略绑定股票）
const SCHEMA_VERSION = 3;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 账户：玩家与 NPC 共用（NPC 的现金/持仓必须落盘，否则流通盘对不上）
-- 多股票后这里是**账户级**口径：现金、冻结、空头保证金合计、已实现盈亏都是跨股票汇总的
-- 一个数（玩家只有一份钱）；按股票拆分的融券/融资计息见 stock_ledger
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
  -- 终身累计加钱额
  deposited     REAL NOT NULL DEFAULT 0
);

-- 按股票的账户明细：融券挂借与各类利息累计（都已经是「按股票」的口径）
-- 融券池是每只股票一套，所以挂借量/欠息必须按股票记账，否则 A 股的欠息会被拿去补 B 股的出借人。
-- 融资计息按股票记是为了前端能按当前股票显示「融资已计息」。
CREATE TABLE IF NOT EXISTS stock_ledger (
  account                   TEXT NOT NULL,
  stock_id                  TEXT NOT NULL,
  lend_offered              INTEGER NOT NULL DEFAULT 0,
  lend_interest_earned      REAL NOT NULL DEFAULT 0,
  lend_interest_debt        REAL NOT NULL DEFAULT 0,
  lend_interest_paid        REAL NOT NULL DEFAULT 0,
  finance_interest_accrued  REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (account, stock_id)
);

-- 持仓批次：FIFO 顺序靠 seq，T+锁仓靠 ts（空头批次没有 ts，也无锁仓概念）
-- margin = 空头保证金；debt = 多头融资负债（本金 + 已摊利息）
-- principal = 该批次借入本金（含开仓手续费），开仓时一次性写入、只随平仓按比例减少；
--   debt − principal 就是这批还没还的已计利息。旧档缺列时由 openDatabase 迁移补上（按账户已计利息占比回填）
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
  principal REAL NOT NULL DEFAULT 0,
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
-- 成交流水的保留裁剪按时间走（WHERE t < ?），需要 t 上的索引，否则每轮裁剪都全表扫
CREATE INDEX IF NOT EXISTS idx_trades_t ON trades(t);

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
  -- 当日资金流向（外盘=主动买 / 内盘=主动卖，见 flow.js）。必须落盘：
  -- 不恢复的话重启后「外盘 + 内盘」会小于当日成交量，盘口资金与成交对不上账
  outer_vol      INTEGER NOT NULL DEFAULT 0,
  outer_amt      REAL NOT NULL DEFAULT 0,
  inner_vol      INTEGER NOT NULL DEFAULT 0,
  inner_amt      REAL NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL
);

-- 日线（K 线）：每个交易日收盘结算时定格一根，个股与大盘指数各一套序列（stock_id 区分）。
-- 一行即为图上的一根蜡烛，量额与内外盘都是当日合计（指数是成分股合计）。
CREATE TABLE IF NOT EXISTS daily_bars (
  stock_id   TEXT NOT NULL,
  day        INTEGER NOT NULL,
  open       REAL NOT NULL,
  high       REAL NOT NULL,
  low        REAL NOT NULL,
  close      REAL NOT NULL,
  volume     INTEGER NOT NULL,
  turnover   REAL NOT NULL,
  outer_vol  INTEGER NOT NULL DEFAULT 0,
  outer_amt  REAL NOT NULL DEFAULT 0,
  inner_vol  INTEGER NOT NULL DEFAULT 0,
  inner_amt  REAL NOT NULL DEFAULT 0,
  settled_at INTEGER NOT NULL,
  PRIMARY KEY (stock_id, day)
);

-- 分时序列（客户端分时图的历史）。多股票后每只股票一条独立序列，
-- 主键 (stock_id, t)；大盘指数也按同一结构落盘（stock_id = 指数代码）。
CREATE TABLE IF NOT EXISTS prices (
  stock_id TEXT NOT NULL,
  t        INTEGER NOT NULL,
  price    REAL NOT NULL,
  vol      INTEGER NOT NULL,
  PRIMARY KEY (stock_id, t)
);

-- 玩家自动化交易策略（动作日志只存内存，不落盘）
-- stock_id：策略绑定在哪只股票上（网格/均线/止盈止损都只对它生效）
CREATE TABLE IF NOT EXISTS auto_strategies (
  id         TEXT PRIMARY KEY,
  account    TEXT NOT NULL,
  stock_id   TEXT NOT NULL,
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

/**
 * 打开（必要时创建）数据库并保证表结构就绪。
 *
 * 版本 2 起不再做增量列迁移：多股票把 prices 的主键、融券记账的表都换了，
 * 版本 3 又在 market_state 上加了资金流向列，这类改动无法用 ALTER 补出来，
 * 旧档只能开新局（版本不匹配时直接拒绝启动，报错里给出删档指引）。
 */
function openDatabase(file) {
  const dir = path.dirname(path.resolve(file));
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(DDL);

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
