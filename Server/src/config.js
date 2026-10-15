/**
 * 全局配置（均可按需调整）
 */
module.exports = {
  // 服务端口（server.py 会读取环境变量 PORT 展示，这里保持一致）
  port: parseInt(process.env.PORT || '3000', 10),

  // 日志等级：trace / debug / info / warn / error / fatal（可用环境变量 LOG_LEVEL 覆盖）
  log: {
    level: process.env.LOG_LEVEL || 'info',
  },

  // 持久化（账号 / 持仓 / 活动委托 / 成交流水 / 令牌 / 行情断点）
  persistence: {
    enabled: process.env.PERSIST !== '0',
    // 相对 Server 目录；想开新一局直接删掉这个文件
    file: process.env.PERSIST_FILE || 'data/game.db',
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
    name: '大盘指数',
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
      holders: { limit: 60, windowMs: 60000 }, // 股东占比走势（点击前十名时按需拉取）
      admin: { limit: 10, windowMs: 60000 },
    },
    // SSE 长连接上限
    sse: {
      maxConnections: 500,
      maxPerIp: 20,
    },
  },

  // 做空保证金
  margin: {
    ratio: 0.5, // 开空冻结 = 卖出市值 * 50%；开空预检同样按此比例卡权益 → 敞口上限 2 倍
    maintenance: 0.3, // 维持保证金率 30%，跌破即爆仓强平
    liquidationSlippage: 0.005, // 强平撮合不到对手盘时的系统兜底滑点
    // allowNakedShort=true：裸空后门（不借券即可开空，无券源上限、不计息）。
    // 默认 false：开空必须从融券池借券，可借不足直接拒单。
    allowNakedShort: false,
    // 融券池：玩家/NPC 把可卖持仓挂借生息，空头借券开仓并按 tick 付息。
    // 利率随池子紧张度上升：s = 已借出 / 总挂借，分钟息 = base × (1 + s × stressK)，封顶 maxMinuteRate。
    // 游戏节奏按分钟走，不用日息——0.01%/分钟 ≈ 14.4%/日，数值也看得见。
    // 空头现金与保证金都扣不动时利息挂账（lendInterestDebt）：计入权益，现金恢复后追缴给出借方。
    lending: {
      enabled: true,
      npcLendRatio: 0.3, // NPC 开服/加载时自动出借的持仓比例
      baseMinuteRate: 0.0001, // 基础 0.01%/分钟（池子空闲时）
      stressK: 3, // 满借时利率上浮到 base × 4（0.04%/分钟）
      maxMinuteRate: 0.0004, // 封顶 0.04%/分钟
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

  // 涨跌停（保留功能，默认关闭）
  priceLimit: {
    enabled: false,
    pct: 0.1, // 相对昨收（本局开盘价）±10%
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
    // 趋势阶段（牛 / 震荡 / 熊）——对数空间推力，参考港股小米集团式行情：
    // 大级别能翻几倍、也能腰斩再腰斩——甚至翻十倍、跌到十分之一，
    // 幅度本身由随机趋势段决定、不是固定目标，顶底均无法预判：
    // - 阶段时长指数分布（无记忆）：已走多久推不出还要走多久
    // - 方向每次重新抽签，顶底常是假突破后的延续或反杀
    // - 幅度三档混合：温和为主、偶尔极端（极端段给出数倍级行情）
    trend: {
      phaseMinTicks: 45, // 阶段最短 ~30 秒
      phaseMeanTicks: 260, // 时长均值 ~3 分钟（指数分布）
      phaseMaxTicks: 1200, // 时长硬上限 ~14 分钟
      flatWeight: 0.3, // 抽中震荡阶段（g=0）的概率
      weights: [0.62, 0.3, 0.08], // 温和 / 强 / 极端 的抽中权重
      bands: [
        [0.0003, 0.0015], // 温和：单阶段 ±8%~40%
        [0.0015, 0.0045], // 强：单阶段 ±50%~2 倍量级
        [0.0045, 0.009], // 极端：单段就能给数倍 / 腰斩，连排可到十倍 / 十分之一
      ],
    },
    // 基本面重心：随趋势慢一拍迁移，再以约 15 分钟时间常数回归发行价
    // （对数空间回归，涨十倍与跌到十分之一的拉回对称；比旧版 70 秒锚慢一个数量级）
    fundTrendFollow: 0.7,
    fundAnchor: 0.0008,
    fundNoiseRel: 0.0006,
    // 公允价值向重心回归 / 向最新价跟随的强度
    fvAnchor: 0.025,
    priceCoupling: 0.04,
    noiseRel: 0.0012, // 每 tick 相对噪声（管毛刺，不管趋势）
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
    // NPC 流动性回收：全池现金（不含保证金/冻结）低于地板价时按比例回补。
    // 空头保证金会把全池现金吸干（开空时现金的一半进保证金），现金归零后
    // 没人买得动、盘面双向死锁——回补就是给做市商池子的"活水"，只补到地板不注水
    liquidityFloor: 42000000,
    liquidityRefill: 0.02, // 每 tick 向地板回补剩余缺口的比例（~2 分钟补满）
    // NPC 撤单/重新报价的最小间隔（tick 数）
    minRequoteTicks: 1,
    // 游资/散户追涨杀跌的动量窗口（tick 数，约 1 分钟）：看最近一段涨跌幅而不是
    // vs 重心的偏离——顶部一旦横盘动量归零，情绪才能轮动出卖家，不会全员死多。
    // 各类强度 = momentumGain × types[x].momentumGainMul
    momentumTicks: 90,
    momentumGain: 2,
    momentumClamp: 0.3,
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
    // 0.2 → 牛市阶段 70% 消息利好、熊市阶段 70% 利空，让消息面与走势互相印证
    regimeBias: 0.2,
    tapeSize: 200, // 客户端消息列表保留条数
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
    depthLevels: 5, // 五档盘口
  },
};
