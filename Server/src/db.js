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
const { logger } = require('./logger');

// 5：彩蛋里程碑（accounts 加 milestones 列，仅玩家写）
// 4：券商（accounts 加券商/转户/星级进度列，trades 加席位列）
// 3：日线（daily_bars 表）+ 资金流向（market_state 的内外盘列）
// 2：多股票（prices 主键加 stock_id、融券改按股票记账、自动策略绑定股票）
const SCHEMA_VERSION = 5;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 账户：玩家与 NPC 共用（NPC 的现金/持仓必须落盘，否则流通盘对不上）
-- 多股票后这里是**账户级**口径：现金、冻结、空头保证金合计、已实现盈亏都是跨股票汇总的
-- 一个数（玩家只有一份钱）；按股票拆分的融券/融资计息见 stock_ledger
--
-- 券商几列只对**玩家**有意义。NPC 的券商是由账户名哈希派生的派生标签（§11.4.1），
-- 不落盘——落盘会踩「NPC 逐 tick 标脏」这条禁忌，也让存档版本无谓抬升。
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
  deposited     REAL NOT NULL DEFAULT 0,
  -- 券商（出身门派）：登录时必选，转户可改。NULL = 老档还没选过，下次登录时补选
  broker             TEXT,
  broker_changed_at  INTEGER,
  -- 当前券商的入会**交易日号**：免费重选窗口与转户冷却都按交易日算（不是墙钟）
  broker_since_day   INTEGER,
  -- 每家券商各一份进度 {key:{volume,profitBase,liquidations,orders,cancels}}（JSON）。
  -- 转户后目标券商天然从零开始，这就是「清空该券商特权进度」的落点
  broker_stats       TEXT,
  -- 免费重选（仅限开户后首个交易日内可用 1 次）
  free_reselect_used INTEGER NOT NULL DEFAULT 0,
  -- 每日免息券：今天这张用掉没有 / 今天是否利息全免（都按交易日号）
  coupon_used_day    INTEGER,
  free_interest_day  INTEGER,
  -- 彩蛋里程碑（JSON）：{seq, fired[], titles[], peakEquity, maxDrawdown, drawdownArmed, dayEvaluated}
  -- 与券商那几列同规矩：**只对玩家写入**，NPC 一律 NULL（逐 tick 标脏是项目禁忌）
  milestones         TEXT
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

-- 成交流水：一笔成交记两行（主动方 / 被动方），是玩家成交记录与逐笔磁带的来源
-- broker / counter_broker 是**席位**口径（§11.3）：本行账户的券商 + 对手方券商。
-- 两行都记，磁带恢复时取 role='taker' 那一行即可还原「买方席位 / 卖方席位」
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
  t         INTEGER NOT NULL,
  broker        TEXT,
  counter_broker TEXT
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
 * 版本 3 → 4 的**原地升级**：券商相关的新列。
 *
 * 与前几轮不同，这次可以用 ALTER 补出来——全是「可空」或「带默认值」的新列，
 * 没有主键/表结构变更（版本 2→3 换过 prices 的主键、版本 3 加的是 NOT NULL 列且
 * 无法从旧数据推出，所以那两次只能开新局）。老档能原地升级意味着**正在跑的这一局
 * 不会因为引入券商而被强制清掉**；`broker` 留 NULL 表示"还没选券商"，
 * 该玩家下次登录时补选（§9 D2 登录必须选券商）。
 *
 * 升级前的成交流水没有席位列（NULL），那段磁带的席位显示为空——已知且可接受。
 */
const MIGRATION_4 = `
ALTER TABLE accounts ADD COLUMN broker TEXT;
ALTER TABLE accounts ADD COLUMN broker_changed_at INTEGER;
ALTER TABLE accounts ADD COLUMN broker_since_day INTEGER;
ALTER TABLE accounts ADD COLUMN broker_stats TEXT;
ALTER TABLE accounts ADD COLUMN free_reselect_used INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN coupon_used_day INTEGER;
ALTER TABLE accounts ADD COLUMN free_interest_day INTEGER;
ALTER TABLE trades ADD COLUMN broker TEXT;
ALTER TABLE trades ADD COLUMN counter_broker TEXT;
`;

/**
 * 版本 4 → 5 的**原地升级**：彩蛋里程碑一个 JSON 列。
 * 同样是可空新列，正在跑的那一局能原地升上来。老玩家的 `milestones` 为 NULL，
 * 由 `Game.applySnapshot` 在行情恢复之后把 `peakEquity` 初始化成**当时的权益**
 * （初始化成 0 会让老玩家一进来就"回撤 100%"）。
 */
const MIGRATION_5 = `
ALTER TABLE accounts ADD COLUMN milestones TEXT;
`;

// 版本 n → n+1 的原地升级语句。没有对应语句说明那次改动 ALTER 补不出来（换过主键 /
// 加过非空列），只能删档开新局——见 openDatabase 里的拒绝启动分支
const MIGRATIONS = { 4: MIGRATION_4, 5: MIGRATION_5 };

// 能原地升级到当前版本的最老版本；更老的档直接拒启（prices 换过主键、融券搬过表）
const MIN_MIGRATABLE = 3;

/**
 * 打开（必要时创建）数据库并保证表结构就绪。
 *
 * 版本 2 及更早**直接拒绝启动**（那几次改的是主键与非空列，ALTER 补不出来，
 * 报错里给出删档指引）；版本 3 / 4 逐级走 MIGRATIONS 原地升级到当前版本。
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
    return db;
  }
  const from0 = Number(row.value);
  if (from0 === SCHEMA_VERSION) return db;
  if (!Number.isFinite(from0) || from0 < MIN_MIGRATABLE || !MIGRATIONS[from0 + 1]) {
    db.close();
    throw new Error(
      `存档表结构版本为 ${row.value}，当前代码期望 ${SCHEMA_VERSION}：` +
        `旧存档无法直接读取。确认不需要旧数据后，删除存档文件重开新局。`
    );
  }
  let from = from0;
  while (from < SCHEMA_VERSION) {
    db.exec(MIGRATIONS[from + 1]);
    from += 1;
  }
  db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION));
  logger.info(`[我是股神] 存档表结构已从版本 ${from0} 原地升级到 ${SCHEMA_VERSION}（数据保留）`);
  return db;
}

module.exports = { openDatabase, SCHEMA_VERSION };
