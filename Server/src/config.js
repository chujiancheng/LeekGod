/**
 * 全局配置（均可按需调整）
 */
const fs = require('fs');
const path = require('path');

/**
 * 本机 LLM 密钥/覆盖（不入库）：`Server/data/llm.local.json`（data/ 已在 .gitignore）。
 * 环境变量优先于该文件；该文件只允许覆盖 config.npc.llm 的白名单字段。
 */
function applyLocalLlmFile(llm) {
  const p =
    process.env.NPC_LLM_CONFIG || path.join(__dirname, '..', 'data', 'llm.local.json');
  try {
    if (!fs.existsSync(p)) return;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!j || typeof j !== 'object') return;
    if (typeof j.enabled === 'boolean') llm.enabled = j.enabled;
    if (typeof j.baseUrl === 'string' && j.baseUrl) llm.baseUrl = j.baseUrl;
    if (typeof j.model === 'string' && j.model) llm.model = j.model;
    if (typeof j.apiKey === 'string' && j.apiKey) llm.apiKey = j.apiKey;
    if (typeof j.apiKeyEnv === 'string' && j.apiKeyEnv) llm.apiKeyEnv = j.apiKeyEnv;
    if (Number.isFinite(j.maxCallsPerDay)) {
      llm.budget = llm.budget || {};
      llm.budget.maxCallsPerDay = j.maxCallsPerDay;
    }
    if (Number.isFinite(j.cashEach)) llm.cashEach = j.cashEach;
  } catch {
    // 配置层不能依赖 logger（会成环）；坏文件静默忽略，走 env / 默认值
  }
}

const config = {
  // 服务端口（server.py 会读取环境变量 PORT 展示，这里保持一致）
  port: parseInt(process.env.PORT || '3000', 10),

  // 日志等级：trace / debug / info / warn / error / fatal（可用环境变量 LOG_LEVEL 覆盖）
  log: {
    level: process.env.LOG_LEVEL || 'info',
  },

  // 持久化（账号 / 持仓 / 活动委托 / 成交流水 / 令牌 / 行情断点）
  persistence: {
    enabled: process.env.PERSIST !== '0',
    // 正式存档在 D 盘机械硬盘（2026-10-20 起，原 data/game.db）：实测 SSD 上常年 ~6MB/s
    // 小页随机写（~530GB/天），挪去机械盘省 SSD 磨损。目录不存在会自动创建（db.js）。
    // 验收/调试仍必须用 PERSIST_FILE 显式指临时库，别碰正式档；想开新一局直接删掉这个文件。
    file: process.env.PERSIST_FILE || 'D:/GushenData/game.db',
    // 兜底全量扫描：每 tick 轮转写入 1/sweepTicks 的账户。
    // 正常路径靠脏标记精确落盘，这里是防御"某条改钱路径漏标脏"的保险，设为 0 关闭
    sweepTicks: 300,
    // 成交流水（trades）保留窗口，每 tick 按时间裁掉更早的行。
    // 这张表只有两处读取：每只股票恢复逐笔（最近 500 条）与玩家成交记录（最近 100 条），
    // 而 NPC 之间每 tick 都在成交（实测 640 行/秒、6 MB/分钟），不裁会按小时级无限膨胀
    tradeKeepMs: Number(process.env.TRADE_KEEP_MS || 10 * 60 * 1000),
  },

  // 行情推进间隔（毫秒）
  tickIntervalMs: 700,

  // 交易日时钟（见 src/daycycle.js）。
  // 引入「天」之后解锁的是整套日频机制：集合竞价、收盘价结算、隔夜跳空、涨跌停、委托当日作废。
  // 时间轴刻意**不按真实时长等比压缩**：真实 A 股盘中 250 分钟压到 10 分钟是 25 倍，
  // 等比压缩下收盘竞价只剩 7 秒、玩家来不及反应。竞价与尾盘是博弈密度最高的两段，
  // 这里给它们超额配时（两段竞价合计 50 秒 = 一天的 8%，真实市场只占 5% 的时间却承担 80% 的博弈）。
  // 一天 620 秒 ≈ 10 分 20 秒；`gameTime`/`gameMs` 把游戏内进度线性映射到真实时刻，
  // 于是客户端顶栏能直接显示 09:15 / 14:57，玩家顺带学会真实规则。
  day: {
    enabled: true,
    phases: [
      // 开盘集合竞价：前 20 秒自由撤单 + 后 10 秒锁死（真实市场 09:20 那条硬线）
      { key: 'auction', label: '开盘集合竞价', gameTime: '09:15', gameMs: 10 * 60000, ms: 30 * 1000, trading: true, auction: 'open', cancelLockMs: 10 * 1000 },
      { key: 'morning', label: '上午连续竞价', gameTime: '09:30', gameMs: 120 * 60000, ms: 230 * 1000, trading: true },
      { key: 'lunch', label: '午间休市', gameTime: '11:30', gameMs: 90 * 60000, ms: 40 * 1000, trading: false },
      { key: 'afternoon', label: '下午连续竞价', gameTime: '13:00', gameMs: 117 * 60000, ms: 260 * 1000, trading: true },
      // 收盘集合竞价：同样后 10 秒锁死，但只有 20 秒，张力最大
      { key: 'closeAuction', label: '收盘集合竞价', gameTime: '14:57', gameMs: 3 * 60000, ms: 20 * 1000, trading: true, auction: 'close', cancelLockMs: 10 * 1000 },
      { key: 'night', label: '休市结算', gameTime: '15:00', gameMs: 1095 * 60000, ms: 40 * 1000, trading: false },
    ],
  },

  // 股票定义。每只股票一套独立的 Market + NpcManager（各自盘口、融券池与做市资金），
  // 大盘指数按其流通市值加权合成。alias 是 2 字简称，用于 NPC 账户名前缀与消息文案。
  // 流通盘 × 开盘价 = 流通市值，决定指数权重；当前权重区间 6.8%~14.7%（最大/最小 ≈ 2.2 倍），
  // 既保留大盘股主导的层次，又不让任何一只绑架指数。
  stocks: [
    {
      id: '600001',
      name: '大米集团',
      alias: '大米',
      // 固定流通盘（股），开服时全部登记在 NPC 名下
      floatShares: 100000000,
      // 本局开盘价 / 昨收参考价
      initPrice: 20.0,
      // 每手股数
      lotSize: 100,
    },
    { id: '600002', name: '腾迅控股', alias: '腾迅', floatShares: 70000000, initPrice: 58.0, lotSize: 100 },
    { id: '600003', name: '阿狸巴巴', alias: '阿狸', floatShares: 40000000, initPrice: 108.0, lotSize: 100 },
    { id: '600004', name: '梅团集团', alias: '梅团', floatShares: 30000000, initPrice: 92.0, lotSize: 100 },
    { id: '600005', name: '京冬集团', alias: '京冬', floatShares: 30000000, initPrice: 126.0, lotSize: 100 },
    { id: '600006', name: '筷手集团', alias: '筷手', floatShares: 50000000, initPrice: 44.0, lotSize: 100 },
    { id: '600007', name: '网艺集团', alias: '网艺', floatShares: 20000000, initPrice: 148.0, lotSize: 100 },
    { id: '600008', name: '中新国际', alias: '中新', floatShares: 120000000, initPrice: 26.0, lotSize: 100 },
    { id: '600009', name: '小朋集团', alias: '小朋', floatShares: 60000000, initPrice: 36.0, lotSize: 100 },
    { id: '600010', name: '理享汽车', alias: '理享', floatShares: 28000000, initPrice: 72.0, lotSize: 100 },
  ],

  // 大盘指数：全部股票的流通市值加权合成，纯展示不可交易。
  // 点位 = base × Σ(流通股 × 现价) / Σ(流通股 × 开盘价)
  // 本局「昨收」恒为 base（一轮即一次连续交易），涨跌幅相对基点。
  index: {
    code: '999999',
    // 展示名：诙谐向，十只股票同涨同跌，全村股民的希望都系在这根线上
    name: '全村希望',
    base: 1000,
  },

  // 账户
  account: {
    initialCash: 1000000, // 初始资金 100 万
    maxAccounts: 5000, // 本局玩家账号上限（防止无限注册耗尽内存）

    // 主页「加钱」：玩家给自己账户加钱，按账户累计封顶（终身只能加满 maxLifetime）。
    // 累计数随账户落盘，重启 / 多标签页都算同一个账户；enabled=false 时接口返回未开放。
    // 单次不限额，可以一次性把剩余额度全部加满。
    // enabled=false：接口返回未开放，主页「加钱」按钮跟着隐藏（暂时屏蔽，改回 true 即恢复）
    deposit: {
      enabled: false,
      maxLifetime: 100000000, // 单账户终身上限（元，默认 1 个亿）
      minPerTime: 1, // 单次加钱下限（元）
      presets: [100000, 1000000, 10000000], // 主页弹窗快捷金额（元）
    },
  },

  // 交易规则
  trade: {
    feeRate: 0.0001, // 手续费 万分之一
    cooldownMs: 2000, // 同一玩家两次下单最小间隔
    lockMs: 10 * 1000, // 买入锁仓时间（T+10秒）
    maxDeviation: 0.5, // 玩家委托价相对最新价的最大偏离（送错价格保护）
    // 价格笼子：单笔成交价相对上一笔成交价的最大偏离。
    // 成交价取被动方挂单价，所以脱离盘口的挂单一旦被吃，就能把最新价一把拉走，
    // 而最新价同时是强平价、权益（排行榜）与 NPC 公允价值的基准。
    // 实测正常撮合的单笔偏离 p99.9=0.3%、最大 0.75%，±5% 不会误伤真实成交；
    // 挂单仍可挂在更远处（maxDeviation 之内），只是不能按脱离笼子的价格成交。
    cagePct: 0.05,
  },

  // HTTP 层防护
  http: {
    // 各接口按 IP 的滑窗限流：limit 次 / windowMs
    rateLimit: {
      enabled: true,
      login: { limit: 10, windowMs: 60000 },
      order: { limit: 60, windowMs: 60000 },
      deposit: { limit: 10, windowMs: 60000 },
      state: { limit: 240, windowMs: 60000 },
      write: { limit: 30, windowMs: 60000 }, // 改昵称这类轻量写操作（开户/登录有自己的 login 档）
      // 股东榜按需拉取（前台 5 秒轮询 ≈ 15/分）+ 走势弹窗 + 玩家持仓弹窗共用一档。
      // 按 IP 计：局域网多名玩家共用一个桶，60/分会被正常浏览打满（客户端触发过 429 自锁，见 2026-10-20），
      // 放宽到 180/分给多玩家留余量；客户端另有失败退避，不会靠重试糊满桶
      holders: { limit: 180, windowMs: 60000 },
      daily: { limit: 60, windowMs: 60000 }, // 日线（切到日线模式 / 换股票时按需拉取）
      admin: { limit: 10, windowMs: 60000 },
    },
    // SSE 长连接上限 + 写背压门槛（见 src/sseback.js 顶部的实测数据与判定策略）
    //
    // 2026-10-22 事故：一条「连上了但读不动」的连接（App 熄屏 / 笔记本休眠 / 弱网）
    // 会把每个 tick 的整帧堆进 res 写队列且永不释放，实测单条 1.6GB/小时，
    // 正式服两次 OOM（4GB 与 2.5GB 两档都撞过）都是它。这里给每条连接加闸门：
    //   写队列 ≥ slowSkipBytes → 跳过本 tick 的帧（每帧都是全量快照，丢中间帧无损）
    //   写队列 ≥ slowDropBytes → 拆连接（客户端 retry: 2000 重连，重连即拿全量首帧）
    //   连续被跳过 slowKickMs → 同样拆掉，别白占 maxConnections 配额
    sse: {
      maxConnections: 500,
      maxPerIp: 20,
      slowSkipBytes: 512 * 1024, // 约 5~6 帧；正常玩家偶发抖动不该被误杀
      slowDropBytes: 8 * 1024 * 1024, // 单连接 8MB 封顶，500 连接最坏 4GB → 实际远低于此
      slowKickMs: 60000, // 连续 1 分钟一帧都塞不进去，基本可以确定是僵尸连接
    },
    // gzip 压缩（见 src/gzip.js）：REST 大响应与 SSE 行情流都吃它。
    // JSON 满屏重复字段名，实测 81KB 的 state 帧压到 ~9KB、52KB 的行情帧压到 ~7KB；
    // 量化客户端轮询/SSE 是带宽大头，关掉它 10Mbps 会原样回来。
    // 客户端不带 Accept-Encoding: gzip（curl 裸调、urllib.request）就自动不压缩，零破坏。
    gzip: {
      enabled: true,
    },
  },

  // 开放交易接口（/open/v1）：玩家自带量化模型，在自己机器上跑策略，调这里读写。
  //
  // 与 H5 走的 /api/* 是**两套鉴权**：/api 认免密登录签发的会话令牌，/open 认 API Key
  // （随机 secret、哈希存库、可撤销）。免密登录只适合"自己点着玩"，任何能连到端口的人
  // 只要知道账号名就能拿到会话令牌，绝不能拿它当程序化接口的凭据。
  //
  // 规则完全一致：open 接口的下单最终都走 game.placeOrderFor → market.place，
  // 冷却、锁仓、费率、保证金、同股多空互斥、涨跌停一条都不放宽。差异化只在
  // 「请求配额」——程序化轮询天然比手点频繁，配额给得比 H5 宽，但下单冷却不变。
  open: {
    enabled: true,
    rateLimit: {
      enabled: true,
      // 按 Key 计（不按 IP）：同一台机器可能同时跑好几个策略
      read: { limit: 240, windowMs: 60000 }, // 行情/账户/委托/成交查询
      trade: { limit: 60, windowMs: 60000 }, // 下单/撤单（与 H5 的 order 档同量级）
      // 按 IP 的兜底：防止一个脚本疯狂新建 Key 或刷不存在的 Key 把 CPU 打满
      ip: { limit: 1200, windowMs: 60000 },
    },
    // 下单幂等：同一个 clientOrderId 在窗口内重复提交只成交一次
    idempotency: { ttlMs: 10 * 60 * 1000, max: 2000 },
    maxKeysPerAccount: 8, // 单账户最多同时有效的 Key
    maxStreamsPerKey: 2, // 单个 Key 的 SSE 连接数
    maxStreams: 100, // 全服 SSE 连接数
    maxTrades: 30, // 行情里带的逐笔条数上限（H5 是 30）
    maxDepth: 5, // 五档档位上限
  },

  // 做空保证金
  margin: {
    ratio: 0.5, // 开空冻结 = 卖出市值 * 50%；开空预检同样按此比例卡权益 → 敞口上限 2 倍
    maintenance: 0.3, // 维持保证金率 30%，跌破即爆仓强平
    liquidationSlippage: 0.005, // 强平撮合不到对手盘时的系统兜底滑点
    // allowNakedShort=true：裸空后门（不借券即可开空，无券源上限、不计息）。
    // 默认 false：开空必须从融券池借券，可借不足直接拒单。
    allowNakedShort: false,
    // 融券池：玩家/NPC 把可卖持仓挂借生息，空头借券开仓。
    // **做空利息按游戏日结算**：每个交易日收盘（日终结算）收一次，不再逐 tick 摊息。
    // 利率随池子紧张度上升：s = 已借出 / 总挂借，日息 = base × (1 + s × stressK)，封顶 maxDailyRate。
    // 日息 0.1% ≈ 真实融券年化 36%，一天一收玩家扛得住、也看得见（持仓利息那一行就是一天的量）。
    // 空头现金与保证金都扣不动时利息挂账（lendInterestDebt）：计入权益，现金恢复后追缴给出借方。
    lending: {
      enabled: true,
      npcLendRatio: 0.3, // NPC 开服/加载时自动出借的持仓比例
      baseDailyRate: 0.001, // 基础 0.1%/日（池子空闲时）
      stressK: 3, // 满借时利率上浮到 base × 4（0.4%/日）
      maxDailyRate: 0.004, // 封顶 0.4%/日
    },
    // 融资买入（做多杠杆）：与做空的保证金体系镜像。
    // ratio = 开多自备资金比例（0.5 → 最高 2 倍），其余成交市值记为批次负债 debt；
    // 开仓手续费也并入该负债一起融资，冻结只按自备比例——否则"2 倍"会因最后几十元手续费买不进整 2 倍。
    // 利息按 tick 复利摊入批次负债并同步计入已实现盈亏，资金成本流向系统（无人分配）。
    // 压力利率：s = 全市场融资负债 / (负债 + 可动用现金)，现金越紧借钱越贵。
    // 维持担保沿用 margin.maintenance：权益 < 维持率 × 多头市值 时强卖多头还债。
    finance: {
      enabled: true,
      ratio: 0.5, // 开多自备比例（含手续费外的成交市值部分），1/杠杆倍数
      baseMinuteRate: 0.0001, // 基础 0.01%/分钟（≈14.4%/日，与融券同档）
      stressK: 3, // 现金耗尽时利率上浮到 base × 4
      maxMinuteRate: 0.0004, // 封顶 0.04%/分钟
      // NPC 买入容量 = 全款容量 × 该系数：只有超出全款容量的部分才走融资单。
      // 1.2 ≈ 最多约 17% 名义是借入的——现金吃紧时才温和加杠杆，
      // 防止 NPC 在 2 倍口径下无节制融资、被利息持续烧掉权益
      npcFinCapMult: 1.2,
    },
  },

  // 停牌：手动运营开关，入口是 server.py halt / resume
  halt: {
    defaultMinutes: 5, // 不指定时长时的默认停牌分钟数
    maxMinutes: 120, // 单次停牌时长上限
  },

  // 运维口令：停牌接口的唯一凭据
  admin: {
    // 相对 Server 目录；文件不存在时启动生成。server.py 读同一份
    tokenFile: process.env.ADMIN_TOKEN_FILE || 'data/admin.token',
  },

  // 涨跌停：相对昨收（上一个交易日的收盘集合竞价成交价）±30%。
  // 引入「天」之后才真正可用——`prevClose` 每交易日收盘更新，不再恒等于开盘价。
  // 注意：它同时夹住报价与 NPC 的公允价值（见 npc.updateFairValue），于是价格
  // 一天最多走 ±30%，强趋势段表现为「连续涨停 / 跌停」，封板与炸板成为日内核心博弈点。
  // 幅度 2026-10-18 由 ±10% 调到 ±30%：当前 trend.bands 标定下日收益 p90 ~8%，
  // 板只在连板/极端段咬住（贴板率会明显低于 ±10% 时的 4.7%），见 day-probe 对照。
  priceLimit: {
    enabled: true,
    pct: 0.3,
  },

  // NPC 设定
  // 五类结构贴近活跃个股：少数机构 + 游资 + 长尾散户。
  // holdRatio 合计必须 = 1（初始化时把取整余数补给最后一类）。
  // 类间现金/筹码长尾；类内均分（首版从简，行为差异靠 profile）。
  //
  // 多股票：每股一套独立的 NPC 池（账户名前缀股票简称）。下面的 totalCash / 报单量是
  // 「基准股」口径（流通 1 亿股 @ 20 元 = 20 亿流通市值），每只股票按自己的流通市值与
  // 流通股数等比缩放后实例化——否则同样一笔钱在 43 亿的阿里上是小溪、在 20 亿的大米上是大河，
  // 各股票的盘口深度会差出一倍多。缩放系数见 refMarketCap / refFloatShares。
  npc: {
    // 基准口径：1 亿股 × 20 元
    refMarketCap: 2000000000,
    refFloatShares: 100000000,
    types: {
      inst: {
        label: '机构',
        count: 10,
        holdRatio: 0.32,
        totalCash: 220000000,
        newsScope: '机构',
        // 聪明钱：不跟公开消息追涨杀跌，而是对倒——散户追利好时出货、恐慌时吸筹。
        // 机构专属消息仍小幅同向（知情盘）；定价锚在基本面重心，不跟消息推高的公允。
        publicNewsFade: 0.85, // 公开消息（全体+散户盘）反向强度
        instNewsFollow: 0.35, // 机构专属消息同向跟随
        heatFade: 0.9, // 相对基本面重心的过热/超跌 → 情绪回归
        inventorySkew: 0.55, // 持仓偏离建仓量的软目标倾斜（超配派发、低配收集）
        fundWeight: 0.7, // 定价/价值判断里基本面重心的权重（其余是短端公允）
        quoteLastWeight: 0.25, // 报价贴最新价的权重（低于全局，更看估值）
        valueHitEdge: 0.003, // 价值吃单阈值（比全局 0.5% 更敏感）
        quoteTilt: 0.45, // 挂单量按情绪倾斜（出货/吸筹反映在盘口深度）
        sentimentScale: 0.8,
        canShort: true,
        useCamp: true, // 固定多空阵营，分歧度高时贴身对打
        momentum: false,
        centerShift: 0.004,
        spread: [0.0005, 0.0015],
        requoteQty: [30000, 100000],
        aggressiveQty: [10000, 40000],
        aggressiveRate: 0.16,
        polarOrderScale: true, // 分歧度放大挂单/吃单（多空大战放量）
        openShortSentiment: -0.15,
      },
      hot: {
        label: '游资',
        count: 6,
        holdRatio: 0.08,
        totalCash: 45000000,
        newsScope: '散户',
        sentimentScale: 1.15,
        canShort: true,
        useCamp: false,
        momentum: true,
        momentumGainMul: 1.6,
        centerShift: 0.008,
        spread: [0.0008, 0.002],
        requoteQty: [8000, 30000],
        aggressiveQty: [3000, 15000],
        aggressiveRate: 0.35,
        polarOrderScale: false,
        openShortSentiment: -0.12,
        quoteTilt: 0.35,
        heatFade: 0.25, // 轻度过热回避，避免全池在顶上对倒
      },
      big: {
        label: '大户',
        count: 20,
        holdRatio: 0.18,
        totalCash: 45000000,
        newsScope: '散户',
        sentimentScale: 1.0,
        canShort: false,
        useCamp: false,
        momentum: true,
        momentumGainMul: 1.15,
        centerShift: 0.006,
        spread: [0.001, 0.0025],
        requoteQty: [3000, 12000],
        aggressiveQty: [1000, 5000],
        aggressiveRate: 0.14,
        polarOrderScale: false,
        openShortSentiment: -9,
        quoteTilt: 0.3,
        heatFade: 0.2, // 轻度：跟消息但不无限追顶
      },
      mid: {
        label: '中户',
        count: 60,
        holdRatio: 0.25,
        totalCash: 30000000,
        newsScope: '散户',
        sentimentScale: 1.1,
        canShort: false,
        useCamp: false,
        momentum: true,
        momentumGainMul: 1.2,
        centerShift: 0.006,
        spread: [0.001, 0.003],
        requoteQty: [800, 4000],
        aggressiveQty: [300, 1500],
        aggressiveRate: 0.12,
        polarOrderScale: false,
        openShortSentiment: -9,
        quoteTilt: 0.25,
      },
      small: {
        label: '散户',
        count: 220,
        holdRatio: 0.17,
        totalCash: 15000000,
        newsScope: '散户',
        sentimentScale: 1.2,
        canShort: false,
        useCamp: false,
        momentum: true,
        momentumGainMul: 1.25,
        centerShift: 0.006,
        spread: [0.001, 0.003],
        requoteQty: [100, 800],
        aggressiveQty: [100, 500],
        aggressiveRate: 0.1,
        polarOrderScale: false,
        openShortSentiment: -9,
        quoteTilt: 0.2,
      },
    },
    // 旧档兼容：role=retail 按小散户恢复（新开局不再产生该 role）
    legacyRetailType: 'small',

    // ---------------- 做市商（2026-10-20 P1，见 Doc/NPC真实身份方案.md §3） ----------------
    // 每只股票 6 家券商自营接管盘口。改造前是「316 个投资者各挂一张买单一张卖单」
    // 硬铺五档——现实中散户不会 24 小时双边报价，盘口是自营盘铺的。
    //
    // 钱和货都独立于投资者池：
    // - 现金：与旧池同量（Σ types.totalCash × capScale），6 家均分
    // - 库存：从流通盘划出 initInventoryPct（默认 4%），6 家均分
    //
    // ⚠️ **为什么不用方案原文的「初始库存 0」**：做市商没有货就挂不出卖盘，开盘只剩
    // 单边买盘，价格会被自己的买盘一路顶上去。券商自营本来就有持仓，划 4% 对守恒无损
    // （流通盘总量不变，只是股东多了 60 个自营账户）。配 0 可回到方案原文口径，
    // 但那样必须把卖盘改由"自营卖空"提供——那要动券源/保证金规则，风险更大。
    maker: {
      enabled: true,
      count: 6,
      public: true, // 露脸：盘口/股东榜显示「钟信自营」；false 时展示名退化为「机构专用」
      initInventoryPct: 0.04,
      levels: 3, // 每家每侧挂几档
      // 每档基础量（基准股口径的股数，再乘 qtyScale）。null = 按旧池深度自动反推
      qtyPerLevel: null,
      depthMul: 1, // 盘口总深度相对旧池（316 人各一张）的倍数
      // 存货模型：库存偏离目标时整体平移报价中枢。
      // 库存高于目标 → 中枢下移（急于出货），低于目标 → 上移（急于收货）
      inventorySkew: 0.9,
      inventoryTargetPct: 0.5, // 目标库存 = 初始库存 × 该值
      // 卖盘底仓：这部分库存不再卖出，只留作"永远有货可报"的底。
      // 库存无下限时，玩家单边买光自营的货 → 卖盘整侧消失（实测某只票连空 60 tick
      // ≈ 42 秒，玩家完全买不进）。留底仓后最差也只是"卖盘极薄"，不会整侧归零。
      // 只约束**报价量**，不冻结货：库存低于底仓时仍然报一手，保证盘口在。
      minInventoryPct: 0.35,
      // 库存告急（低于底仓）时中枢额外上移的比例：报价从"急着卖"翻成"急着买"。
      // 做市商缺货的正常反应是抬价收货，而不是继续按原价把最后一点货卖光——
      // inventorySkew 那点幅度（库存 0 时 +0.36%）压不住持续买盘，得单独给一档
      scarceShift: 0.012,
      // 库存告急时买盘放大倍数：抬价之后还得真的把量摆出来才收得到货
      scarceBidMul: 2,
      spread: [0.0004, 0.0012], // 自营点差（比散户窄：做市是专业活）
      centerShift: 0.002,
      quoteLastWeight: 0.3,
      requoteRate: 0.5, // 每 tick 重报价概率（比散户勤：要跟住价格）
      step: 0.0012, // 档位间距（相对中枢）；第 i 档 = center × (1 ± step × i)
      longCapMult: 4, // 自营库存可涨到初始的几倍
      nickSuffix: '自营',
      // 做市商不做主动吃单（只报价 + 被动成交）；薄盘时由 recycleLiquidity 补款
      aggressiveRate: 0,
    },

    // ---------------- 投资者跨股（2026-10-20 P2，见方案 §4） ----------------
    // 3160 个投资者各有"常住"股票（homeStock），但**不限制买什么**。
    // 注意力分层决定每个人每轮看几只票，也决定性能上限（方案 §4.2）。
    cross: {
      enabled: true,
      // 每类投资者每 tick 尝试看外股的概率（真实投资者也不是每秒都在刷行情）
      rate: { inst: 0.1, hot: 0.16, big: 0.07, mid: 0.09, small: 0.12 },
      // 同时关注几只（含本股）：机构看全场，散户只盯两只
      watch: { inst: 10, hot: 3, big: 4, mid: 3, small: 2 },
      // 关注面里留给「已有外股持仓」的名额：不给自己持仓留位，不在榜上的票永远卖不掉
      watchHold: { inst: 4, hot: 1, big: 2, mid: 2, small: 1 },
      // 私人估值 = 当前市价 × (1 ± bias)，bias 由 (账户名, 股票) 确定性生成 → 重启不换人
      valueBias: 0.08,
      // 每日向「持仓成本 + 市场价」的均值靠拢的比例（没持仓则只向市场价靠）
      valueDrift: 0.35,
      // 决策权重：价值 / 动量 / 消息
      wValue: { inst: 1.4, hot: 0.5, big: 1.2, mid: 0.9, small: 0.4 },
      wMom: { inst: 0.3, hot: 1.5, big: 0.5, mid: 0.8, small: 1.3 },
      wNews: { inst: 0.6, hot: 1.2, big: 0.5, mid: 0.8, small: 1.5 },
      // 触发阈值：score 超过才动手（太小会每 tick 都在交易）
      buyEdge: 0.035,
      sellEdge: 0.03,
      // 仓位上限（相对自有权益）
      maxSinglePct: 0.3,
      maxForeignPct: 0.6,
      // 单股外股资金上限（相对该股流通市值）：反羊群，避免 10 只票被同一批钱推成同涨同跌
      maxStockExposurePct: 0.08,
      // 单笔量（占该股流通盘的比例）
      qtyPct: {
        inst: [0.0005, 0.002],
        hot: [0.0002, 0.001],
        big: [0.0002, 0.0008],
        mid: [0.00005, 0.0002],
        small: [0.00001, 0.00005],
      },
      // 外股不挂长期单：只吃对手价。这两个类型可以挂小额限价，但 TTL 很短
      limitOnly: ['big', 'mid'],
      limitTtlTicks: 2,
      // 外股只做多的类型（与 types.canShort 一致；这里显式列出避免误开空）
      shortTypes: ['inst', 'hot'],
      // 每 tick 最多成交几笔外股交易（**全市场**闸门，316 个池共用一份，
      // 防止同一 tick 里所有投资者一起往热门股上砸单把盘口打穿）
      maxTradesPerTick: 12,
      // 耐心：同一账户两次外股操作的最小间隔（tick）
      cooldownTicks: { inst: 6, hot: 2, big: 10, mid: 8, small: 5 },
    },

    // 单账户持股上限 = 初始持仓 × longCapMult。太小会让机构在单边行情里
    // 打满上限后彻底退出盘口（买不了也卖不了），盘面直接死锁
    longCapMult: 3,

    // 多空力量对比（-1 空头占优 … 0 势均力敌 … +1 多头占优）。
    // 由盘面上真正拿得出来打的几样东西合成，不看价格本身：
    // ① 情绪合力（机构一致情绪 + 散户情绪）
    // ② 动量（最近一个窗口的涨跌幅）
    // ③ 弹药（全池可用现金相对流通市值，买不动了就是空头占优）
    // ④ 浮盈亏结构（获利盘是卖压，深套盘是"卖无可卖"的潜在买盘）
    // 空头存量与券源紧张度**不进这个天平**：它们恒为正值，算进去会让天平
    // 结构性偏多、永远出不来"空头占优"。它们是逼空的燃料，只在挤兑条件里用。
    // 平滑成慢波后：喂回情绪（全体同向偏置）、调制机构分歧度（势均力敌更容易打成
    // 放量多空对攻）、并作为三种战术意图的成立前提——多头占优才挤兑得动空头，
    // 空头占优才压得住盘。数字与 regime 同级别敏感，**不下发客户端**。
    force: {
      enabled: true,
      moodWeight: 0.9, // 机构一致情绪（instMood 去掉分歧部分）
      retailWeight: 0.6,
      momWeight: 0.7,
      momScale: 5, // 涨跌幅 → 票值的放大倍数
      cashFullRatio: 0.18, // 全池现金 / 流通市值；初始约等于该值（不偏不倚），
      // 打光了转空、深跌后现金相对市值变厚转多
      cashWeight: 0.6,
      pnlWeight: 0.5, // 获利盘（卖压）与深套盘（卖无可卖）之差
      pnlProfitEdge: 0.15,
      pnlLossEdge: -0.25,
      norm: 2.7, // 权重和，用于归一到 [-1,1]
      smooth: 0.02, // 每 tick 向目标靠拢比例（慢波）
      bias: 0.2, // 倾斜 → 情绪偏置强度（实测 0.35 会把趋势放大过头、买盘被扫穿的时段翻倍）
      dominant: 0.25, // |force| 超过该值才算一边占优，否则算势均力敌
      polarBalance: 0.45, // 势均力敌时打多空大战的基础概率被抬高多少
      polarBase: 0.35, // 一边倒时打多空大战的基础概率（force 关闭时退回旧的 0.5）
    },

    // 战术意图：现有情绪是每 tick 从零重算的反射，这一层补的是**跨 tick 的计划**——
    // 让聪明钱（机构/游资）主动挤兑空头、低位压盘吸筹（先诱空砸盘）、高位抬价派发（先诱多拉抬）。
    // 触发带随机门 + 随机时长 + 随机力度 + 冷却：条件满足只抬高每 tick 的触发概率，
    // 不构成"看到信号就必然发生"的确定性映射（顶底仍不可押注）。
    // 意图状态不落盘（与 fairValue/fund/regime 同寿命），重启即重新观察。
    intent: {
      enabled: true,
      warmupTicks: 200, // 开局先看盘，不立刻动手
      depthAware: true, // 主动单按对手最优档承接力约束（不留超量残单在盘口）
      aggroDepthMult: 3, // 单笔主动量 ≤ 对手最优档剩余量 × 该系数
      // 盘口承接力地板：主动卖单不下手于比这更薄的买盘。
      // 薄盘上砸下去只会把最后一档买盘也扫光——自己成交了，盘面却变成"没有买盘"，
      // 之后谁也别想卖（实测这是买盘空档时段的主要来源）
      thinBookFloor: 3000,
      depthRangePct: 0.02, // 盘口深度采样半径（相对最新价）
      depthMaxLevels: 60, // 深度采样最多遍历的档位数（性能上限）
      // 挤兑空头：空头存量 + 券源紧张 + 不是下跌段，就往空头头上打。
      // 卖盘越薄越省力（触发概率加分）。参与者停止派发、放大买量与吃单量。
      squeeze: {
        label: '挤兑空头',
        rate: 0.03, // 条件满足时每 tick 触发概率
        minShortFloatRatio: 0.05, // 空头存量 / 流通盘 门槛
        minLendUtilization: 0.45, // 券源被借走比例门槛（借不到券才是逼空的燃料）
        minForce: 0.1, // 力量天平门槛：多头至少不处劣势才挤得动空头
        durationTicks: [150, 500],
        cooldownTicks: [1200, 3000],
        power: [0.7, 1.3],
        bias: 1.1, // 情绪附加：> 0.65 即触发"不看价地扫单"
        aggroBoost: 2.0, // 主动吃单量放大
        bidBoost: 1.8, // 买盘挂单量放大
        suppressHeat: true, // 不因"贵了"而派发（过热回归暂让位）
        suppressSell: true, // 不主动卖出（不给自己人拆台）
        maxGain: 0.4, // 相对触发时价格的最大推进（保险丝）
        endWhenShortGone: true, // 空头存量降到触发时的 25% 视为达成
        shortGoneRatio: 0.25,
      },
      // 压盘吸筹：价格远低于基本面重心时，先砸一段（诱空）打出恐慌盘，再承接吸筹。
      // 吸筹段刻意**不主动扫单**——靠加深买盘被动接抛盘，同时压住报价中枢（压盘）。
      accumulate: {
        label: '压盘吸筹',
        rate: 0.02,
        // 门槛用**大级别位置**（重心相对发行价），不用"价格相对重心"的短端偏离：
        // 短端偏离被 fvAnchor（几十 tick 的时间常数）钉在 0 附近，实测"偏离 15%"
        // 的命中率是 0.00%——拿它当门槛等于这条战术永不触发
        maxLevel: -0.25, // 大级别跌掉四分之一才算低位
        maxForce: 0.3, // 力量天平门槛：多头强势期不吸筹（那是接飞刀）
        durationTicks: [200, 600],
        cooldownTicks: [1200, 3000],
        power: [0.7, 1.3],
        lureRatio: 0.25, // 前 25% 时长是"诱空砸盘"铺垫段
        lureBias: -0.55, // 铺垫段：主动卖，把价格打下去
        bias: 0.5, // 吸筹段：想买（加深买盘、库存软目标转双向）
        pressDown: 0.005, // 报价中枢额外下压（压住反弹 = 压盘）
        bidBoost: 2.0, // 承接买盘加深
        askBoost: 1.6, // 上方压单加大
        collect: true, // 临时解除"只惩罚超配"，允许低配收集
        suppressAggroBuy: true, // 吸筹段不抬价扫单（靠承接，不靠追）
        exitAboveLevel: -0.05, // 大级别回到接近发行价就收工
        maxGain: 0.15, // 价格反而涨了 15% 以上说明底部判断作废，收手
        maxLoss: 0.3, // 又跌 30% 说明看错了，止损离场
      },
      // 抬价派发：价格远高于重心且公开情绪乐观（有人接货）时，先小幅拉抬做出"突破"假象，
      // 再停止一切买入、放大卖盘派发。买盘接力交给追涨的散户与动量盘。
      distribute: {
        label: '抬价派发',
        rate: 0.05, // 触发的窗口比另外两种窄（高位 + 有追涨盘），概率给高一点才常见
        minLevel: 0.25, // 大级别涨了四分之一才算高位（门槛口径同压盘吸筹）
        // 力量天平门槛取"不占劣势"而非"占优"：派发恰恰常发生在天平从多头转向、
        // 获利盘开始涌出的时候。要求"多头占优"会与"高位"互斥——价格越高，
        // 获利盘越重、天平越往下走，两个条件永远凑不到一起
        minForce: -0.2,
        minMomentum: 0, // 要有追涨的动量盘才谈得上"诱多"
        durationTicks: [150, 500],
        cooldownTicks: [1200, 3000],
        power: [0.7, 1.3],
        lureRatio: 0.2, // 前 20% 时长是"诱多拉抬"铺垫段
        lureBias: 0.6, // 铺垫段：小幅拉抬，做出突破的样子
        bias: -0.9, // 派发段：想卖
        askBoost: 1.8,
        suppressOpenBuy: true, // 派发段不开多（含不抄底，别接自己的货）
        exitBelowLevel: 0.05, // 大级别掉回接近发行价即收工
        maxGain: 0.5, // 跟着上趋势走，但相对触发价再涨 50% 就撤（不做无限抬轿）
        capLevel: 1.2, // 重心翻倍以上也不抬了
      },
    },
    // 大模型主力脑：**只 1 个**跨股机构（多空皆可，目标是赚钱）。
    // 每游戏日决策 2 次（开盘竞价 / 收盘竞价前）；其余报价与吃单仍走上方量化规则。
    // 并发多脑时 flash 经常 no_json 超时（实测 3/4 失败），故收敛为单脑串行。
    // enabled=false 时全链路关闭，与旧行为逐位等价。
    llm: {
      enabled: process.env.NPC_LLM === '1',
      // 只实现了 OpenAI Chat Completions 兼容协议（小米 MiMo 等）；其他 provider 会被
      // client.js 直接判为不支持并跳过，不会瞎发请求
      provider: process.env.NPC_LLM_PROVIDER || 'openai',
      baseUrl: process.env.NPC_LLM_BASE_URL || 'https://api.openai.com/v1',
      apiKeyEnv: process.env.NPC_LLM_KEY_ENV || 'NPC_LLM_KEY',
      model: process.env.NPC_LLM_MODEL || 'mimo-v2.6-flash',
      // 决策要的是稳定而不是文采，0.7 会让同一张盘面来回翻立场
      temperature: 0.5,
      // 实测 mimo-v2.6-flash 含 reasoning 单次 8~25s；单脑也给足 40s，尽量不出 no_json
      timeoutMs: 40000,
      // 瞬时故障（429/5xx/超时）重试次数，0 = 不重试
      retry: 1,
      // 单次输入字符上限：超了**丢弃本轮**（不发请求），防 snapshot 变大后静默烧 token
      maxInputChars: 12000,
      // 推理模型（mimo 等）先花 reasoning 再输出正文：实测成功那几次 completion 已到
      // 651~721/800，一旦 reasoning 再长一点正文就被截断 → content 空/半截 → no_json。
      // 2000 是给"思考 + 一个完整 JSON"留的余量（输出 token 便宜，空跑一轮才贵）。
      maxOutputTokens: 2000,
      // 每日真实调用熔断（按**本地自然日**滚动）。
      // 单脑 × 约 6 次/游戏日 ≈ 840 次/24h，留重试余量取 1000
      budget: {
        maxCallsPerDay: 1000,
      },
      // 写回夹紧：模型说什么都先夹进安全区间，避免一次误判掀翻盘口
      clamp: {
        bias: 0.45,
        aggro: [0.55, 1.45],
        intentChance: [0, 0.55],
        planTicks: [80, 900],
      },
      // 唯一大模型主力：账号 `AI·一号主力`（续跑沿用该名，避免旧档多出一只无脑 AI）
      whales: [
        {
          id: 'whale_a',
          label: '一号主力',
          style:
            '职业操盘手，唯一目标是把账户权益做大。多空都做：顺势做多、弱势做空或减仓；' +
            '不押死一个多头故事。优先集中火力在最有把握的 1~3 只股票，控制回撤，避免同时满仓多只。',
          side: 'flex',
        },
      ],
      // 账号名前缀 + 初始现金（新开局建 1 个多股票账户；只给现金不抽流通盘）
      accountPrefix: 'AI·',
      cashEach: 100000000, // 1 亿
      // 每次决策最多动用现金比例（单股），避免一次把盘口打穿
      orderCashRatio: 0.18,
      // 每次决策最多对多少只股票下非 neutral 策略（其余保持规则盘）；按 weight 取前 N
      maxStocksPerDecision: 3,
      // 每个脑每次决策最多挂几张单（单脑可稍松，仍防一轮砸穿多只股票）
      maxOrdersPerDecision: 3,
      // 触发阶段 key：段开始即决策。加段中 midTriggers 后约 6 次/游戏日
      triggerPhases: ['auction', 'morning', 'afternoon'],
      // 段中再决策一次（进入该阶段后走完 atPct 再跑）：上午/下午各插一刀
      midTriggers: [
        { phase: 'morning', atPct: 0.45, key: 'morning_mid' },
        { phase: 'afternoon', atPct: 0.45, key: 'afternoon_mid' },
      ],
      // 收盘竞价只有 20s、最后 10s 锁单，而单次推理约 8s：等竞价开始再决策，订单赶不上
      // 收盘撮合。这里在 afternoon 段结束前 leadMs 提前跑「收盘那轮」，去重键记 closeAuction，
      // 真正进入 closeAuction 时不会重复调用（若提前排程没跑成，阶段触发仍是兜底）。
      // leadMs 要覆盖"推理耗时 + 重试"：实测单次 4~26s、最慢 25.7s，25s 提前量会让订单
      // 刚好卡在竞价开始那一刻甚至更晚，所以留 45s（下午段 260s，余量足够）。
      preTrigger: { phase: 'afternoon', leadMs: 45000, dedupeKey: 'closeAuction' },
      // 计划存活 tick 数：交易日约 886 tick，480 ≈ 336s（覆盖到午后），
      // 写回时再夹进 clamp.planTicks；旧值 200 只覆盖 26% 的交易日
      defaultPlanTicks: 480,
      // 聪明钱情绪偏置增益（机构 1、游资打折）；被动类型不受 llmPlan 影响
      biasScale: {
        hot: 0.55,
      },
    },
    // 被动持有者（大户/中户/散户）的浮盈亏行为：割肉与获利了结。
    // 他们不是"永不卖出的背景板"，而是机构的吸筹/派发真正需要的对手盘。
    // 成本口径取自己的持仓批次（NPC 每 tick 合并成一条，均值即成本），
    // 不能用发行价——用发行价的话这些人要一路拿到最后才动，盘面就没有换手。
    // 恐慌侧重于获利侧：下跌踩踏更凶，上涨的获利了结只做温和回吐
    pnlFeel: {
      enabled: true,
      panicLoss: -0.25, // 浮亏 25% 起割肉
      panicBias: 0.3,
      takeProfit: 0.3, // 浮盈 30% 起获利了结
      takeBias: 0.25,
    },
    // 日内节奏（2026-10 起）：NPC 的**交易行为**按交易日阶段调制。
    //
    // 引入「天」之前 NPC 是一根均匀的时间轴——报价、吃单、挂单量每 tick 一样密。
    // 一天切成 6 段之后，段的差别只体现在"能不能交易 / 要不要集中撮合"上，
    // 盘面的**交易密度**却是平的，观感与没有「天」时一样。
    // 真实市场的日内节奏是 U 型：开盘半小时与尾盘半小时最重（隔夜信息在这两段释放、
    // 资金在这两段进出），午间清淡。这里把这条形状做成一个 0.75~1.45 的活跃度乘子，
    // 分四路作用：主动吃单率 / 单笔量 / 重报价频率 / 点差（越活跃点差越窄）。
    //
    // **刻意只调制交易行为，不碰公允价值与噪声**：定价路径必须与
    // `day.test.js [17]`（午休步进＝上午、夜间＝上午 × overnightDriftMul）的
    // 口径一致，把波动也按段缩放会让「午休不制造假跳空」那条不变量失效。
    rhythm: {
      enabled: true,
      // 阶段基准活跃度（key 对应 day.phases[].key；未列出的阶段按 1）
      phases: {
        auction: 1.15, // 开盘集合竞价：隔夜信息的第一次定价，参与者最敢下重手
        morning: 1.0, // 上午连续竞价（段内再走 U 型曲线）
        afternoon: 0.88, // 下午普遍比上午清淡
        closeAuction: 1.3, // 收盘竞价：全天博弈密度最高的一段
      },
      // 段内 U 型曲线只作用于这两个长段（竞价段短，本身已经是一次"集中释放"）
      curvePhases: ['morning', 'afternoon'],
      openBurstPct: 0.18, // 段首 18% 时长内衰减：开盘抢价的半小时
      openBurstMul: 1.45,
      closeRampPct: 0.12, // 段尾 12% 时长内回升：尾盘资金回流
      closeRampMul: 1.25,
      troughMul: 0.85, // 中段谷底
      aggroGain: 1.0, // 活跃度 → 主动吃单率（线性，1.45 → 1.45×）
      qtyGain: 0.7, // 活跃度 → 单笔挂单/吃单量
      requoteGain: 0.6, // 活跃度 → 重报价频率
      spreadGain: -0.3, // 活跃度 → 点差（越活跃点差越窄）
    },
    // 趋势阶段（牛 / 震荡 / 熊）——对数空间推力，参考港股小米集团式行情：
    // 大级别能翻几倍、也能腰斩再腰斩——甚至翻十倍、跌到十分之一，
    // 幅度本身由随机趋势段决定、不是固定目标，顶底均无法预判：
    // - 阶段时长指数分布（无记忆）：已走多久推不出还要走多久
    // - 方向每次重新抽签，顶底常是假突破后的延续或反杀
    // - 幅度三档混合：温和为主、偶尔极端（极端段给出数倍级行情）
    //
    // ⚠️ `bands` 是**每 tick** 的对数漂移，所以「一天的涨跌幅」= 一天的 tick 数 × 它。
    // 引入「天」之后一天只有 620 秒 = 886 tick（≈3.4 个趋势段），而下面这组数字
    // 原本是给"连续无边的时间轴"标的：直接沿用会让**日收益中位数就有 ±38%**
    // （`day-probe.js` 实测 100 个「股票×交易日」样本：中位 38.2% / p90 108% /
    // 83% 的交易日超过 ±10%），涨跌停 ±10% 于是从"熔断器"变成"日内主约束"——
    // 实测连续竞价时段 64% 的采样价格贴在板上、10 只里 7 只顶板、强平 66.7 次/天。
    // 2026-10-16 按「一天」重标定（整体 ÷11，三档首尾相接），当日实测
    // |日收益| 中位 3.3% / p90 9.2%——此时又比**真实港股**高一倍。
    //
    // **真实口径**（十只原型港股 2024-10~2026-10，503 个交易日 × 10 只）：
    // |日收益| 中位 1.67% / p75 3.01% / p90 4.65% / p99 10.40% / 最大 29.31%，
    // 日收益 std 3.10%，超过 ±10% 的交易日占 1.2%。本轮收口分两步（都在 2026-10-16）：
    // 先三档同 ×0.67（÷1.5），跳空做起来之后日收益被抬高一档，于是再 ×0.72——
    // 合计 ≈÷2.07，三档仍首尾相接。最终实测（day-probe，4 局 × 5 天 × 10 股）：
    // |日收益| 中位 2.78% / p90 8.04% / std 4.38% ≈ 真实的 1.4~1.7 倍——既贴住真实观感，
    // 又保住"极端段能打出连续涨停 / 跌停"（完全对齐真实会让连板几乎不再出现）。
    // 调参用 `node test/day-probe.js [局数] [天数] [on|off]`——off 看原始日波动定 pct、
    // on 看贴板观感，和 `npc-probe.js` 的买盘空档率 / 强平次数一起盯。
    trend: {
      phaseMinTicks: 45, // 阶段最短 ~30 秒
      phaseMeanTicks: 260, // 时长均值 ~3 分钟（指数分布），一天约 3.4 段
      phaseMaxTicks: 1200, // 时长硬上限 ~14 分钟
      flatWeight: 0.3, // 抽中震荡阶段（g=0）的概率
      weights: [0.62, 0.3, 0.08], // 温和 / 强 / 极端 的抽中权重
      bands: [
        [0.0000145, 0.000068], // 温和：单阶段（~260 tick）±0.4%~1.8%
        [0.000068, 0.000195], // 强：单阶段 ±1.8%~5.1%
        [0.000195, 0.00039], // 极端：单阶段 ±5%~10%——正好能打出连续涨停 / 跌停
      ],
    },
    // 行情周期层：牛 / 熊 / 震荡三态的**周月级**慢推力（2026-10-18 新增）。
    // 为什么需要：trend 相位均值 260 tick（~3 分钟）+ fundAnchor 一日半衰期，两者合谋把
    // 价格锁成「围绕发行价的均值回归」——半年 111 个游戏日里最大偏离发行价仅 26%、
    // 20 日方差比 VR 只有 0.09~0.18（随机游走应 ≈1），永远走不出牛熊。周期层补上
    // 「周/月」这个缺失的时间尺度，设计对齐真实牛熊的成因（外生慢变量点火 + 正反馈放大）：
    // - 换挡无记忆：每 tick 恒定小概率换挡（期望持续 (minDays+maxDays)/2 个游戏日），
    //   已走多久推不出还要走多久、顶底无法倒计时——与 trend 相位的「指数分布」同一宪法
    // - 幅度不做目标：整段周期的对数涨/跌幅从区间抽签摊到每 tick；段内仍有 trend 纹理
    //   与噪声，K 线扭动、无法拟合直线外推「还有几天到顶」
    // - 方向概率刻意不对称（牛 38% / 熊 34% / 震荡 28%，牛的目标区间更宽）——对齐
    //   A 股「牛短熊长、暴涨缓跌」之外的另一半事实：涨多跌少
    // - 状态内幕：cycleDir 与 fund/regime 同级，不下发客户端，玩家只能从盘面与消息猜
    // - 隔夜折算：夜间推力按 overnightDriftMul 放大，抽出的目标涨幅先按一日的有效
    //   推力当量（≈886 tick × 1.77）折算，否则周期幅度会凭空放大近一倍
    // 上线前用 day-probe.js / npc-probe.js 复核强平次数、贴板率与买盘空档（连续单边段
    // 是杠杆/补款/涨跌停从未承受过的新压力源）
    cycle: {
      enabled: true,
      minDays: 25, // 期望持续 ≈ (25+70)/2 ≈ 47.5 个游戏日（几何分布）
      maxDays: 70,
      bullWeight: 0.38, // 抽中牛市的概率；熊市 = bearWeight；其余为震荡
      bearWeight: 0.34,
      bullTarget: [0.35, 1.1], // 整段牛市对数涨幅区间 → 价格 +42%~+200%
      bearTarget: [-0.6, -0.25], // 整段熊市对数跌幅区间 → 价格 −22%~−45%
      flatTarget: [-0.05, 0.05], // 震荡段 ±5% 以内
      // 纹理衰减：trend 相位（3 分钟）漂移注入重心的偏离按此半衰期回归周期成分、
      // 并夹在 ±textureCap 内。没有这一步纹理会随机游走，日收益 std 从 4.4% 抬到 7.3%
      //（day-probe 2026-10-18 实测）；半衰期取 ~10 个游戏日
      textureHalfLifeDays: 10,
      textureCap: 0.2,
    },
    // 内生正反馈（2026-10-18 第三步）：给牛熊加上「质感」——
    // 赶顶加速、恐慌跌得比涨快、磨底磨得人心慌。周期层只给方向与幅度，
    // 这一层负责让上涨/下跌**不对称**，并让参与者的风险偏好随盈亏自适应。
    // 设计对齐真实成因：贪婪追涨（正反馈）+ 恐慌踩踏（强平放大）+ 底部惜售无力。
    //
    // 一个慢变量 mood ∈ [-1,1]：−1 恐慌/磨底，+1 贪婪/赶顶。由近期收益（不对称：
    // 跌比涨对 mood 的冲击更大）、距峰值回撤、周期方向先验共同驱动，按半衰期逼近。
    // mood=0 时整层逐位无操作——单测与 day.test [17] 可安全隔离。
    feedback: {
      enabled: true,
      // mood 目标值的驱动（最终夹在 [-1,1]）
      panicGain: 3.2, // 近期下跌对 mood 的冲击（ret 为负时）
      greedGain: 1.4, // 近期上涨对 mood 的冲击（故意更弱：恐慌比贪婪猛）
      ddGain: 1.6, // 距峰值回撤加深恐惧（dd 为负）
      cyclePrior: 0.15, // 周期方向先验：牛周期里 baseline 略偏贪婪
      halfLifeTicks: 320, // mood 逼近目标的半衰期（≈0.36 个游戏日）
      // 不对称定价：跌更狠、反弹更弱（方向敏感，不抬总波动）
      panicAsym: 1.25, // 负向漂移放大 1 + panic×this（mood<0 且 push<0）
      panicReboundDamp: 0.4, // 恐慌时正向漂移收力到 1 − panic×this（反弹无力）
      greedAsym: 0.45, // 正向漂移放大 1 + greed×this（mood>0 且 push>0）
      greedDipDamp: 0.25, // 贪婪时负向漂移收力到 1 − greed×this（惜售）
      blowoffGain: 0.55, // 赶顶：贪婪 × 近期已涨 → 额外上推（加速段）
      blowoffCap: 0.012, // 赶顶额外推力每 tick 上限（防失控）
      // 波动聚集：恐慌时噪声更大（跌得急、反弹毛刺多）；幅度收着点，别把日 std 推太高
      volGain: 0.5,
      panicVolAsym: 1.3, // 恐慌侧波动再乘这个（不对称）
      // 磨底：深度超卖 + 跌不动了 → 活跃度收手、点差放宽、挂单变薄
      grindDrawdown: -0.22, // 距峰值回撤达到此值才可能进入磨底
      grindQuietRet: 0.02, // 近期 |收益| 小于此值视为「跌不动了」
      grindAggroMul: 0.55,
      grindQtyMul: 0.65,
      grindSpreadMul: 1.55,
      // 风险偏好自适应：贪婪加力、恐慌更凶（吃单率/单笔量）
      greedAggro: 0.35,
      panicAggro: 0.55,
      // 强平放大：恐慌深时系统兜底滑点加大 → 踩踏自我强化
      panicSlipMul: 1.8, // 滑点 × (1 + panic×this)，panic = max(0,−mood)
    },
    // 基本面重心：随趋势慢一拍迁移，再以约 15 分钟时间常数回归发行价
    // （对数空间回归，涨十倍与跌到十分之一的拉回对称；比旧版 70 秒锚慢一个数量级）
    fundTrendFollow: 0.7,
    // 基本面重心的回归保险丝。原 0.0008 的半衰期 ≈ ln2/0.0008 ≈ 866 tick ≈ **正好 1 个
    // 交易日**——今天涨 20% 明天先抹 10%，任何趋势都活不过两天。这是「半年无牛熊」的
    // 主凶（2026-10-18 诊断：VR20 实测 0.09~0.18，价格是围绕发行价的均值回归而非随机游走）。
    // 降到 2e-5（半衰期 ≈ 39 个游戏日）后只做超长期的数值保险丝，周月级趋势由 cycle 层承载
    fundAnchor: 0.00002,
    fundNoiseRel: 0.0006,
    // 公允价值向重心回归 / 向最新价跟随的强度
    fvAnchor: 0.025,
    priceCoupling: 0.04,
    noiseRel: 0.0012, // 每 tick 相对噪声（管毛刺，不管趋势）
    // 休市（午休 / 夜间）时公允价值仍随趋势与消息迁移，但报价与撮合冻结。
    // 日内 40 秒的休市要折算真实世界的「一夜」，所以推力按倍数放大：
    // 阶段结束时 NPC 拿着已经走远的定价锚重新报价，**隔夜跳空**就是这么来的
    // （跳空幅度 ≈ 漂移 / priceCoupling，再被涨跌停夹在区间内）。
    // 真实口径：十只原型港股近两年 5030 个「股票×交易日」的**开盘跳空 std 1.82%**、
    // 中位 |跳空| 0.88%、|跳空| ≥ 3% 占 7.7%。
    // 从 3 提到 13（≈ 一个交易日的当量：真实隔夜跳空的方差约占全日的 1/3，
    // 而我们的竞价报价还要再稀释一道，见 fundOvernightFollow）是三件事一起补：
    // bands 本轮先 ÷1.5 再 ×0.72（合计 ≈÷2.07，完整两步见 `Doc/项目知识.md` 变更记录）、
    // 报价中枢的贴昨收权重稀释、以及原 3% 报价缓冲的砍尾。
    //
    // ⚠️ 这个倍数**不决定开盘价本身**：竞价收敛档会把全体报价夹回 ±quoteCushion 并撤掉
    // 试探远价，跳空只吃到放大效果的一半（实测 8% 缓冲：不收敛 std 2.90% / ≥3% 占 15%，
    // 有收敛档 std 1.54% / ≥3% 占 6.7%）。改这一项要连 `auctionCushionOpen` /
    // `auctionConvergeMs` 一起看，并用 `day-probe.js` 盯跳空分布
    overnightDriftMul: 13,
    // 夜间基本面重心跟着同一倍数一起迁移。**不放大重心的话跳空根本建不起来**：
    // 机构的定价锚是 `fund`（fundWeight 0.7），重心不挪 → 这批报价一夜之间"没改口"，
    // 而它们又是竞价簿里单量最大的一侧，最大成交量原则算出的开盘价被硬生生拉回昨收附近。
    // 实测（`diag3` 80 个样本）：夜间短端公允漂移 1.55%、跳空只有 0.70%，漏斗 0.45。
    // 真实市场的隔夜跳空恰恰来自"收盘后信息把基本面重估了一遍"，重心本就应该跟着动。
    fundOvernightFollow: true,
    // 公允价值安全边界（相对发行价倍数）：0.05×~ 20×。**这不是行情目标**——
    // 极端幅度（翻十倍 / 跌到十分之一）完全由趋势段随机给出，边界只是防数值
    // 失控的保险丝，刻意留得很宽、平时几乎不触碰（触到就终止当前阶段，但不反转）
    rangeLow: 0.05,
    rangeHigh: 20,
    // 报价中枢里最新价的权重（其余为公允价值）。报价贴住最新价，
    // 才不会被价格笼子（±5%）挡成永远无法成交的死单；公允价值的领先部分
    // 则通过主动吃单把价格一段段拉过去，行情有趋势也有成交量
    quoteLastWeight: 0.4,
    // 报价中枢离最新价的硬夹（< 价格笼子 5%）：公允价值无论滑多远，
    // 盘口始终落在可成交区间，行情不会"断线"死锁
    quoteCushion: 0.03,
    // 开盘集合竞价的「试探档」报价缓冲。真实市场 09:15~09:20 可以自由撤单，
    // 参与者会挂**试探性远价**去博虚拟开盘价（挂低买、挂高卖，赌最终的集中撮合价）。
    // 引入「天」之后隔夜跳空的幅度 ≈ 夜间漂移，但它被 quoteCushion（±3%）硬夹——
    // 定价锚走得再远，竞价成交价也只能离昨收 3%，真实港股的开盘跳空 std 是 1.82%、
    // 7.7% 的交易日 |跳空| ≥ 3%，夹在 3% 等于把跳空的尾部切掉。
    // 放宽到 8%：隔夜走远的定价锚真的体现在竞价成交价上，涨跌停（当前 ±30%）仍是兜底。
    // **只有开盘竞价放宽**——收盘竞价相对"刚走完的下午"不该凭空跳那么远
    //（尾盘异动是另一个玩法维度，本轮刻意不做）。
    auctionCushionOpen: 0.08,
    // 竞价试探档里「报价贴最新价」的权重（常规是 quoteLastWeight 0.4 / 机构 0.25）。
    // 竞价里的最新价还是**昨收**——那是过了一夜的信息，参与者这时拿着的是新估值，
    // 本来就不该贴着昨收报价。不压这个权重的话，报价中枢 = 0.4×昨收 + 0.6×锚，
    // 隔夜漂移被稀释掉四成（实测跳空 std 0.82%，真实 1.82%）。
    // 取 0.18 → 中枢八成以上由定价锚决定，隔夜信息才进得了开盘价。
    auctionProbeLastWeight: 0.18,
    // 进入「不可撤单」窗口前这么多毫秒，全体 NPC 从试探档切到收敛档（报价回到 quoteCushion）。
    // 复刻真实 09:20 前那一波"把试探远价撤掉"：撤不掉就得认账，所以最后一刻报价必须
    // 落在真实意愿上。试探档里挂的远价如果一直留到锁单，会被集中撮合在荒谬的价位上成交
    auctionConvergeMs: 2000,
    // NPC 流动性回收：全池现金（不含保证金/冻结）低于地板价时按比例回补。
    // 空头保证金会把全池现金吸干（开空时现金的一半进保证金），现金归零后
    // 没人买得动、盘面双向死锁——回补就是给做市商池子的"活水"，只补到地板不注水
    liquidityFloor: 42000000,
    liquidityRefill: 0.02, // 每 tick 向地板回补剩余缺口的比例（~2 分钟补满）
    // 2026-10-16 加的第二条判据（判据是**症状**，不是"人头够不够"）：
    // 实测（`diag-empty-bid`，24010 个连续竞价采样）买盘空档那一刻——占全部采样的 11.5%——
    // 全池现金仍占流通市值 18.75%，与有买盘的时刻（18.92%）几乎一样；
    // 但**拿得出一个手数现金的账户只有 19.9/316**（有买盘时 111.7）。一天下来散户/中户
    // 把现金都换成了股票（初始 340M 股票 vs 15M 现金），钱集中在机构手里，
    // 于是买盘侧的实际承接力只剩十几个聪明钱账户，它们一转空头阵营买盘就整侧空掉。
    // 修法：**买盘侧真的空了**时才给最穷的几个账户补到 `liquidityTopUpLots` 手，
    // 补一次歇 `liquidityTopUpCooldown` tick。
    // ⚠️ 冷却与"每次只补几个人头"是必需的：补进去的钱会被立刻挂成买盘（可用现金随即归零），
    // 拿"挂得起一手的账户数"当判据的话**每 tick 都会触发**（正式服实测 3 秒内连记 4 条），
    // 等于逐 tick 无限注水、还把账户反复标脏。
    liquidityTopUpLots: 8, // 补款目标：够挂 8 手（缺口大时按人头摊薄后抬高，见 recycleLiquidity）
    // 每次补几个人头。原 2 人 × 8 手 ≈ 1600 股，摊到五档连一档都填不满，
    // 补出来的深度反而低于 thinBookFloor（3000 股），主动卖单被全拦 → 盘面冻死。
    // 实测买盘为空时 **91.8% 的账户卡在"现金不够一手"**（不是空头阵营、不是额度满），
    // 而全池 62% 的现金压在 10 家机构手里：能挂买盘的账户只有约 6%。
    // 5 人/12 tick 太慢（316 户要补 90 轮 ≈ 18 分钟），这里提到 12 人 / 6 tick。
    liquidityTopUpHeads: 6,
    liquidityTopUpCooldown: 6, // 补一次歇多少 tick（6 tick ≈ 4.2 秒）
    // 买盘深度目标（手）：**低于它就补，不再等整侧空**。
    // 原来判据是 `book.bids.length === 0`——只有整侧归零才动作，等于事后再救；
    // 而"买一到买五全空"的那一瞬玩家已经看见了（实测占连续竞价采样的 7.8%，
    // 空段 90 分位 15 tick、最长 134 tick ≈ 一分半钟，不是闪烁）。
    // 取 40 手 = 4000 股，刚好压过 thinBookFloor(3000)，保证补出来的是"能成交的深度"，
    // 而不是一档 800 股、谁砸谁穿、砸完就归零的假深度。
    liquidityBidDepthLots: 40,
    // NPC 撤单/重新报价的最小间隔（tick 数）
    minRequoteTicks: 1,
    // 主动吃单留下的残单存活 tick 数（只作用于连续竞价）。
    // 主动单的价格钉在「对手价 ∓1 分」，吃到最优档之外的部分就是一张自己并不想要的
    // 挂单。旧实现靠 requote「先撤后挂」顺手清掉，P1 把 inst/hot/small 的报价关掉之后
    // 这条路没了——竞价段每笔主动单必然变残单（只入簿不撮合），整天不动也不撤，
    // 实测冻结投资者现金 26%~30%。改成显式 TTL：连续竞价里 2 tick 没成交就撤。
    // 竞价段**不递减**（竞价要的是委托累积，见 shouldRequote），竞价结束进入连续竞价
    // 后这些陈旧单才开始老化，2 tick 内清干净。
    aggroTtlTicks: 2,
    // 游资/散户追涨杀跌的动量窗口（tick 数，约 1 分钟）：看最近一段涨跌幅而不是
    // vs 重心的偏离——顶部一旦横盘动量归零，情绪才能轮动出卖家，不会全员死多。
    // 各类强度 = momentumGain × types[x].momentumGainMul
    momentumTicks: 90,
    momentumGain: 2,
    momentumClamp: 0.3,
  },

  // 分时图弹幕（见 Doc/弹幕方案.md）—— **文案 100% 取自本地池，无任何模型调用**
  danmaku: {
    enabled: true,
    // 语气前缀（「唉，」「真行，」）总开关：关掉就是纯主句，方便对比观感
    prefix: true,
    // 全服节奏：任意两条弹幕之间至少隔这么久。玩家的操作反馈也走这个闸门
    globalGapMs: 1500,
    // 单股配额：稳态 4 条/分钟、两条之间至少 6 秒，屏幕才不糊
    stockPerMin: 4,
    stockGapMs: 6000,
    // 单个 NPC 10 分钟内最多说 1 条——「曹俊（杭州）」3 分钟骂 12 次街就穿帮了
    accGapMs: 600000,
    // 每次触发 tick 真的开口的概率：不是每 1.5 秒都必说一句，否则像节拍器
    speakChance: 0.55,
    // 一条弹幕带表情的概率。别调到 1：满屏都是脸会比没有更吵，
    // 而且「他终于平静了」这种话本来就不该配表情（§3.8）。机构/自营恒不带，见 danmaku-emotes.js
    emoteChance: 0.55,
    // NPC 能从哪些表情系列里挑。默认只有「经典」；在 danmaku-emotes.js 的 PACKS 里
    // 登记新系列后，把它的 id 加进来才会被抽到（玩家手选不受此限制，不看这个开关）
    emotePacks: ['classic'],
    // 午休 / 夜间密度减半：这两个阶段没有新成交，说太密就像在念稿子（方案 §2.4）。
    // 停牌直接不生成，那是 tick 传进来的 halted，不在这里配
    quietPhases: ['lunch', 'night'],
    quietFactor: 0.5,
    // 待发反应的最长滞留：超过就丢，不补播（「14:02 有人被抬走」拖到 14:10 最出戏）
    queueTtlMs: 60000,
    // 下发窗口：只带最近 5 秒的条目（客户端按 id 去重，不依赖上一帧差集）
    snapshotMs: 5000,
    itemLimit: 60,
    // 「有人在看」的 TTL：由 /api/history?stock= 打点，5 分钟没看就不为它生成
    watchTtlMs: 300000,

    // 玩家被动反应（§3.3.2，已拍板：只做 B 档，不做「NPC 接玩家话」）
    playerB: {
      enabled: true,
      // 大额买入的门槛：60 秒内累计成交额 ≥ 流通市值 × 0.05%
      floatMvPct: 0.0005,
      windowMs: 60000,
      // 触发后 30 秒不再累加：否则玩家下一笔零碎单会接着触发
      quietMs: 30000,
      // 清仓割肉的最小累计成交额（20 万）
      minAmount: 200000,
      // 同一玩家 5 分钟内最多被评论 1 次，否则像被监视
      commentGapMs: 300000,
      // 玩家被强平：2 分钟冷却，不受上面 5 分钟 chat 冷却约束
      liqGapMs: 120000,
      maxPerMin: 2,
    },

    // 玩家主动发弹幕
    player: {
      enabled: true,
      maxLen: 24,
      gapMs: 5000,
      perMin: 6,
      // 同文 60 秒内拒发：复制粘贴刷屏是移动端最省力的攻击
      sameTextGapMs: 60000,
      // 单账户自然日上限，防脚本（内存计数，重启清零）
      maxPerDay: 120,
    },
  },

  // 随机消息（利多 / 利空）
  news: {
    minIntervalMs: 20000,
    maxIntervalMs: 60000,
    durationMs: 60000, // 消息影响持续时间
    // 消息对公允价值的每 tick 相对推力（乘性：fv *= 1 + 推力，与价格无关）。
    // 调大 = 消息行情更凶
    fvDriftCoef: 0.0015,
    // 消息方向跟随当前牛熊阶段的偏向强度：p(利好) = 0.5 + regimeBias × 阶段方向。
    // 0.2 → 牛市阶段 70% 消息利好、熊市阶段 70% 利空，让消息面与走势互相印证。
    // **regimeBias 只管分钟级趋势纹理**（3 分钟相位，翻得快、均值偏 0）；
    // 周月级牛熊故事由下面的 cycleBias 承载（2026-10-18 周期层第二步接线）。
    regimeBias: 0.2,
    // 周期层方向的偏向强度（个股按自己的 cycleDir，大盘消息按全市场均值）。
    // 牛熊周期里新闻应与大方向印证：牛市周期里个股利好更多，磨底时利空更多。
    // 与 regimeBias 叠加后夹在 ±0.35（p(利好) ∈ [15%, 85%]），不会写成一边倒的宣传稿。
    cycleBias: 0.22,
    tapeSize: 200, // 客户端消息列表保留条数
    // 按交易日阶段覆盖产出节奏与 scope 分布（key 对应 day.phases[].key）。
    // 没配的阶段回退到上面的 min/max + 三 scope 均匀抽；换阶段时节奏重新排队
    // （news.js maybeEmit），不跨阶段沿用上一段排出的倒计时。
    //   盘前（开盘竞价 30s）：隔夜重磅密集落地，8~16s 一条、以「全体」隔夜宏观为主
    //   盘中（上午/下午）    ：默认 20~60s、均匀抽
    //   午休（40s）          ：18~35s 保底一条午间公告，scope 偏机构
    //   收盘竞价（20s）      ：不配规则 → 重排队后首个候选 ≥20s 落在段外，恒无新消息
    //                         （尾盘的张力交给竞价机制本身，不加消息料）
    //   盘后（夜间 40s）     ：8~15s 公告密集、偏机构；个股消息改走「盘后公告」文案池，
    //                         作用期由 game.tick 抬到次日开盘竞价结束（untilFloor）
    phaseRules: {
      auction: { minIntervalMs: 8000, maxIntervalMs: 16000, scopeWeights: { 全体: 0.6, 机构: 0.25, 散户: 0.15 } },
      lunch: { minIntervalMs: 18000, maxIntervalMs: 35000, scopeWeights: { 全体: 0.35, 机构: 0.45, 散户: 0.2 } },
      night: { minIntervalMs: 8000, maxIntervalMs: 15000, scopeWeights: { 全体: 0.3, 机构: 0.5, 散户: 0.2 } },
    },

    // ---------------- 消息分层（信息不对称，见 Doc/消息分层方案.md） ----------------
    //
    // 三段式生命周期：诞生 t0 → 内幕可见 t1 → 公开 t2 → 过期 until。
    // **泄露期 [t1, t2) 不可见**是三段式的灵魂：消息此刻已经在驱动机构 NPC 的公允价与
    // 报价（股价先动），但还没进公共 tape、也没经 SSE 广播（玩家只看到异动、看不到原因）。
    //
    // 实现口径 = 「相对公开时刻 t2 提前」：`publicAt = t + leadMax`，各等级在
    // `publicAt - lead[tier]` 起可见。于是
    //   孕育期 = [t0, publicAt − lead_inst)、泄露期 = [.., publicAt)、公开期 = [publicAt, until)。
    lead: {
      insiderMs: 6000, // L0 内幕（机构里再抽 insiderFrac 的一小撮）
      instMs: 4000, // L1 机构（现有 type==='inst' 的聪明钱）
      vipMs: 3000, // L2 情报玩家（招伤满额；按声誉星级 1/4 递进，见 broker.js）
      publicMs: 0, // L3 公众
    },
    // 提前量按 scope 折扣：政策/宏观的内幕就是不存在（恒 0，完全维持现状）；
    // 研报/调研/大宗本来就是机构先知道（全额）；股吧小道本就是传言（打折）
    leadByScope: { 全体: 0, 机构: 1.0, 散户: 0.5 },
    minLeadMs: 1400, // 最小生效提前量；折算后不足此值一律抬到它（否则「名义有、实际看不见」）
    insiderFrac: 0.1, // 机构里再抽多少比例当 L0（10 股各 10 个机构 → 每股 1 个）
    // 异动提示（§7.2 公平窗口）：个股在泄露期出现异动时给公众一条**模糊**提示——
    // 不点方向、不点原因、不说是谁。「偷偷买进」不能是纯黑箱，否则普通玩家只剩被割。
    // minLeftMs > 0 时只在距公开不足那么久才提示（0 = 整个泄露期都提示）
    irregularHint: true,
    irregularHintMinMs: 0,
    // 合规层（§8.2）：泄露期针对该标的的成交额超阈值 → 罚没 / 降级 / 扣星。
    // 前提是「玩家能提前」且渠道是灰色的，所以与内幕购买渠道（v3）同批开，这里默认关
    compliance: {
      enabled: false,
      penaltyRate: 0.4,
      cooldownMs: 60000,
      leakTurnoverLimit: 3000000,
    },
  },

  // 玩家自动化交易（服务端主循环每 tick 驱动，玩家下线照常执行）
  auto: {
    maxPerAccount: 20, // 单账户同时持有的策略数上限（含已完成）
    eventKeep: 8, // 每个策略保留的动作日志条数
    // 定投间隔下限：太短会变成刷单，和下单冷却（2 秒）抢节奏
    dcaMinIntervalMs: 5000,
    grid: {
      minStepPct: 0.3, // 网格间距下限（%）
      maxStepPct: 20, // 网格间距上限（%）
      maxLevels: 50, // 最大格数上限
    },
    ma: {
      minFast: 10, // 快线窗口下限（tick）
      maxFast: 300,
      maxSlow: 900, // 慢线窗口上限（tick）
      minSlowGap: 10, // 慢线至少比快线大这么多 tick
    },
  },

  // 行情数据保留
  market: {
    tradeTapeSize: 500, // 逐笔成交保留条数
    priceHistorySize: 10300, // 分时价格序列（tick 级，约 2 小时 @ 700ms）
    dailyBarsKeep: 260, // 日线（K 线）保留根数：内存与存档同一个上限，约 45 小时的游戏时间
    depthLevels: 5, // 五档盘口
  },

  // ------------------------------------------------------------------
  // 彩蛋（里程碑）
  //
  // 设计见 Doc/彩蛋玩法方案.md。三条纪律写在代码里：
  // ① **只读观测层**：判定一律读账户快照（收盘权益 / 风险度 / 强平通知），绝不回写任何
  //    交易状态——任何一个彩蛋玩法的失败都不应该能影响一次撮合的结果；
  // ② **硬门槛只认收盘结算权益**：一天一次、重启可复现，判定挂在 `Game.settleDay`
  //    （跨天兜底路径 `ensureDaySettled` 也走它）。P0 不做盘中瞬时演出；
  // ③ **只有玩家参与**：NPC 那 3160 个账户一律不判、不落盘（逐 tick 标脏是项目禁忌）。
  //
  // 权益一律用 `game.equityOf`（与 `stateFor` 下发给客户端的是同一个数），前端不许自己重算。
  // 未实现的期（P0 之外）**刻意不写进配置**——配置里出现没人读的键，下一个人会以为它在生效：
  //   全服广播与负面广播开关、股神墙、免息券奖励（P1/P2）、D 族行为彩蛋、C03~C07。
  // ------------------------------------------------------------------
  milestones: {
    enabled: true,
    // 基调：savage（毒舌，默认，与项目整体语气一致）/ gentle / deadpan，见方案 §6
    tone: 'savage',
    // 软着陆（§12 D2）：**收盘权益**跌破这条线后，崩盘/爆仓类文案强制降级为 gentle——
    // 嘲讽的甜区是"还输得起的人"，亏到只剩一成本来就难受，再嘲讽就是劝退
    gentleBelowEquity: 100000,
    // A 族 · 发家线（收盘权益 ≥ 门槛，向上）。**前密后疏**（§12 D1）：
    // 100 万 → 800 万 用密档，新玩家需要高频正反馈才留得住；1000 万 → 10 亿 拉成大目标，
    // 后期要的是"大目标"而不是"连续的小惊喜"。
    // 1 亿 = 「一个小目标」是全局长线主目标：加钱已屏蔽、终身加钱上限也是 1 亿，**只能靠交易赚**
    wealth: [
      { id: 'A01', equity: 1100000, title: '保本出关', level: 'L1', rarity: 'common' },
      { id: 'A02', equity: 1500000, title: '五十个点', level: 'L1', rarity: 'common' },
      { id: 'A03', equity: 2000000, title: '翻倍人生', level: 'L2', rarity: 'common' },
      { id: 'A04', equity: 3000000, title: '三百万', level: 'L2', rarity: 'common' },
      { id: 'A05', equity: 5000000, title: '半个千万', level: 'L2', rarity: 'rare' },
      { id: 'A06', equity: 8000000, title: '八百万', level: 'L2', rarity: 'rare' },
      { id: 'A07', equity: 10000000, title: '千万身家', level: 'L3', rarity: 'rare' },
      { id: 'A08', equity: 20000000, title: '两千万', level: 'L2', rarity: 'rare' },
      { id: 'A09', equity: 50000000, title: '准亿', level: 'L3', rarity: 'epic' },
      { id: 'A10', equity: 100000000, title: '一个小目标', level: 'L4', rarity: 'epic' },
      { id: 'A11', equity: 300000000, title: '三个小目标', level: 'L4', rarity: 'legend' },
      { id: 'A12', equity: 1000000000, title: '封神', level: 'L4', rarity: 'legend' },
    ],
    // B1 族 · 绝对水位跌破（收盘权益 ≤ 门槛，向下）。与 B2 是**两条独立的尺子**，不可混：
    // 从 100 万做到 5000 万又跌回 1000 万的人，绝对水位仍是 +900%（B1 全亮），
    // 但回撤 −80%——那才是他真实的痛。只用一条会漏掉另一半玩家
    absolute: [
      { id: 'B1-01', equity: 900000, title: '出师不利', level: 'L1', rarity: 'common' },
      { id: 'B1-02', equity: 700000, title: '七折促销', level: 'L1', rarity: 'common' },
      { id: 'B1-03', equity: 500000, title: '腰斩', level: 'L2', rarity: 'rare' },
      { id: 'B1-04', equity: 300000, title: '三折清仓', level: 'L2', rarity: 'rare' },
      { id: 'B1-05', equity: 100000, title: '回到起点（方向反了）', level: 'L3', rarity: 'epic' },
      { id: 'B1-06', equity: 10000, title: '一万元户', level: 'L3', rarity: 'epic' },
      { id: 'B1-07', equity: 1000, title: '精确爆仓预备役', level: 'L3', rarity: 'epic' },
      { id: 'B1-08', equity: 0, title: '倒欠券商', level: 'L4', rarity: 'legend' },
    ],
    // B2 族 · 相对峰值回撤（1 − 收盘权益 / peakEquity）。**越过哪档就发哪档**，
    // 每档只发一次（`fired` 是幂等键），所以一段持续下跌会把 30% → 50% → 70% → 90%
    // 依次点亮。早先还有一道"触发后必须回到距峰值 10% 以内才重新武装"的整族闸门
    // （`drawdownRearmAt`），2026-10-17 删除：它和 `fired` 的幂等语义重复，唯一的效果
    // 是把首次越过的更高档一起压掉，让 B2-03/B2-04 几乎不可达。
    drawdown: [
      { id: 'B2-01', pct: 30, title: '回吐', level: 'L1', rarity: 'common' },
      { id: 'B2-02', pct: 50, title: '一夜回到解放前', level: 'L2', rarity: 'rare' },
      { id: 'B2-03', pct: 70, title: '财富蒸发术', level: 'L3', rarity: 'epic' },
      { id: 'B2-04', pct: 90, title: '从 Billionaire 到 Beggar', level: 'L4', rarity: 'legend' },
    ],
    // C 族 · 爆仓线。⚠️ 波动按真实口径收敛后**强平从 66.7 次/天 掉到 0 次/天**，
    // 爆仓在当前参数下是稀有事件（§12 D3 已拍板：不为救频率改风控参数）。
    // 所以 C 族的立族之本是「预警 → 擦边 → 落地」三段链，整局没人爆仓时
    // 「天台初体验」反而是一枚真·勋章。
    liquidation: [
      // 收盘风险度 ≥ 80%（券商风控开始注意你）
      { id: 'C00', kind: 'nearMargin', marginUsage: 80, title: '被风控盯上', level: 'L1', rarity: 'common' },
      // 收盘风险度 ≥ 95% 而**没爆**——差一点就没了。
      // `noLiquidationToday`：当天已经被强平过的人不再给这句（口径是「且没爆」，
      // 爆完再加杠杆回到 95% 的人收到"擦边过关"就是文案打脸）
      { id: 'C01', kind: 'nearMargin', marginUsage: 95, noLiquidationToday: true, title: '擦边过关', level: 'L2', rarity: 'common' },
      // 首次被强平
      { id: 'C02', kind: 'firstLiq', title: '天台初体验', level: 'L3', rarity: 'rare' },
    ],
    // 未播事件队列上限（超出丢旧）。一天跨多档时，丢旧的正好留下最高的那几档
    eventQueueMax: 5,
  },

  // ------------------------------------------------------------------
  // 修仙境界（头衔）—— 设计见 Doc/头衔方案.md
  //
  // 定位：**观测层的第二块屏幕**。彩蛋回答"你刚做成了什么"（瞬时事件），
  // 境界回答"你现在是谁"（持续身份）。零数值特权，不回写任何交易状态。
  //
  // 三条硬约束：
  // ① 门槛一律是**收盘权益**（与彩蛋同函数同取整）——两边各算一遍必然差几毛；
  // ② 判定只在收盘，盘中只做视觉提示（`pending`），否则门槛上横盘会天天闪；
  // ③ 境界事件**不进 `fired`**（跌境后重新破境是正常玩法，同 id 必须能再播）。
  realm: {
    enabled: true,
    // 跌破门槛的 3% 才算跌境：没有缓冲的话，在门槛上横盘（499.8 万 ↔ 500.2 万）
    // 会天天跌境/升境来回播
    demoteBuffer: 0.03,
    // 单日最多降 3 档：从结丹圆满一天崩到炼气会跨 12 级，徽标一次跳 12 级像 bug；
    // 限速之后是"一路跌境"的连续剧
    demoteMaxPerDay: 3,
    // **自检锚点，不参与判定**：开户即得的那一档（炼气二层 = 初始资金 100 万）。
    // 首档 90 万压在开户线下，亏一个板也还是修士；`realm.test.js` 断言
    // `idxOf(account.initialCash) === startIdx`——改了初始资金或阶梯，测试会先拦下来
    startIdx: 2,

    // 九大境界：尊号 + 配色 token。`tone` 只给前端上色用，与涨跌色无关（禁 --red/--green）
    groups: [
      { key: 'lianqi', name: '炼气期', honor: '炼气士', tone: 'lianqi' },
      { key: 'zhuji', name: '筑基期', honor: '筑基修士', tone: 'zhuji' },
      { key: 'jindan', name: '结丹期', honor: '金丹真人', tone: 'jindan' },
      { key: 'yuanying', name: '元婴期', honor: '元婴老祖', tone: 'yuanying' },
      { key: 'huashen', name: '化神期', honor: '化神大能', tone: 'huashen' },
      { key: 'lianxu', name: '炼虚期', honor: '炼虚尊者', tone: 'lianxu' },
      { key: 'heti', name: '合体期', honor: '合体真君', tone: 'heti' },
      { key: 'dacheng', name: '大乘期', honor: '大乘天尊', tone: 'dacheng' },
      { key: 'dujie', name: '渡劫期', honor: '渡劫仙人', tone: 'dujie' },
    ],

    // 38 档，**严格升序**（realm.js 在 require 时校验，配错直接启动失败）。
    // 档距刻意前密后疏：100 万→225 万 塞 8 档（一档 8~12%，一个正常交易日够跨一档），
    // 1000 万以上拉到 25~50%（跨一档要一段像样的行情）。
    // `egg` = 与 A 族发家线**门槛相等**的彩蛋 id：同一天命中时只播境界那条，
    // 彩蛋仍记 fired 与称号（不丢成就），只是不再单独发一条横幅（§3.2 合并播报）
    ladder: [
      { group: 'lianqi', name: '炼气一层', short: '初入山门', equity: 900000 },
      { group: 'lianqi', name: '炼气二层', short: '持牌散修', equity: 1000000 },
      { group: 'lianqi', name: '炼气三层', short: '保本出关', equity: 1100000, egg: 'A01' },
      { group: 'lianqi', name: '炼气四层', short: '小有积蓄', equity: 1220000 },
      { group: 'lianqi', name: '炼气五层', short: '略懂盘感', equity: 1360000 },
      { group: 'lianqi', name: '炼气六层', short: '敢上杠杆', equity: 1520000 },
      { group: 'lianqi', name: '炼气七层', short: '浮盈成习', equity: 1720000 },
      { group: 'lianqi', name: '炼气八层', short: '翻倍修士', equity: 2000000, egg: 'A03' },
      { group: 'lianqi', name: '炼气九层', short: '半步筑基', equity: 2250000 },
      { group: 'zhuji', name: '筑基初期', short: '本金立住', equity: 2600000 },
      { group: 'zhuji', name: '筑基中期', short: '有人求代码', equity: 3200000 },
      { group: 'zhuji', name: '筑基后期', short: '三百万俱往', equity: 4000000 },
      { group: 'zhuji', name: '筑基圆满', short: '半个千万', equity: 5000000, egg: 'A05' },
      { group: 'jindan', name: '结丹初期', short: '初结金丹', equity: 6500000 },
      { group: 'jindan', name: '结丹中期', short: '丹成三品', equity: 8200000 },
      { group: 'jindan', name: '结丹后期', short: '千万身家', equity: 10000000, egg: 'A07' },
      { group: 'jindan', name: '结丹圆满', short: '金丹大成', equity: 13000000 },
      { group: 'yuanying', name: '元婴初期', short: '元婴出窍', equity: 20000000, egg: 'A08' },
      { group: 'yuanying', name: '元婴中期', short: '持股过夜', equity: 26000000 },
      { group: 'yuanying', name: '元婴后期', short: '不看盘也赚', equity: 34000000 },
      { group: 'yuanying', name: '元婴圆满', short: '半个小目标', equity: 45000000 },
      { group: 'huashen', name: '化神初期', short: '神识铺开', equity: 50000000, egg: 'A09' },
      { group: 'huashen', name: '化神中期', short: '加钱已无用', equity: 65000000 },
      { group: 'huashen', name: '化神后期', short: '市场记得你', equity: 80000000 },
      // 1 亿 = 加钱终身上限（`account.deposit.maxLifetime`）：化神之上，钱买不到
      { group: 'huashen', name: '化神圆满', short: '一个小目标', equity: 100000000, egg: 'A10' },
      { group: 'lianxu', name: '炼虚初期', short: '气机外溢', equity: 130000000 },
      { group: 'lianxu', name: '炼虚中期', short: '隔空取物', equity: 180000000 },
      { group: 'lianxu', name: '炼虚后期', short: '能压盘口', equity: 300000000, egg: 'A11' },
      { group: 'lianxu', name: '炼虚圆满', short: '一人成军', equity: 450000000 },
      { group: 'heti', name: '合体初期', short: '人市合一', equity: 600000000 },
      { group: 'heti', name: '合体中期', short: '半个市场', equity: 800000000 },
      { group: 'heti', name: '合体后期', short: '能压指数', equity: 1000000000, egg: 'A12' },
      { group: 'heti', name: '合体圆满', short: '一己之力', equity: 1500000000 },
      { group: 'dacheng', name: '大乘初期', short: '举目无敌', equity: 2000000000 },
      { group: 'dacheng', name: '大乘中期', short: '定义行情', equity: 3000000000 },
      { group: 'dacheng', name: '大乘后期', short: '你就是庄', equity: 4500000000 },
      { group: 'dacheng', name: '大乘圆满', short: '无需看盘', equity: 6500000000 },
      // 90 亿 ≈ 全市场流通市值的 31%：理论存在、实际不会有的终点
      { group: 'dujie', name: '渡劫', short: '一步登天', equity: 9000000000 },
    ],

    // 破境 / 跌境台词。缺省档位走通用模板（realm.js 里拼，含权益数字）。
    // 与彩蛋共用 `milestones.tone` 三档基调 + `gentleBelowEquity` 软着陆规则
    text: {
      up: {
        3: '一百一十万。你终于证明这行饭不是纯靠运气——只证明了一部分。',
        8: '翻倍。翻倍之后最常见的一句话是"我本来还能赚更多"。',
        10: '筑基了。你的本金第一次不需要向任何人解释。',
        13: '五百万。半个千万。听起来已经很像个人物了。',
        14: '金丹成形。从今天起，亏钱也要亏得有排面。',
        16: '一千万。这个数能让你在饭桌上被问"最近买什么"。',
        18: '元婴出窍。理论上你可以不看盘了——实际上你一秒看三次。',
        22: '五千万。加钱已经追不上你了。',
        25: '一个小目标。猫跪着说的：你就是股神。',
        28: '三个小目标。你的仓位已经能左右别人的止损线了。',
        31: '八个亿。全市场十只票，你一个人能买下其中一只的三成。',
        32: '十个亿。服务器装不下你了。',
        34: '二十亿。这个数字在本服只存在于理论上，而你把它变成了事实。',
        38: '九十亿。渡劫成功，或者说——这个市场已经没有你的对手了。',
      },
      down: {
        one: '跌境了。从{from}退回{to}，修为没有白练，钱是真的没了。',
        many: '一日跌{n}境。修仙界管这叫走火入魔，交易界管这叫加杠杆。',
        // {equity} 自带单位（万 / 亿 / 元），后面**不要再写"元"**
        mortal: '道基已碎。你从{from}一路跌回凡骨，还剩 {equity}。',
      },
      // 倒欠券商时替换掉"还剩 N 元"（{debt} 是绝对值，负号加了会读成"倒欠 -5 万"）。
      // 这一条优先于 gentle 软着陆：对倒欠的人说"本金还有机会长出来"是假话
      mortalDebt: '道基已碎。你从{from}跌成凡骨，还倒欠券商 {debt}。',
    },
  },

  // ------------------------------------------------------------------
  // 头像（脸面）—— 见 Doc/头像方案.md
  //
  // 三层合成：底图（玩家在这里选）+ 境界色环（`realm.group`，客户端 CSS 变量）+ 券商角标
  // （`brokers.list.*.color`）。服务端**只存 key、只发 key，永不发路径**——拼 URL 是客户端的事，
  // 配置里一旦能写 URL，`img-src 'self'` 的白名单就形同虚设（方案 §6.3）。
  //
  // 三条纪律（改这个目录前先读一遍）：
  // ① key 一旦上线**永不删除、永不复用**：老档里存着它，删了就是裂图（读到未知 key 回落派生脸）；
  // ② 头像是**静态身份**（长相 / 门派 / 段位），不许编码任何日内状态（盈亏 / 爆仓 / 方向）——
  //    情报红线，见方案 §2.3；
  // ③ 漏登记图片 = 线上 404 裂图：`http.js` 会循环这个 catalog 注册 `-96` / `-192` 两档。
  // ------------------------------------------------------------------
  avatar: {
    enabled: true,
    // 按组下发（客户端弹层按组渲染锁卡）。id 必须与 catalog 的 group 对得上，require 时校验。
    // **只列已经有素材的组**：空组/半成品组会在弹层里显示成一片灰格子，比不做还难看
    groups: [
      { id: 'base', label: '基础', hint: '开户即全部解锁' },
    ],
    // 目录：当前只有**基础 12 张**（素材已进 Client/img，两档齐全）。
    // 待补（代码已就绪，只差素材 + 下面两行配置，不用改任何判定逻辑）：
    //   门派 6 张：{ key:'broker-zhongxin', group:'broker', value:'zhongxin', name:'钟信门面' } …
    //   境界 9 张：{ key:'realm-lianqi', group:'realm', value:'lianqi', name:'炼气·青衫' } …
    //   彩蛋 6 张：{ key:'egg-a07', group:'egg', value:'A07', name:'千万身家' } …
    // 补组时记得同时往 groups 里加一条（group id / label / hint），否则 require 直接报错。
    // `value` 只有 broker / realm / egg 三组需要（分别指向券商 key / 大境界 key / 彩蛋 id）。
    // **每张 key 必须在 Client/img 里有 `-96` 与 `-192` 两档图**，缺一张就启动失败（防裂图）。
    catalog: [
      // ---- 基础组：按「姿态」分类，不按资金量（那是境界干的活）----
      { key: 'clipper', group: 'base', name: '韭菜本菜' },
      { key: 'bull', group: 'base', name: '死多头' },
      { key: 'bear', group: 'base', name: '大空头' },
      { key: 'zen', group: 'base', name: '佛系持仓' },
      { key: 'yolo', group: 'base', name: '梭哈党' },
      { key: 'keyboard', group: 'base', name: '键盘股神' },
      { key: 'auntie', group: 'base', name: '广场舞大妈' },
      { key: 'quant', group: 'base', name: '量化小哥' },
      { key: 'old', group: 'base', name: '老股民' },
      { key: 'student', group: 'base', name: '学生党' },
      { key: 'night', group: 'base', name: '夜盘人格' },
      { key: 'bagholder', group: 'base', name: '高位接盘侠' },
    ],
  },

  // ------------------------------------------------------------------
  // 券商（出身门派）
  //
  // 设计见 Doc/券商方案.md。三条硬约束写在代码里：
  // ① 每家的 overrides 只做「覆盖」——没写的键一律回落到上面的全局默认值
  //    （两级兜底，解析逻辑全在 broker.js，market/npc/auto 只读解析结果）；
  // ② 结构按 N 家设计：加第 7 家只需往 list 里再加一条，前端自适应网格不用改；
  // ③ 每家只强一个维度、只残一个维度，且至少有一项全服垫底（无支配选项）。
  //
  // 只有「额度 / 券源 / 消息提前量」走**声誉星级 1/4 递进**（§9 D7：新手拿到的是
  // 「钟信 Lite」，特权要靠玩出来）；规模与风控属性（冷却、锁仓、强平线、禁买名单、
  // 券息倍率）不随星级变。方向规则见 broker.privilege：**好于基准才递进，差于基准立刻全量**。
  // ------------------------------------------------------------------
  brokers: {
    enabled: true,
    // 策略槽的换算基准：老配置里只有一个「策略总条数」上限（auto.maxPerAccount），
    // 而设计稿按「槽位」说话（基准 2 槽）。两者用比例换算保持等价：
    //   实际条数上限 = round(auto.maxPerAccount × 该券商槽位 / baseSlots)
    // 于是基准券商仍是 20 条（老玩家能力不被削），滑泰 = 40 条（自动化之王）
    baseSlots: 2,

    // 拥挤税档位（乘数）。拥挤度 ≥ min 即落该档，从上往下取第一个命中。
    // 只惩罚「佣金」与「券源」两项——**不做报单延迟**（§9 D4：不做承诺不了的效果）
    crowdTiers: [
      { key: 'heavy', label: '重罚', min: 0.5, feeMul: 1.3, lendMul: 0.7 },
      { key: 'light', label: '轻罚', min: 0.3, feeMul: 1.15, lendMul: 0.85 },
      { key: 'normal', label: '中性', min: 0.2, feeMul: 1, lendMul: 1 },
      { key: 'subsidy', label: '补贴', min: 0, feeMul: 0.8, lendMul: 1, freeCoupons: 1 },
    ],
    // 拥挤度是券商的**固有属性**（虚拟规模档决定的固定值，见 §5.1），
    // 不随本服玩家选择变化——真实占比在小服里就是噪声，只用于选择页展示（§9 D3）
    crowdSource: 'static',

    // 声誉星级（§5.4 / §9 D7）：按**本券商**的累计成交额 + 累计盈利 + 有无爆仓记录评级。
    // 每级解锁该券商特权的 1/4 强度：intensity = min(star, maxPrivilegeStar) / maxPrivilegeStar
    // → 1★ 1/4、2★ 2/4、3★ 3/4、4★ 满额、5★ 同满额（另给「标的方向」）
    star: {
      enabled: true,
      max: 5,
      maxPrivilegeStar: 4, // 到 4★ 特权给满，5★ 只加「方向可见」
      // 从 2★ 起每条给出晋级门槛，必须同时满足 volume/profit 且爆仓次数 ≤ maxLiquidations
      levels: [
        { star: 2, volume: 5000000, profit: 0, maxLiquidations: null },
        { star: 3, volume: 20000000, profit: 100000, maxLiquidations: null },
        { star: 4, volume: 80000000, profit: 500000, maxLiquidations: 0 },
        { star: 5, volume: 300000000, profit: 2000000, maxLiquidations: 0 },
      ],
      // 合规分只做展示（§5.4 提到撤单率，但 §9 D7 的定稿曲线只有量/盈亏/爆仓，
      // 不另造一条没拍过板的降星规则）
      compliance: { cancelRateWarn: 0.8 },
    },

    // 每周之星（§5.5 / §9 D7）：6 家按周轮转、一周一家不重复，
    // 加成 = 佣金减半 + 融资额度 +0.5×，轮换表提前一周在主页公布。
    // 「周」按**交易日**算（游戏内一天 620 秒），所以一周 ≈ 72 分钟真实时间
    weekly: {
      enabled: true,
      daysPerWeek: 7,
      feeMul: 0.5, // 当周之星佣金减半
      financeBonus: 0.5, // 融资额度 +0.5 倍
      order: ['zhongxin', 'huatai', 'zhaoshang', 'tianfeng', 'haitong', 'dongfeng'],
    },

    // 转户（§5.2 / §9 D5）：定位是「认真选一次」的承诺装置，成本要「有点痛但不劝退」
    transfer: {
      feeRate: 0.001, // 转户费 = 总资产 × 0.1%
      feeCap: 50000, // 上限 5 万（大资金不被薅到肉疼，也不至于随便跳）
      cooldownDays: 1, // 转户冷却 1 个交易日
      freeReselectDays: 1, // 免费重选 1 次，且仅限开户后首个交易日内
    },

    // NPC 券商归属（§11.4）——席位系统的**前置条件**（没有它席位表就是空的）。
    // 账户名哈希确定性派生：不落盘、不占存档版本号、不触发逐 tick 标脏，
    // 重启后同一 NPC 仍是同一券商（由账户名重算，见 broker.allocateNpcBrokers）
    npc: {
      enabled: true,
      npcFloor: 4, // 每家券商在该股至少保底几个账户，否则小券商席位会长期缺席
      // 类型倾向：乘在虚拟规模权重上（未列出的券商乘 1）。让「什么资金进什么券商」带上气质
      typeTilt: {
        inst: { zhongxin: 3, haitong: 3, zhaoshang: 3 }, // 大机构求稳、要情报
        hot: { tianfeng: 4, huatai: 4 }, // 游资要杠杆要通道
        big: { zhongxin: 3, zhaoshang: 3 }, // 大户要额度、要消息
        mid: { huatai: 2, dongfeng: 2, haitong: 2 }, // 中户分散
        small: { dongfeng: 4 }, // 散户跟人气、扎堆东风
      },
    },

    // 席位玩法（§11.3）：五档挂单券商、逐笔买卖席位、席位榜/龙虎榜。
    // 数据只喂展示层，**不参与拥挤度计算**（拥挤度是配置里的固有属性）
    seat: {
      enabled: true,
      depthBrokers: 2, // 五档每档显示占比最高的前 N 家券商
      surgePct: 7, // 个股当日涨跌超 ±7% 时披露买卖前五席位
      leaderboardRows: 6, // 席位榜显示家数
      topRows: 5, // 龙虎榜买卖前五
    },

    // 券商榜（§5.3）：总榜 + 券商榜 + 组内榜。冷门券商的组内名次天然更容易靠前，
    // 头部玩家的「争榜」动机因此把人往冷门赶——这是最有效的软分流
    board: { enabled: true, rows: 10 },

    // 六家完整设定。key 与 Client/img/broker-<key>.png 一一对应，前端拼路径直接用
    list: {
      zhongxin: {
        key: 'zhongxin',
        name: '钟信证券',
        abbr: '钟信',
        persona: '大而不倒的老大哥，研报第一，啥都能做，啥都不便宜',
        slogan: '钟信钟信，终会上升',
        color: '#1f5fa8',
        scale: '大',
        targetShare: 0.22,
        virtualClients: 3960, // 万客户（展示用）
        crowd: 0.52, // 拥挤度（固有属性）
        strengths: ['融资额度 2.5×（全服最高）', '保证金比例 40%（最低）', '10 只股票 + 融券池全开放'],
        costs: ['佣金万 3（全服最贵）', '下单冷却 3.0 秒（全服最慢）'],
        suitable: '大资金、做中长线趋势、一天不点几次鼠标的人',
        overrides: {
          feeRate: 0.0003,
          cooldownMs: 3000,
          lockMs: 10000,
          financeRatio: 0.4,
          marginRatio: 0.4,
          lendCapacityMul: 1,
          lendRateMul: 1,
          autoSlots: 2,
          newsVipLeadMs: 0,
          openGift: 0,
          liquidationBuffer: 0.05,
        },
      },
      huatai: {
        key: 'huatai',
        name: '滑泰证券',
        abbr: '滑泰',
        persona: 'App 装机量第一，系统最快，量化接口敞开',
        slogan: '天下武功，唯快不破',
        color: '#2f6fd0',
        scale: '中',
        targetShare: 0.16,
        virtualClients: 2880,
        crowd: 0.34,
        strengths: ['下单冷却 0.5 秒（全服最快）', 'T+锁仓砍半（5 秒）', '自动化策略槽 4 个（基准 2）'],
        costs: ['融资最高仅 1.67×（借钱能力最弱）', '保证金比例 60%（最高）'],
        suitable: '打板、日内高频、挂自动化策略的人',
        overrides: {
          feeRate: 0.00015,
          cooldownMs: 500,
          lockMs: 5000,
          financeRatio: 0.6,
          marginRatio: 0.6,
          lendCapacityMul: 0.9,
          lendRateMul: 1,
          autoSlots: 4,
          newsVipLeadMs: 0,
          openGift: 0,
          liquidationBuffer: 0.05,
        },
      },
      zhaoshang: {
        key: 'zhaoshang',
        name: '招伤证券',
        abbr: '招伤',
        persona: '服务天花板，客户经理天天嘘寒问暖',
        slogan: '您好，我是您的客户经理小张',
        color: '#9b2c2c',
        scale: '中',
        targetShare: 0.14,
        virtualClients: 2520,
        crowd: 0.28,
        strengths: ['消息提前量满额 3 秒（L2 情报，按星级 1/4 递进）', '每日赠送免息券 ×1（当日利息全免）'],
        costs: ['融券券源仅基准的 60%', '券息上浮 1.4×（做空又贵又难借到）'],
        suitable: '做多为主、跟消息面吃饭的人',
        overrides: {
          feeRate: 0.0002,
          cooldownMs: 2000,
          lockMs: 10000,
          financeRatio: 0.5,
          marginRatio: 0.5,
          lendCapacityMul: 0.6,
          lendRateMul: 1.4,
          autoSlots: 2,
          newsVipLeadMs: 3000,
          freeCouponPerDay: 1,
          openGift: 0,
          liquidationBuffer: 0.05,
        },
      },
      tianfeng: {
        key: 'tianfeng',
        name: '天疯证券',
        abbr: '天疯',
        persona: '敢写研报的野生研究所，一天一篇十倍股',
        slogan: '本报告不构成投资建议，因为分析师自己满仓了',
        color: '#d2691e',
        scale: '小',
        targetShare: 0.08,
        virtualClients: 1440,
        crowd: 0.16,
        strengths: ['融资最高 3.33×（全服最高）', '强平维持率放宽到 25%（触发线更松）'],
        costs: [
          '零缓冲强平：破线立即全平，没有预警与缓一档',
          '禁买 600006 筷手集团、600010 理享汽车',
          '佣金万 2.5（拥挤税补贴档后万 2）',
        ],
        suitable: '赌徒、想一夜暴富、喜欢看权益曲线陡上陡下的人',
        overrides: {
          feeRate: 0.00025,
          cooldownMs: 2000,
          lockMs: 8000,
          financeRatio: 0.3,
          marginRatio: 0.3,
          maintenance: 0.25,
          lendCapacityMul: 0.9,
          lendRateMul: 1,
          autoSlots: 3,
          newsVipLeadMs: 0,
          openGift: 50000, // 体验金
        },
        features: {
          zeroBufferLiquidation: true,
          forbidStocks: ['600006', '600010'],
        },
      },
      haitong: {
        key: 'haitong',
        name: '嗨通证券',
        abbr: '嗨通',
        persona: '老牌国企风，什么都不出彩，什么都不卡你',
        slogan: '稳，就一个字',
        color: '#274b6d',
        scale: '偏小',
        targetShare: 0.1,
        virtualClients: 1800,
        crowd: 0.22,
        strengths: ['佣金万 0.5（全服最低，基准的一半）', '无任何隐性费用'],
        costs: [
          '没有任何特权（无提前量、无免息券、策略槽只有基准 2 个）',
          '偶发通道卡顿（约 2% 的下单延迟 1 个 tick）',
        ],
        suitable: '薅费率、交易量极大、长线持有的人',
        overrides: {
          feeRate: 0.00005,
          cooldownMs: 2500,
          lockMs: 10000,
          financeRatio: 0.55,
          marginRatio: 0.55,
          lendCapacityMul: 0.9,
          lendRateMul: 1,
          autoSlots: 2,
          newsVipLeadMs: 0,
          openGift: 0,
          liquidationBuffer: 0.05,
        },
        features: { glitchRate: 0.02 },
      },
      dongfeng: {
        key: 'dongfeng',
        name: '东风财富',
        abbr: '东风',
        persona: '散户大本营，论坛最热闹，人气就是一切',
        slogan: '东风一到，散户报到',
        color: '#c62828',
        scale: '巨大',
        targetShare: 0.3,
        virtualClients: 5400,
        crowd: 0.68,
        strengths: [
          '散户人气 buff：本券商成交量推高该股论坛热度，放大散户 NPC 跟风强度',
          '开户送体验金 · 每日人气任务',
        ],
        costs: ['拥挤税重罚档（佣金 ×1.3、券源 ×0.7）', '风控最弱（强平线最紧，维持率 33%）'],
        suitable: '赚情绪钱、追热点、喜欢热闹的人',
        overrides: {
          feeRate: 0.0001,
          cooldownMs: 1500,
          lockMs: 10000,
          financeRatio: 0.5,
          marginRatio: 0.5,
          maintenance: 0.33,
          lendCapacityMul: 0.9,
          lendRateMul: 1,
          autoSlots: 2,
          newsVipLeadMs: 0,
          openGift: 30000,
          liquidationBuffer: 0.05,
        },
        // 人气 buff（§3.6）：本券商玩家在该股的成交额推高「论坛热度」，
        // 热度再放大该股**散户 NPC 的跟风强度**（做多顺风、做空逆风——放大的是动量跟随，
        // 不是方向）。严格只调制散户的交易行为，不碰公允价值与噪声（项目纪律）
        heat: { enabled: true, refTurnoverPct: 0.02, decayPerTick: 0.004, retailMul: 0.35 },
      },
    },
  },
};

applyLocalLlmFile(config.npc.llm);
// 环境变量最终覆盖：NPC_LLM=1 强制开、=0 强制关（测试与临时关服用）
if (process.env.NPC_LLM === '1') config.npc.llm.enabled = true;
else if (process.env.NPC_LLM === '0') config.npc.llm.enabled = false;
module.exports = config;

