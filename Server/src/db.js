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

// 11：头像（accounts 加 avatar / broker_seen 两列，见 Doc/头像方案.md）
// 10：夜间休市行情头按「刚收盘这一天」的定格值下发（market_state 加 closed_day）
// 9：NPC 真实身份（accounts 加 home_stock；stock_ledger 加 origin_qty）
//    **故意不提供 8 → 9 的迁移**：这一版把 NPC 的名字从「大米·游资1」换成真人名，
//    并让账户可以跨股票交易，老档里的名字既是主键又是流水引用，迁不动也没必要迁
//    （测试期，删档重开即可）。老档启动会被下面 openDatabase 明确拒绝并提示删档。
// 8：做空利息按持仓时长累计（stock_ledger 加 lend_interest_accrued 列，可空默认 0）
// 7：开放平台 API Key（api_keys 表；只加表，没有改既有列）
// 6：账号与昵称分家（accounts 加 nick 列，name 从此只作登录账号）
// 5：彩蛋里程碑（accounts 加 milestones 列，仅玩家写）
// 4：券商（accounts 加券商/转户/星级进度列，trades 加席位列）
// 3：日线（daily_bars 表）+ 资金流向（market_state 的内外盘列）
// 2：多股票（prices 主键加 stock_id、融券改按股票记账、自动策略绑定股票）
const SCHEMA_VERSION = 11;

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
  -- 账号：登录凭据，玩家自填、全程不可改，也是各表 account 列引用的那个键。
  -- 昵称（nick）只是展示名，与账号分开——账号要 ASCII 且唯一，昵称可中文、可重名、可改
  name          TEXT PRIMARY KEY,
  is_npc        INTEGER NOT NULL DEFAULT 0,
  role          TEXT NOT NULL,
  -- 昵称：玩家开户时填、之后随时可改。NULL = 还没开过户（老档升级上来 / 建号未完成）
  -- NPC 也用它：存真实展示名（曹俊（杭州） / 望元私募 / 宁波桑田路·孙叔），见 identity.js
  nick          TEXT,
  -- NPC 的"常住"股票：只表示初始建仓在哪只，**不限制它买什么**（跨股交易靠它恢复归属，
  -- 名字里不再带股票前缀，也就不能再靠前缀反解）。玩家为 NULL
  home_stock    TEXT,
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
  milestones         TEXT,
  -- 头像：玩家自选的脸（目录里的 key，见 config.avatar.catalog）。
  -- NULL = 从没主动选过 → 按 hash('ava:' + 账号) 确定性派生一张（永不裂图，也不用写库）。
  -- 不存 URL / 路径 / base64：拼图是客户端的事（Doc/头像方案.md §6.3）
  avatar             TEXT,
  -- 待过的券商 key（逗号分隔，去重、只增不减）：券商组头像的解锁依据。
  -- 转户不收回旧门派脸，这列就是「曾用门派」的唯一凭据。NPC 一律 NULL
  broker_seen        TEXT
);

-- 按股票的账户明细：融券挂借与各类利息累计（都已经是「按股票」的口径）
-- 融券池是每只股票一套，所以挂借量/欠息必须按股票记账，否则 A 股的欠息会被拿去补 B 股的出借人。
-- 融资计息按股票记是为了前端能按当前股票显示「融资已计息」。
CREATE TABLE IF NOT EXISTS stock_ledger (
  account                   TEXT NOT NULL,
  stock_id                  TEXT NOT NULL,
  -- 开服建仓时这个账户在这只股票上的初始持股。
  -- 为什么不用 accounts.initial_long：那个是**账户级单值**，跨股之后一个账户在 10 只票上
  -- 各有各的初始持仓，单值表达不了；十大股东的「变动」列原来读它，跨股后会全算错。
  -- 玩家恒为 0（玩家没有初始建仓，变动基准就是 0）
  origin_qty                INTEGER NOT NULL DEFAULT 0,
  lend_offered              INTEGER NOT NULL DEFAULT 0,
  lend_interest_earned      REAL NOT NULL DEFAULT 0,
  lend_interest_debt        REAL NOT NULL DEFAULT 0,
  lend_interest_paid        REAL NOT NULL DEFAULT 0,
  lend_interest_accrued     REAL NOT NULL DEFAULT 0,
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
  -- 「刚收盘这一天」的展示定格值（JSON：昨收/今开/高低/量额/涨跌幅/资金流向，见
  -- Market.settleDay）。夜间休市期间快照按它下发，昨收滚动成今日收盘价之后
  -- 涨跌幅不至于整屏变 0%。可空：NULL = 尚未结算过 / 老档升级上来
  closed_day     TEXT,
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

-- 开放平台 API Key（/open/v1 的唯一凭据）。
--
-- 为什么不能复用 sessions：H5 的登录是**免密**的（只认账号名），令牌等于"知道账号就能拿"。
-- 开放接口必须有一份**独立于账号名**的秘密，且能单独撤销、单独限额。
--
-- 表里**只存 secret 的 sha256**：明文只在签发那一刻返回一次，之后任何地方都读不回来
-- （包括运维自己）。id 是 8 位公开标识，日志与撤销都按它走，日志里绝不出现 secret。
-- scopes 用逗号分隔（read / trade）；ip_allow 为 NULL = 不限来源（默认，局域网自用）。
CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  account      TEXT NOT NULL,
  secret_hash  TEXT NOT NULL,
  label        TEXT,
  scopes       TEXT NOT NULL DEFAULT 'read,trade',
  ip_allow     TEXT,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_keys_account ON api_keys(account);
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

/**
 * 版本 5 → 6 的**原地升级**：昵称列。
 *
 * 账号（`name`）与昵称从这一版起分家：`name` 退化成纯登录凭据（ASCII、唯一、不可改），
 * 界面上给人看的是 `nick`（可中文、可重名、可改）。老档原地升上来 `nick` 为 NULL，
 * 表示"这个号还没走完开户"——该玩家下次登录时会被要求补填昵称并选券商（§3.2）。
 */
const MIGRATION_6 = `
ALTER TABLE accounts ADD COLUMN nick TEXT;
`;

/**
 * 版本 6 → 7 的**原地升级**：开放平台的 API Key 表。
 *
 * 纯新增表，没动任何既有列，所以老档原地升上来即可（DDL 里也有一份同样的
 * `CREATE TABLE IF NOT EXISTS`，新建库直接就有；这里保留一份是为了让「版本 6 的老档」
 * 走迁移时也把表和索引补齐，两条路径的结果严格一致）。
 */
const MIGRATION_7 = `
CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  account      TEXT NOT NULL,
  secret_hash  TEXT NOT NULL,
  label        TEXT,
  scopes       TEXT NOT NULL DEFAULT 'read,trade',
  ip_allow     TEXT,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_keys_account ON api_keys(account);
`;

/**
 * 版本 7 → 8 的**原地升级**：做空利息的「当日已累计、还没到收盘结算」那一档。
 *
 * 做空利息改成逐 tick 按持仓时长累计、收盘一次性实扣之后，重启会把当天已攒下的
 * 那部分抹掉（收盘只扣重启之后累计的，等于给空头打折）。这一列把它落盘。
 * 可空默认 0，老档原地升上来即可（缺列即"没有待结算的息"）。
 */
const MIGRATION_8 = `
ALTER TABLE stock_ledger ADD COLUMN lend_interest_accrued REAL NOT NULL DEFAULT 0;
`;

/**
 * 版本 9 → 10 的**原地升级**：market_state 加一列「刚收盘这一天的展示定格值」JSON。
 *
 * 只加一个可空列，老档（版本 9）原地升上来即可：NULL 表示「尚未结算过」，
 * 下一次日终结算就会写上。用途见 Market.settleDay / snapshot——夜间休市期间
 * 行情头部的涨跌幅按这份数据下发，不再整屏显示 0%。
 */
const MIGRATION_10 = `
ALTER TABLE market_state ADD COLUMN closed_day TEXT;
`;

/**
 * 版本 10 → 11 的**原地升级**：头像两列。
 *
 * 两条都是纯 `ADD COLUMN`（可空、无默认值），与 v4/v5/v6 那批同款——
 * **在跑的那一局能原地升上来**，不用删档。
 * - `avatar` 为 NULL 表示「从没主动选过」：按账号哈希派生一张基础脸，不写库；
 * - `broker_seen` 为 NULL 表示「还没记录过门派」：老档当前券商由 `avatar.brokerSeenOf`
 *   兜底并进（否则升级当天门派组头像会整组锁死）。
 */
const MIGRATION_11 = `
ALTER TABLE accounts ADD COLUMN avatar TEXT;
ALTER TABLE accounts ADD COLUMN broker_seen TEXT;
`;

// 版本 n → n+1 的原地升级语句。没有对应语句说明那次改动 ALTER 补不出来（换过主键 /
// 加过非空列），只能删档开新局——见 openDatabase 里的拒绝启动分支。
// **9 故意缺席**：NPC 改真名 + 允许跨股，老档的账户名既是主键又是流水引用，迁不动
const MIGRATIONS = { 4: MIGRATION_4, 5: MIGRATION_5, 6: MIGRATION_6, 7: MIGRATION_7, 8: MIGRATION_8, 10: MIGRATION_10, 11: MIGRATION_11 };

// 能原地升级到当前版本的最老版本；更老的档直接拒启（prices 换过主键、融券搬过表）
const MIN_MIGRATABLE = 3;

/** 拒启时的统一提示：把**具体要删的文件**写出来，别让人去猜是哪个档 */
function rebuildHint(file, from, to) {
  const abs = path.resolve(file);
  return (
    `存档表结构版本为 ${from}，当前代码期望 ${to}，这一版无法原地升级。\n` +
    `确认不需要旧数据后，删掉这三个文件重开新局：\n` +
    `  ${abs}\n  ${abs}-wal\n  ${abs}-shm`
  );
}

/**
 * 逐条执行迁移语句，并把 `ADD COLUMN` 做成幂等。
 *
 * 为什么需要：`openDatabase` 是**先** `db.exec(DDL)`（按最新结构建缺表）**再**逐级迁移。
 * 于是"老档缺这张表"时，DDL 已经按最新结构把表建出来了，迁移里的
 * `ALTER TABLE ... ADD COLUMN` 就会撞 `duplicate column name`（v9 档只有 meta 的合成档
 * 就走这条路）。SQLite 的 ADD COLUMN 没有 IF NOT EXISTS，所以在这里按 PRAGMA 挡一道。
 */
function execMigration(db, sql) {
  for (const raw of String(sql).split(';')) {
    const stmt = raw.trim();
    if (!stmt) continue;
    const m = /^ALTER\s+TABLE\s+([A-Za-z_]\w*)\s+ADD\s+COLUMN\s+([A-Za-z_]\w*)/i.exec(stmt);
    if (m) {
      const cols = db.prepare(`PRAGMA table_info(${m[1]})`).all().map((c) => c.name);
      if (cols.includes(m[2])) continue; // DDL 已经把这一列建出来了
    }
    db.exec(stmt);
  }
}

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
  // WAL checkpoint 阈值 4MB→64MB：存档已挪到机械盘（D:/GushenData），默认 4MB 一轮的
  // 被动 checkpoint 几乎每 tick 触发一次（写速率 ~3MB/s），HDD 随机回写慢会拖长 tick；
  // 调大后 checkpoint 低频且更顺序。代价仅是崩溃恢复时要多重放一段 WAL，可接受。
  db.pragma('wal_autocheckpoint = 16000');
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
    throw new Error(rebuildHint(file, row.value, SCHEMA_VERSION));
  }
  let from = from0;
  while (from < SCHEMA_VERSION) {
    const sql = MIGRATIONS[from + 1];
    // 逐级迁到某一版发现没有下一步（当前就是 8 → 9：NPC 改真名那一版）——
    // 停在中间态比直接拒启更糟（库已经是半新半旧），所以在这里关掉连接、要求重建
    if (!sql) {
      db.close();
      throw new Error(rebuildHint(file, from0, SCHEMA_VERSION));
    }
    execMigration(db, sql);
    from += 1;
  }
  db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION));
  logger.info(`[我是股神] 存档表结构已从版本 ${from0} 原地升级到 ${SCHEMA_VERSION}（数据保留）`);
  return db;
}

module.exports = { openDatabase, SCHEMA_VERSION };
