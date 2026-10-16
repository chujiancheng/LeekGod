/**
 * 随机消息系统：利多 / 利空，影响 NPC 情绪与公允价值
 *
 * 另承担**消息分层（信息不对称）**：消息「诞生」不等于「公开」，中间有一段落露期，
 * 只有情报等级够高的参与者（L0 内幕 / L1 机构 / L2 情报玩家）在窗口里读得到它并提前动手。
 * 详见 Doc/消息分层方案.md，落点全在本文件的 visibleFor 与三个读取口。
 */
const config = require('./config');
const { getLogger } = require('./logger');

const log = getLogger('news');

// 情报等级（消息分层方案 §4）。public 是默认等级——**不传 viewer 的老调用一律按公众**，
// 所以引入本机制不会改动任何既有调用方的行为（回归红线，见方案 §10.3）。
const TIERS = ['insider', 'inst', 'vip'];

// 文案按 scope 分池：先定 scope 再取该池文案，避免「机构」scope 播宏观政策这类语义错配。
// 全体 = 大盘（原型是恒生科技指数：港股科技 / 南向资金 / 美联储 / 中概股 / 平台经济）；
// 机构 = 研报 / 调研 / 大宗 / 席位；散户 = 股吧 / 小道 / 情绪。
const TEMPLATES = {
  全体: {
    positive: [
      '美联储降息预期升温，港股科技板块估值迎修复',
      '南向资金单日净买入创阶段新高，科技龙头获集中加仓',
      '隔夜纳斯达克科技股大涨，中概股跟涨情绪传导',
      '港元汇率企稳，香港银行体系流动性明显缓解',
      '平台经济政策环境回暖，监管表态支持健康发展',
      '科技指数放量突破关键点位，做多情绪升温',
      '多家权重龙头公布大额回购计划，股东回报力度加码',
      'AI 产业催化密集，科技权重股集体走强',
      '港股通标的调整生效，被动资金流入在即',
      '中概股回归上市提速，市场关注度显著抬升',
      '人民币汇率走强，外资对中国资产风险偏好修复',
      '海外长线基金上调中国科技资产配置比例',
      '科技指数期货升水扩大，机构看多后市',
      '国内稳增长政策加码，平台经济盈利预期改善',
      '半导体与新能源车数据超预期，产业链共振上涨',
      '权重股密集披露业绩，盈利增速普遍好于预期',
      '南向通额度使用率攀升，内资定价权增强',
      '全球科技股共振上涨，市场风险偏好整体回暖',
      '港股成交额创阶段新高，流动性显著改善',
      '外资投行集体上调中国科技板块评级与目标价',
    ],
    negative: [
      '美联储鹰派表态超预期，港股科技板块承压回落',
      '南向资金大幅净流出，内资集中减持科技龙头',
      '隔夜纳斯达克大跌，中概股集体走弱',
      '港元汇率逼近弱方兑换保证，资金面趋于收紧',
      '平台经济监管传闻再起，市场情绪转向谨慎',
      '科技指数跌破关键支撑位，量能明显背离',
      '中概股退市风险重提，跨境监管担忧升温',
      'AI 主题炒作降温，权重股高位集中回吐',
      '港股成交额持续萎缩，观望情绪浓厚',
      '海外央行超预期加息，全球风险资产普遍承压',
      '人民币汇率走弱，外资流出压力加大',
      '海外长线基金降低中国科技资产配置比例',
      '科技指数期货转为贴水，机构转向谨慎',
      '行业价格战升级，权重股盈利预期被下调',
      '半导体出口管制传闻发酵，产业链集体承压',
      '权重股业绩不及预期，龙头个股集中调整',
      '限售股解禁高峰来临，抛压集中释放',
      '地缘政治扰动升温，全球风险偏好回落',
      '做空比例快速抬升，空头力量加速聚集',
      'IPO 与再融资节奏加快，市场资金面承压',
    ],
  },
  机构: {
    positive: [
      '头部券商上调评级至买入，目标价大幅上修',
      '机构密集调研，关注度显著提升',
      '社保与公募现身股东名单，长线资金进驻',
      '大宗交易溢价成交，承接方为知名私募',
      '龙虎榜机构专用席位净买入居前',
      '获纳入重要指数样本，被动资金将流入',
      '卖方研报一致上修明年盈利预测',
      '定增获机构全额认购，锁价发行落地',
      '主要股东终止减持计划并承诺不减持',
      '调研纪要显示产能利用率超预期',
      '基金重仓名单新增该标的',
      '产业资本增持，释放估值底部信号',
    ],
    negative: [
      '机构专用席位现身龙虎榜卖方，抛压明显',
      '大宗交易折价成交，接盘方为游资席位',
      '卖方研报集体下调盈利预测与目标价',
      '基金减仓报告出炉，重仓比例下降',
      '大股东披露减持计划，规模较大',
      '机构调研后普遍表示谨慎，未见加仓',
      '定增破发，参与机构浮亏',
      '机构专用席位连续多日净卖出',
      '限售股解禁在即，机构持仓面临松动',
      '评级被下调至中性，估值溢价难以维持',
      '长线资金撤离，机构股东席位减少',
      '股权质押比例偏高，机构下调风险评级',
    ],
  },
  散户: {
    positive: [
      '股吧人气飙升，讨论量冲上榜首',
      '传公司订单饱满，产线加班赶工',
      '有消息称大资金正在悄悄吸筹',
      '社区热议该股将迎来主升浪',
      '传闻新产品即将放量，渠道铺货超预期',
      '各路大V集体看多，跟风盘涌入',
      '群里有「内部人士」称月底有重大利好',
      '短线资金抱团迹象明显，跟风买盘活跃',
      '传闻公司将公布高送转方案',
      '打板资金连续上榜，情绪面高涨',
      '有股友晒出满仓截图，引发跟买',
      '小道消息称下季度业绩大幅超预期',
    ],
    negative: [
      '股吧情绪转差，恐慌言论刷屏',
      '有传言称公司财务数据存在瑕疵',
      '社区热议高位放量滞涨，见顶信号明显',
      '群内流传利空传闻，抛压加重',
      '有股友称已清仓离场，引发跟卖',
      '短线资金撤退，跟风盘出现踩踏',
      '传闻核心人员离职，经营存变数',
      '大V提示风险，散户信心动摇',
      '有消息称大股东私下在找接盘方',
      '股吧连续出现看空贴，情绪面恶化',
      '小道消息称监管处罚即将落地',
      '打板资金获利了结，接力盘断档',
    ],
  },
};

// 个股专属文案池：key 用股票的 name（与 config.stocks 对应），每只股票按它的「原型公司」
// 真实业务特征写文案，让消息有辨识度——看文案就知道是哪只股票的事，而不是所有股票共用一套词。
//
//   600001 大米集团 ← 小米集团      600002 腾迅控股 ← 腾讯控股
//   600003 阿狸巴巴 ← 阿里巴巴      600004 梅团集团 ← 美团
//   600005 京冬集团 ← 京东          600006 筷手集团 ← 快手
//   600007 网艺集团 ← 网易          600008 中新国际 ← 中芯国际
//   600009 小朋集团 ← 小鹏汽车      600010 理享汽车 ← 理想汽车
//
// 只覆盖个股消息的两个 scope（机构 = 研报/调研/席位，散户 = 股吧/小道/情绪），
// 每池 8 条；大盘消息（scope=全体）仍走上面的 TEMPLATES。改名要同步这里，否则静默回退通用池。
const STOCK_TEMPLATES = {
  // 小米集团：手机高端化 / IoT 大家电 / 汽车 / 人车家全生态 / 自研芯片
  大米集团: {
    机构: {
      positive: [
        '旗舰机型首销破百万台，高端市场份额再创新高',
        '汽车单月交付创阶段新高，二期工厂产能爬坡超预期',
        '自研芯片流片成功，头部券商上调明年盈利预测',
        '智能大家电出货量居行业前三，IoT 毛利率创新高',
        '人车家全生态落地，机构调研后一致看好协同效应',
        '海外出货逆势增长，卖方研报上调目标价至历史高位',
        '新能源汽车业务毛利率转正，研报密集上修盈利',
        '获纳入重要指数样本，被动资金有望持续流入',
      ],
      negative: [
        '机构专用席位连续净卖出，高位抛压明显',
        '汽车交付延迟引发关注，机构下调季度交付预期',
        '手机份额被竞品挤压，卖方研报集体转向谨慎',
        '海外市场监管新规落地，出海业务面临不确定性',
        '汽车业务亏损扩大，机构下调盈利预测与目标价',
        '汽车业务前期投入大，机构提示现金流承压',
        '大宗交易折价成交，接盘方为游资席位',
        '供应链成本上涨挤压毛利，调研纪要显示态度谨慎',
      ],
    },
    散户: {
      positive: [
        '新车订单排到半年后，交付中心门口排队拍照刷屏',
        '股吧人气冲上榜首，米粉晒出全套生态链订单',
        '传新品发布会定档，直播间预约人数破纪录',
        '有消息称汽车转介绍订单占比创新高，社区热议',
        '创始人直播带货两小时，群内直呼要加仓',
        '小道消息称下季度手机出货量大幅超预期',
        '各路大V集体看多，跟风盘涌入推高人气',
        '有股友晒出满仓截图，引发跟买潮',
      ],
      negative: [
        '汽车交付延期维权贴刷屏，股吧情绪转差',
        '传闻某批次车型将召回，抛压明显加重',
        '社区热议高位放量滞涨，见顶信号明显',
        '有传言称新品良率存在问题，跟风盘踩踏',
        '群里流传海外禁售传闻，恐慌言论刷屏',
        '有股友称新车等太久已退订，引发跟卖',
        '售后投诉集中爆发，大V提示风险',
        '短线资金获利了结，接力盘断档',
      ],
    },
  },

  // 腾讯控股：游戏 / 微信生态 / 视频号广告 / 云 / 大额回购
  腾迅控股: {
    机构: {
      positive: [
        '重磅新游获批版号，机构预计首月流水居前',
        '视频号广告加载率提升，研报上修广告收入预测',
        '公司连续大额回购注销，长线资金进驻股东名单',
        '云业务实现规模化盈利，机构上调分部估值',
        'AI 大模型接入核心产品线，商业化路径获认可',
        '微信生态商业化提速，机构关注广告库存释放',
        '金融科技业务稳健增长，机构重申买入评级',
        '新游储备丰富，机构上调明年游戏收入预测',
      ],
      negative: [
        '游戏版号审批节奏放缓，机构下调新游收入预期',
        '大股东减持传闻发酵，机构关注筹码结构变化',
        '机构席位大幅调仓，抛压集中于互联网权重',
        '反垄断审查传闻发酵，机构提示政策风险',
        '广告业务增速放缓，卖方研报集体下调目标价',
        '游戏流水季节性回落，机构下调季度收入预测',
        '就未成年人保护问题被约谈，机构转向谨慎',
        '游戏行业竞争加剧，机构下调主力产品流水预期',
      ],
    },
    散户: {
      positive: [
        '新皮肤上线首日卖爆，游戏群晒单刷屏',
        '股吧人气飙升，讨论量冲上榜首',
        '传小程序小游戏单月流水破纪录',
        '有消息称分红方案超预期，社区热议加仓',
        '游戏区大V集体推荐新皮肤，跟风盘涌入',
        '群里流传微信新功能内测截图，看多情绪高涨',
        '小道消息称春节档游戏流水将创历史新高',
        '小程序游戏概念被热炒，跟风买盘活跃',
      ],
      negative: [
        '大批账号突遭封禁，股吧骂声一片',
        '传闻某款老游戏即将停服，玩家情绪激动',
        '有传言称新游戏付费设计被喷，口碑崩坏',
        '群内流传人员优化传闻，抛压加重',
        '社区热议用户增长见顶，见顶信号明显',
        '有股友称因账号被封已离场，引发跟卖',
        '大V提示监管风险，散户信心动摇',
        '股吧连续出现唱衰游戏流水的帖子，情绪面恶化',
      ],
    },
  },

  // 阿里巴巴：电商 / 阿里云 / 通义大模型 / 海外 / 股东回报
  阿狸巴巴: {
    机构: {
      positive: [
        '云业务增速回暖超预期，机构上调分部估值',
        'AI 资本开支加码，卖方一致看好算力投入回报',
        '大模型开源下载量居首，机构关注生态卡位',
        '电商成交增速回升，研报上调全年收入预测',
        '公司持续大额回购，长线资金进驻股东名单',
        '机构密集调研云与 AI 业务，关注资本开支回报',
        '海外业务扭亏为盈，机构上修国际分部盈利',
        '通义系列模型接入商家侧，机构关注变现节奏',
      ],
      negative: [
        '电商份额被竞品侵蚀，卖方研报集体下调评级',
        '行业价格战升级，机构下调利润率预测',
        '二股东减持节奏加快，机构测算筹码承接压力',
        '云业务增速不及机构预期，估值溢价难以维持',
        '机构专用席位连续减持电商板块',
        '监管政策不确定性升温，机构提示合规风险',
        '资本开支攀升拖累自由现金流，机构转谨慎',
        '国际业务投入加大，机构下调短期利润预测',
      ],
    },
    散户: {
      positive: [
        '大促预售数据刷屏，股吧直呼超预期',
        '会员权益升级，社区晒单不断',
        '新功能被玩出花，讨论量冲上榜首',
        '有消息称大模型团队在扩招，社区推测有大动作',
        '各路大V集体晒出 AI 应用体验，跟风盘涌入',
        '群里流传内部会议纪要截图，看多情绪高涨',
        '小道消息称下季度财报大幅超预期',
        '电商概念被资金抱团，跟风买盘活跃',
      ],
      negative: [
        '仅退款规则争议刷屏，商家吐槽不断',
        '有传言称平台抽成上调，商家情绪激动',
        '社区热议流量见顶，抛压加重',
        '群内流传组织架构调整传闻，恐慌言论刷屏',
        '有股友称被仅退款规则气到清仓，引发跟卖',
        '大V提示电商竞争加剧，散户信心动摇',
        '股吧连续出现商家吐槽帖，情绪面恶化',
        '传闻活动补贴收紧，跟风盘踩踏',
      ],
    },
  },

  // 美团：外卖 / 即时零售 / 到店酒旅 / 骑手 / 无人机配送
  梅团集团: {
    机构: {
      positive: [
        '外卖单量创历史新高，机构上调全年订单增速',
        '即时零售增速亮眼，卖方研报看好第二增长曲线',
        '到店酒旅利润率回升，机构上修盈利预测',
        '无人机配送试点扩容，机构关注履约成本下降',
        '海外业务扩张超预期，被机构列为长期看点',
        '机构密集调研外卖与闪购业务，关注单位经济模型',
        '新业务亏损收窄，机构重申买入评级',
        '机构新增覆盖即时零售赛道，看好份额提升',
      ],
      negative: [
        '骑手权益新规落地，机构测算履约成本将上升',
        '补贴大战升级，卖方研报下调利润率预测',
        '竞品即时零售快速起量，机构下调份额预期',
        '反垄断处罚传闻发酵，机构提示政策风险',
        '机构席位调仓换股，抛压集中于本地生活权重',
        '竞争格局恶化，机构下调长期份额假设',
        '新业务投入超预期，机构下调自由现金流预测',
        '新业务拖累整体利润率，机构下调全年盈利',
      ],
    },
    散户: {
      positive: [
        '外卖红包雨刷屏，股吧人气飙升',
        '骑手晒出月收入截图，引发热议',
        '传「半小时达」订单量翻倍，社区直呼真香',
        '有消息称外卖会员日补贴将加码，社区热议',
        '各路大V集体晒出外卖神券攻略，跟风盘涌入',
        '群里流传无人机配送视频，看多情绪高涨',
        '小道消息称下季度利润大幅超预期',
        '本地生活概念被资金抱团，跟风买盘活跃',
      ],
      negative: [
        '骑手超时罚款吐槽刷屏，股吧情绪转差',
        '有传言称平台抽成上调，商家集体抱怨',
        '社区热议订单增速放缓，见顶信号明显',
        '群内流传补贴退坡传闻，抛压加重',
        '有股友称外卖订单变少已清仓，引发跟卖',
        '大V提示竞争与监管风险，散户信心动摇',
        '股吧连续出现骑手吐槽帖，情绪面恶化',
        '短线资金获利了结，补贴行情降温',
      ],
    },
  },

  // 京东：自营 3C / 京东物流 / PLUS 会员 / 京东外卖 / 以旧换新
  京冬集团: {
    机构: {
      positive: [
        '物流利润率改善超预期，机构上修分部盈利',
        '以旧换新补贴带动 3C 销量，卖方看好收入弹性',
        '外卖单量突破千万，机构关注用户增长拉动',
        '采销直播模式跑通，研报上调活跃用户预测',
        '公司披露新一轮回购计划，长线资金进驻',
        '机构密集调研仓储与物流网络，关注履约效率',
        '自营供应链效率提升，机构重申买入评级',
        '机构看好以旧换新延续性，上调家电品类收入',
      ],
      negative: [
        '外卖业务投入加大，机构下调短期利润预测',
        '行业价格战延续，卖方研报下调毛利率假设',
        '机构专用席位持续减持，抛压集中于电商板块',
        '大股东减持计划披露，机构关注筹码稳定性',
        '新业务亏损扩大，机构下调自由现金流预测',
        '机构下调全年利润指引预期，投入期拉长',
        '物流成本上升挤压利润，机构转向谨慎',
        '自营模式库存压力上升，机构关注周转效率',
      ],
    },
    散户: {
      positive: [
        '百亿补贴专区刷屏，股吧直呼真香',
        'PLUS 会员权益升级，社区晒单不断',
        '传当日达覆盖率再提升，讨论量冲上榜首',
        '有消息称百亿补贴预算再加码，社区热议',
        '创始人下场送外卖视频刷屏，群内喊话加仓',
        '各路大V集体晒出低价战报，跟风盘涌入',
        '小道消息称大促销售额大幅超预期',
        '低价补贴概念被热炒，跟风买盘活跃',
      ],
      negative: [
        '售后争议集中爆发，股吧情绪转差',
        '有传言称部分订单被单方面取消，客服被骂',
        '社区热议外卖补贴退坡，见顶信号明显',
        '群内流传价格战拖累利润的说法，抛压加重',
        '有股友称被砍单气到清仓，引发跟卖',
        '大V提示外卖烧钱难持续，散户信心动摇',
        '股吧连续出现配送时效吐槽帖，情绪面恶化',
        '短线资金获利了结，外卖行情降温',
      ],
    },
  },

  // 快手：短视频 / 直播电商 / 老铁经济 / 可灵 AI / 出海
  筷手集团: {
    机构: {
      positive: [
        '可灵 AI 商业化提速，机构上修新业务估值',
        '直播电商成交超预期，卖方看好电商货币化率',
        '广告收入提速增长，研报上调全年业绩预测',
        '海外市场用户快速增长，机构列为长期看点',
        '泛货架电商占比提升，机构重申买入评级',
        '机构密集调研直播电商生态，关注货架场占比',
        '毛利率连续多季改善，机构上调目标价',
        '机构新增覆盖短视频出海赛道，看好用户增长',
      ],
      negative: [
        '头部主播带货翻车，机构下调电商成交预期',
        '内容监管趋严，卖方研报提示运营风险',
        '机构席位调仓换股，抛压集中于短视频权重',
        '电商增速放缓，机构下调货币化率假设',
        '大股东减持计划披露，机构关注筹码压力',
        '退货率上升侵蚀毛利，机构下调盈利预测',
        '直播打赏监管新规落地，机构测算收入影响',
        '流量成本上行，机构下调获客效率假设',
      ],
    },
    散户: {
      positive: [
        '老铁直播间人气爆棚，股吧讨论量冲上榜首',
        'AI 生成的短视频刷屏，社区直呼太真了',
        '传某主播一场带货破亿，群内兴奋刷屏',
        '有消息称平台将放大额流量券，社区热议',
        '各路大V集体直播拆箱新品，跟风盘涌入',
        '群里流传新功能内测截图，看多情绪高涨',
        '小道消息称下季度电商收入大幅超预期',
        '直播电商概念被资金抱团，跟风买盘活跃',
      ],
      negative: [
        '带货假货维权刷屏，股吧情绪转差',
        '有传言称头部主播被封禁，抛压加重',
        '社区热议退货率居高不下，见顶信号明显',
        '群内流传充值打赏纠纷，恐慌言论刷屏',
        '有股友称直播退货太多已清仓，引发跟卖',
        '大V提示电商竞争风险，散户信心动摇',
        '股吧连续出现主播翻车吐槽帖，情绪面恶化',
        '短线资金获利了结，直播行情降温',
      ],
    },
  },

  // 网易：游戏 / 暴雪代理 / 云音乐 / 有道 / 游戏出海
  网艺集团: {
    机构: {
      positive: [
        '新游上线首月流水居前，机构上调游戏收入预测',
        '暴雪系列游戏回归，卖方看好用户回流拉动',
        '云音乐实现规模化盈利，机构上修分部估值',
        '游戏出海表现亮眼，研报上调海外收入占比',
        'AI 技术落地音乐与教育业务，机构关注降本效果',
        '机构密集调研新游项目储备，关注流水排期',
        '公司提高分红比例，长线资金进驻股东名单',
        '机构关注 AI 音乐与教育落地，上调新业务估值',
      ],
      negative: [
        '老游戏流水自然下滑，机构下调全年收入预测',
        '新游表现不及预期，卖方研报集体下调目标价',
        '机构席位调仓换股，抛压集中于游戏权重',
        '版号审批节奏放缓，机构下调新游上线预期',
        '大股东减持计划披露，机构关注筹码变化',
        '版权诉讼传闻发酵，机构提示法务风险',
        '游戏买量成本上升，机构下调利润率假设',
        '云音乐会员增速放缓，机构下调分部收入预期',
      ],
    },
    散户: {
      positive: [
        '新游开服排队，股吧讨论量冲上榜首',
        '抽卡出货晒图刷屏，群内直呼欧皇',
        '传某款经典老游戏将回归，玩家情绪高涨',
        '有消息称新资料片将提前上线，社区热议',
        '各路大V集体晒出抽卡战绩，跟风盘涌入',
        '群里流传停服游戏复活传闻，看多情绪高涨',
        '小道消息称下季度流水大幅超预期',
        '游戏概念被资金抱团，跟风买盘活跃',
      ],
      negative: [
        '策划改动惹众怒，股吧骂声一片',
        '有传言称抽卡概率被暗改，玩家维权刷屏',
        '社区热议游戏流水下滑，见顶信号明显',
        '群内流传项目组解散传闻，抛压加重',
        '有股友称抽卡沉船已清仓，引发跟卖',
        '大V提示版号与监管风险，散户信心动摇',
        '股吧连续出现骂策划的帖子，情绪面恶化',
        '短线资金获利了结，新游热度消退',
      ],
    },
  },

  // 中芯国际：晶圆代工 / 成熟制程 / 先进制程 / 扩产 / 国产替代
  中新国际: {
    机构: {
      positive: [
        '成熟制程产能满载，机构上调产能利用率假设',
        '先进制程良率突破，卖方研报上修长期盈利',
        '代工价格上调落地，机构测算毛利率改善',
        '产业基金增持股份，释放长期看好信号',
        '订单排产至明年，机构上调全年收入预测',
        '机构密集调研晶圆产线，关注产能与良率爬坡',
        '国产设备导入顺利，机构看好扩产节奏',
        '机构看好国产设备导入进度，上调资本开支效率',
      ],
      negative: [
        '出口管制传闻加码，机构提示供应链风险',
        '关键设备进口受阻，卖方研报下调扩产预期',
        '机构专用席位连续净卖出，抛压集中于半导体权重',
        '资本开支压力上升，机构下调自由现金流预测',
        '大股东披露减持计划，机构关注解禁抛压',
        '成熟制程价格战开启，机构下调毛利率假设',
        '机构下调稼动率假设，关注下游需求走弱',
        '成熟制程扩产竞争加剧，机构下调价格假设',
      ],
    },
    散户: {
      positive: [
        '国产替代情绪高涨，股吧讨论量冲上榜首',
        '传某制程良率再获突破，群内兴奋刷屏',
        '有消息称大厂追加订单，跟风买盘活跃',
        '有消息称某大厂把订单转回国内，社区热议',
        '各路大V集体科普国产替代，跟风盘涌入',
        '群里流传涨价函截图，看多情绪高涨',
        '小道消息称下季度业绩大幅超预期',
        '半导体概念被资金抱团，讨论量飙升',
      ],
      negative: [
        '出口管制传闻刷屏，股吧情绪转差',
        '有传言称某产线进度不及预期，抛压加重',
        '社区热议产能过剩，见顶信号明显',
        '群内流传产业基金减持的传闻，恐慌言论刷屏',
        '有股友称被管制消息吓到清仓，引发跟卖',
        '大V提示外部环境风险，散户信心动摇',
        '股吧连续出现唱空产能的帖子，情绪面恶化',
        '短线资金获利了结，国产替代行情降温',
      ],
    },
  },

  // 小鹏汽车：智驾 / MONA 走量 / 飞行汽车 / 人形机器人 / 出海
  小朋集团: {
    机构: {
      positive: [
        '单月交付量创新高，机构上调全年交付预测',
        '智驾订阅用户快速攀升，卖方看好软件收入',
        '与头部车企合作深化，机构关注技术输出',
        '人形机器人量产在即，研报新增估值看点',
        '新车型订单超预期，机构上修毛利率预测',
        '机构密集调研智驾技术路线，关注订阅转化率',
        '海外市场交付起量，机构上调出口收入占比',
        '机构新增覆盖机器人业务，看好第二曲线',
      ],
      negative: [
        '交付量不及预期，卖方研报下调全年预测',
        '价格战加剧，机构下调单车毛利假设',
        '智驾系统被指存在误判，机构提示合规风险',
        '机构席位调仓换股，抛压集中于新势力权重',
        '大股东减持计划披露，机构关注减持节奏',
        '研发投入超预期，机构下调自由现金流预测',
        '机构下调销量与毛利预期，价格战压力延续',
        '车型结构变动压低均价，机构下调收入预测',
      ],
    },
    散户: {
      positive: [
        '智驾实测视频刷屏，股吧讨论量冲上榜首',
        '传飞行汽车完成首飞，群内兴奋刷屏',
        '人形机器人走路视频火了，跟风买盘活跃',
        '有消息称新车型锁单量超预期，社区热议',
        '各路大V集体实测城市智驾，跟风盘涌入',
        '群里流传新车型订单截图，看多情绪高涨',
        '小道消息称某新车型将提前上市，社区期待',
        '智驾概念被资金抱团，讨论量飙升',
      ],
      negative: [
        '交付延期引发维权，股吧情绪转差',
        '有传闻称智驾出现事故，抛压加重',
        '社区热议降价伤到老车主，见顶信号明显',
        '群内流传门店关停传闻，恐慌言论刷屏',
        '有股友称智驾事故后已清仓，引发跟卖',
        '大V提示智驾事故负面发酵，散户信心动摇',
        '股吧连续出现智驾吐槽帖，情绪面恶化',
        '短线资金获利了结，智驾热度消退',
      ],
    },
  },

  // 理想汽车：增程 L 系列 / 纯电 / 智驾 / 超充网络 / 奶爸车
  理享汽车: {
    机构: {
      positive: [
        '月交付量突破新高，机构上调全年交付预测',
        '纯电新车订单超预期，卖方看好产品矩阵扩张',
        '超充站加速铺开，机构关注补能生态壁垒',
        '毛利率环比回升，研报上调盈利预测',
        '智驾版本全量推送，机构看好软件变现',
        '机构密集调研纯电与增程产品线，关注订单转化',
        '海外市场开始交付，机构上调出口收入占比',
        '机构看好超充网络护城河，上调长期盈利预期',
      ],
      negative: [
        '纯电车型销量不及预期，机构下调分部预测',
        '纯电车型被曝交付延期，机构提示订单流失风险',
        '价格战加剧，卖方研报下调单车毛利假设',
        '机构席位集中减持，抛压集中于造车新势力',
        '大股东披露减持意向，机构关注抛压时点',
        '新车型上市节奏延后，机构下调季度交付预期',
        '机构下调纯电销量预期，转型节奏慢于同业',
        '渠道扩张成本上升，机构下调费用率假设',
      ],
    },
    散户: {
      positive: [
        '新车型交付中心排队，股吧讨论量冲上榜首',
        '车主晒出长途智驾零接管视频，群内刷屏',
        '传超充站数量翻倍，跟风买盘活跃',
        '有消息称新车型订单排到下季度，社区热议',
        '各路大V集体直播长途自驾，跟风盘涌入',
        '群里流传订单截图，看多情绪高涨',
        '小道消息称新车型将提前交付，社区期待',
        '增程概念被资金抱团，讨论量飙升',
      ],
      negative: [
        '降价维权群刷屏，股吧情绪转差',
        '有传言称纯电车型将停产，抛压加重',
        '社区热议事故视频，见顶信号明显',
        '群内流传订单退订传闻，恐慌言论刷屏',
        '有股友称降价后已割肉清仓，引发跟卖',
        '大V提示纯电转型风险，散户信心动摇',
        '股吧连续出现老车主维权帖，情绪面恶化',
        '短线资金获利了结，新车热度消退',
      ],
    },
  },
};

const SCOPES = ['机构', '散户', '全体'];

// 盘后（夜间）专属文案池：真实市场盘后发的就是公告——业绩、回购、减持、立案、重组。
// 只用于**个股**盘后消息（正文加【简称】前缀套到具体股票）；大盘盘后消息仍走
// TEMPLATES 的「全体」池（隔夜宏观口径本来就是夜里读的）。与其它池一样要求池内无重复。
const ANNOUNCE_TEMPLATES = {
  positive: [
    '披露盈利预喜公告，上半年净利润同比大幅增长',
    '披露股份回购方案，拟回购不超过 5% 股份予以注销',
    '控股股东承诺未来十二个月内不减持',
    '与全球头部云厂商签署多年期算力服务协议',
    '董事会通过高派息方案，股息率创上市以来新高',
    '中标国家级智算中心项目，合同金额可观',
    '主要股东连续三日增持，持股比例上升',
    '获调入港股通标的名单，南向资金可直接买入',
    '披露股权激励计划，行权目标锚定收入高增速',
    '核心产品通过关键资质认证，海外订单可期',
    '公布股份奖励计划，向核心员工授予限制性股份',
    '披露重组进展公告，交易对价与方案落地',
  ],
  negative: [
    '披露盈利预警，上半年净利润同比明显下滑',
    '披露减持计划，大股东拟减持不超过 3% 股份',
    '因涉嫌信息披露违法违规，被证监会立案调查',
    '筹划的重大资产重组宣告终止',
    '计提大额商誉减值准备，影响本期损益',
    '收到交易所问询函，要求说明关联交易事项',
    '主要股东所持股份被司法冻结',
    '披露配售公告，折让约 8% 定增募资',
    '核心产品降价促销，市场担忧毛利率承压',
    '被海外监管机构列入观察名单，业务面临不确定性',
    '披露对外担保逾期公告，涉及金额较大',
    '审计机构对年报出具保留意见',
  ],
};

// 阶段 key → 消息所属时段（客户端消息列表的「盘前 / 午间 / 盘后」标签）。
// 盘中三段（上午/下午/收盘竞价）统一标「盘中」，客户端不额外渲染标签。
const SESSION_OF_PHASE = {
  auction: '盘前',
  morning: '盘中',
  lunch: '午间',
  afternoon: '盘中',
  closeAuction: '盘中',
  night: '盘后',
};

// 各 scope 消息对公允价值的直接定价权重（与 sentiment 的 scope 语义对齐）
const SCOPE_FV_WEIGHT = { 全体: 1, 机构: 0.5, 散户: 0.5 };

// 同一个池内，最近用过的文案不再重复抽取，避免短时间内刷同一条。
// 池子比它小的时候按「池子长度 - 1」收口，保证一轮抽完之前不重复。
const REPEAT_GUARD = 12;

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

class NewsSystem {
  /**
   * @param {Array<{id:string,name:string,alias:string}>} stocks 本局全部股票
   */
  constructor(stocks = []) {
    this.stocks = stocks;
    this.tape = [];
    this.seq = 0;
    this.nextAt = Date.now() + this.randInterval();
    this.nextAtPhase = null; // nextAt 是按哪个阶段排的（null = 还没登记过阶段）
    this.active = []; // [{dir, scope, power, until, stockId, session}]
    this.recentByPool = new Map(); // 池 key -> 最近用过的文案，去重按池独立
    // 泄露期的可观测性（方案 §7.2 的 MVP 验收口径）：记下消息进入泄露期那一刻的价，
    // 公开时算一次漂移并**只落日志不落盘**——用来证明「消息公开前 N 秒价格已开始漂移」。
    this.priceOf = null; // 由 Game 注入的跨股票取价函数
    this.leakLog = []; // 最近若干条泄露期漂移记录（内存，供探针与调试读）
  }

  // ---------------- 消息分层：可见性 ----------------

  /**
   * 一条消息此刻对某个观察者是否可见。
   *
   * **不传 viewer 或 viewer.tier 为 public 时，行为与引入本机制之前逐位一致**：
   * 老调用（含全部既有测试）读到的仍是「诞生即可见」。
   *
   * @param {object} n 消息
   * @param {{tier?:string, leadMs?:number}|null} viewer 观察者；null = 公众
   * @param {number} now
   */
  static visibleFor(n, viewer, now) {
    if (!n) return false;
    // 没有分层字段（老存档、或调用方直接塞进 active 的裸消息）→ 不分层，立即可见。
    // 这是「引入本机制之前的行为」的等价表达，也是消息分层方案 §10.3 #5 的要求
    if (n.publicAt == null) return true;
    if (now >= n.publicAt) return true; // 已公开：人人可见
    const tier = (viewer && viewer.tier) || 'public';
    if (tier === 'public') return false; // 公众只能等到 t2
    // 玩家的 L2 提前量由**券商声誉星级**给（broker.js），所以允许调用方直接覆盖
    const lead = viewer && viewer.leadMs != null
      ? (tier === 'vip' ? viewer.leadMs : 0)
      : (n.lead && n.lead[tier]) || 0;
    return now >= n.publicAt - lead;
  }

  /** 某消息此刻是否仍在泄露期（已对部分人可见、但还没公开） */
  static inLeak(n, now) {
    return !!n && n.publicAt != null && now < n.publicAt;
  }

  /**
   * 下一条消息的间隔。配了阶段规则（config.news.phaseRules）的阶段用它自己的节奏，
   * 否则回退到全局 20~60s。
   * @param {string|null} phaseKey 交易日阶段 key；null（没配时钟）走全局节奏
   */
  randInterval(phaseKey = null) {
    const rule = phaseKey ? config.news.phaseRules && config.news.phaseRules[phaseKey] : null;
    const min = (rule && rule.minIntervalMs) || config.news.minIntervalMs;
    const max = (rule && rule.maxIntervalMs) || config.news.maxIntervalMs;
    return min + Math.floor(Math.random() * Math.max(1, max - min));
  }

  /**
   * 按阶段的 scope 权重抽取消息归属：盘前以「全体」隔夜宏观为主、
   * 午休与盘后偏「机构」（公告/公告解读），盘中均匀抽（没配规则时恒均匀）。
   * @param {string|null} phaseKey
   */
  pickScope(phaseKey = null) {
    const rule = phaseKey ? config.news.phaseRules && config.news.phaseRules[phaseKey] : null;
    const w = rule && rule.scopeWeights;
    if (!w) return pick(SCOPES);
    let total = 0;
    for (const s of SCOPES) total += w[s] || 0;
    if (total <= 0) return pick(SCOPES);
    let r = Math.random() * total;
    for (const s of SCOPES) {
      r -= w[s] || 0;
      if (r <= 0) return s;
    }
    return SCOPES[SCOPES.length - 1]; // 浮点误差兜底
  }

  /** 从池里抽一条文案并记入该池的去重窗口（REPEAT_GUARD 内不重复） */
  drawFrom(pool, poolKey) {
    const recent = new Set(this.recentByPool.get(poolKey) || []);
    const fresh = pool.filter((text) => !recent.has(text));
    const text = pick(fresh.length ? fresh : pool);

    const hist = this.recentByPool.get(poolKey) || [];
    hist.unshift(text);
    const cap = Math.min(REPEAT_GUARD, Math.max(1, pool.length - 1));
    if (hist.length > cap) hist.length = cap;
    this.recentByPool.set(poolKey, hist);
    return text;
  }

  /**
   * 取文案。个股消息优先用该股票的专属池（STOCK_TEMPLATES，按原型公司的业务写），
   * 没配专属池的股票回退到按 scope 分的通用池。
   *
   * 去重按「池」独立记录，而不是扫磁带里最近若干条文本——个股文案带【简称】前缀，
   * 且十只股票各有池子，混在一个窗口里比会让每只股票实际能用的文案变少。
   *
   * @param {'机构'|'散户'|'全体'} scope
   * @param {number} dir 1 利好 / -1 利空
   * @param {{id:string,name:string,alias:string}|null} stock 个股消息的目标股票；大盘消息传 null
   * @param {string|null} session 所属时段（盘前/盘中/午间/盘后）；「盘后」的个股消息走公告池
   */
  pickText(scope, dir, stock = null, session = null) {
    const key = dir > 0 ? 'positive' : 'negative';

    // 盘后（夜间）的个股消息一律走「盘后公告」池：这个时段真实市场发的就是公告，
    // 与哪家公司无关的通用公告正文加【简称】前缀即可；大盘消息仍走「全体」池。
    if (session === '盘后' && stock) {
      return this.drawFrom(ANNOUNCE_TEMPLATES[key], `公告|${key}`);
    }

    const own = stock ? STOCK_TEMPLATES[stock.name] : null;
    const ownPool = own && own[scope] ? own[scope][key] : null;
    const pooled = ownPool && ownPool.length;
    const pool = pooled ? ownPool : TEMPLATES[scope][key];
    const poolKey = pooled ? `${stock.name}|${scope}|${key}` : `*|${scope}|${key}`;
    return this.drawFrom(pool, poolKey);
  }

  /**
   * 每 tick 调用，按计划产出消息
   *
   * 多股票下消息分两种：
   * - **大盘消息**（scope=全体，政策/宏观）：作用于全部股票，指数因此有系统性涨跌
   * - **个股消息**（scope=机构/散户）：挂到随机一只股票上，文案前缀【简称】，
   *   只影响那一只的情绪与公允价
   * 这只是语义归属，不影响 power/until/衰减等既有机制。
   *
   * 阶段感知（config.news.phaseRules）：
   * - **换阶段重新排队**：上一段排出的倒计时可能整段吞掉新阶段（下午末尾排出的
   *   +60s 会把 40 秒的夜间整个错过），所以进入新阶段就按它自己的节奏重排；
   *   首次调用只登记阶段不重排（构造时已排过队）。
   * - **untilFloor**：作用期下限。盘后消息由调用方抬到次日开盘竞价结束——
   *   否则 60s 墙钟会在夜间结束前就过期，隔夜公允价值迁移与次日竞价的情绪
   *   全都吃不到它，「盘后公告影响次日开盘」就不成立。
   *
   * @param {number} now
   * @param {number} [dirBias] 概率偏移：p(利好) = 0.5 + dirBias。
   *   调用方传 regime × regimeBias（如 0.2 → 牛市 70% 利好）
   * @param {{phaseKey?: string|null, untilFloor?: number}} [opts] 当前交易日阶段与作用期下限
   */
  maybeEmit(now, dirBias = 0, opts = {}) {
    const phaseKey = opts.phaseKey || null;
    const untilFloor = opts.untilFloor || 0;
    if (this.nextAtPhase !== null && phaseKey !== this.nextAtPhase) {
      this.nextAt = now + this.randInterval(phaseKey);
    }
    this.nextAtPhase = phaseKey;
    if (now < this.nextAt) return null;
    this.nextAt = now + this.randInterval(phaseKey);

    const pPositive = Math.max(0, Math.min(1, 0.5 + dirBias));
    const dir = Math.random() < pPositive ? 1 : -1;
    const scope = this.pickScope(phaseKey);
    const power = 0.3 + Math.random() * 0.5;
    const session = phaseKey ? SESSION_OF_PHASE[phaseKey] || null : null;
    // 全体 = 大盘消息（不带股票）；机构/散户 = 个股消息，随机挂一只
    const stock = scope === '全体' || !this.stocks.length ? null : pick(this.stocks);
    const text = stock
      ? `【${stock.alias}】${this.pickText(scope, dir, stock, session)}`
      : this.pickText(scope, dir, null, session);
    this.seq += 1;
    const lead = this.leadsFor(scope);
    const news = {
      id: 'N' + this.seq,
      t: now,
      dir, // 1 利好 / -1 利空
      type: dir > 0 ? '利好' : '利空',
      scope,
      power,
      stockId: stock ? stock.id : null,
      stockName: stock ? stock.name : null,
      text,
      session, // 盘前 / 盘中 / 午间 / 盘后（客户端标签；无时钟时为 null）
      until: Math.max(now + config.news.durationMs, untilFloor),
      // ---- 消息分层：公开时刻与各等级提前量 ----
      // 各等级的**可见起点** = publicAt − lead[tier]，于是：
      //   孕育期 = [t, publicAt − lead_inst)、泄露期 = [.., publicAt)、公开期 = [publicAt, until)
      // 折算后全员 lead 为 0（scope=全体，或没配时钟）→ publicAt = t，
      // 于是「诞生即可见、人人同时知道」，与引入本机制之前完全一致。
      lead,
      publicAt: now + Math.max(0, lead.insider, lead.inst, lead.vip),
    };
    this.tape.unshift(news);
    if (this.tape.length > config.news.tapeSize) this.tape.length = config.news.tapeSize;
    this.active.push(news);
    this.active = this.active.filter((n) => n.until > now);
    return news;
  }

  /**
   * 某 scope 下各等级的提前量（已按 scope 折扣并做最小生效值夹取）。
   *
   * **`全体`（大盘宏观）恒为 0**：政策/宏观没有内幕可言，强给提前量既不真实、
   * 又会让指数在泄露期整体漂移（10 只一起动，观感像「大盘抽风」）。
   */
  leadsFor(scope) {
    const lc = config.news.lead || {};
    const mul = (config.news.leadByScope || {})[scope];
    const q = (ms) => {
      const v = (Number(ms) || 0) * (mul == null ? 0 : mul);
      return v <= 0 ? 0 : Math.max(v, config.news.minLeadMs || 0);
    };
    return { insider: q(lc.insiderMs), inst: q(lc.instMs), vip: q(lc.vipMs) };
  }

  /**
   * 该消息是否作用于某只股票：大盘消息作用于全部，个股消息只作用于它自己
   * @param {*} n 消息（this.active 里的元素）
   * @param {string|null} stockId 目标股票；null 表示不限股票（只算大盘消息）
   */
  static applies(n, stockId) {
    if (!n.stockId) return true; // 大盘消息
    if (!stockId) return false;
    return n.stockId === stockId;
  }

  /** 某群体在某只股票上的当前情绪叠加 [-1, 1] */
  sentiment(scope, now, stockId = null, viewer = null) {
    let s = 0;
    for (const n of this.active) {
      if (n.until <= now) continue;
      if (!NewsSystem.visibleFor(n, viewer, now)) continue; // 还没轮到这一级看见
      if (n.scope !== '全体' && n.scope !== scope) continue;
      if (!NewsSystem.applies(n, stockId)) continue;
      // 影响随时间线性衰减
      const remain = (n.until - now) / config.news.durationMs;
      s += n.dir * n.power * remain;
    }
    return Math.max(-1, Math.min(1, s));
  }

  /**
   * 按 scope 分解某只股票的当前情绪。机构做「公开消息对倒」时需要看见散户盘情绪，
   * 而不是只看自己 scope——利好出货、利空吸筹的前提是知道散户在追什么。
   * @returns {{ all: number, inst: number, retail: number }}
   */
  sentimentByScope(now, stockId = null, viewer = null) {
    let all = 0;
    let inst = 0;
    let retail = 0;
    for (const n of this.active) {
      if (n.until <= now) continue;
      if (!NewsSystem.visibleFor(n, viewer, now)) continue;
      if (!NewsSystem.applies(n, stockId)) continue;
      const remain = (n.until - now) / config.news.durationMs;
      const c = n.dir * n.power * remain;
      if (n.scope === '全体') all += c;
      else if (n.scope === '机构') inst += c;
      else retail += c;
    }
    const clamp = (x) => Math.max(-1, Math.min(1, x));
    return { all: clamp(all), inst: clamp(inst), retail: clamp(retail) };
  }

  /**
   * 消息对某只股票公允价值的每 tick 相对推力（调用方按 fv *= 1 + 推力 消费）。
   * scope 与 sentiment() 保持同一语义：「全体」消息全额直接定价，
   * 只覆盖单一群体的消息只按其群体打折定价。
   */
  fvDrift(now, stockId = null, viewer = null) {
    let d = 0;
    for (const n of this.active) {
      if (n.until <= now) continue;
      if (!NewsSystem.visibleFor(n, viewer, now)) continue;
      if (!NewsSystem.applies(n, stockId)) continue;
      const remain = (n.until - now) / config.news.durationMs;
      d += n.dir * n.power * remain * config.news.fvDriftCoef * (SCOPE_FV_WEIGHT[n.scope] ?? 0.5);
    }
    return d;
  }

  /**
   * 消息磁带快照（下发给客户端的那一份）。
   *
   * **泄露期的消息绝不出现在公众视野里**——这正是三段式的灵魂：
   * 玩家只看到价格莫名异动，看不到原因。老数据没有 `publicAt`（老存档），
   * 视为「立即可见」，行为与引入本机制之前一致。
   *
   * @param {number} limit
   * @param {number} now
   * @param {{tier?:string, leadMs?:number, showDir?:boolean, viewerName?:string}} [viewer]
   *   tier='vip' + leadMs 时，券商客户能在公开前看到**该股有事**；方向是否可见取决于
   *   声誉星级是否到 maxPrivilegeStar（§8.1：4★ 给满额提前量，5★ 才给「标的方向」）。
   */
  tapeSnapshot(limit = 50, now = Date.now(), viewer = null) {
    const pub = (n) => n.publicAt == null || n.publicAt <= now;
    if (!viewer || viewer.tier !== 'vip' || !(viewer.leadMs > 0)) {
      return this.tape.filter(pub).slice(0, limit);
    }
    const out = [];
    for (const n of this.tape) {
      if (out.length >= limit) break;
      if (pub(n)) {
        out.push(n);
        continue;
      }
      if (now < n.publicAt - viewer.leadMs) continue; // 连泄露窗口都没进
      out.push(viewer.showDir ? { ...n, early: true } : maskLeaked(n));
    }
    return out;
  }

  /**
   * 泄露期的可观测性指标（方案 §7.2 / §11 MVP 验收口径）：**只落日志不落盘**。
   * 让「消息公开前 N 秒价格已开始漂移」这件事可被验证，而不是靠感觉。
   * @param {number} now
   */
  noteLeakDrift(now = Date.now()) {
    if (!this.priceOf) return;
    for (const n of this.active) {
      if (n.publicAt == null) continue;
      const l = n.lead || {};
      const maxLead = Math.max(l.insider || 0, l.inst || 0, l.vip || 0);
      if (!(maxLead > 0)) continue;
      // 进入泄露期的那一刻记下价格（取该消息最早可见等级的起点）
      if (n.leakAt == null && now >= n.publicAt - maxLead && now < n.publicAt) {
        n.leakAt = now;
        n.leakPrice = this.priceOf(n.stockId);
      }
      // 公开那一刻结算一次漂移
      if (!n.leakLogged && n.leakPrice > 0 && now >= n.publicAt) {
        n.leakLogged = true;
        const p = this.priceOf(n.stockId);
        const driftPct = p > 0 ? ((p - n.leakPrice) / n.leakPrice) * 100 : 0;
        const rec = {
          id: n.id,
          stockId: n.stockId,
          scope: n.scope,
          dir: n.dir,
          leakMs: n.publicAt - n.leakAt,
          driftPct: Math.round(driftPct * 1000) / 1000,
        };
        this.leakLog.unshift(rec);
        if (this.leakLog.length > 50) this.leakLog.length = 50;
        log.info(
          `[消息分层] ${n.id} 公开：${n.stockId || '大盘'} ${n.type}，泄露期 ${rec.leakMs}ms 内价格漂移 ${rec.driftPct.toFixed(3)}%`
        );
      }
    }
  }

  /** 泄露期的消息里，有哪些个股正在异动（供 §7.2 模糊提示用） */
  leakingStocks(now = Date.now()) {
    const out = new Map();
    for (const n of this.active) {
      if (n.until <= now) continue;
      if (n.publicAt == null || n.publicAt <= now) continue;
      if (!n.stockId) continue; // 大盘消息不提示（它本来就没有提前量）
      const left = n.publicAt - now;
      const prev = out.get(n.stockId);
      if (!prev || left < prev.leftMs) out.set(n.stockId, { stockId: n.stockId, stockName: n.stockName, leftMs: left });
    }
    return out;
  }
}

/**
 * 泄露期消息对**未达 5★** 的情报玩家遮蔽成「知道有事、不知道方向」。
 * 设计稿 §8.1：4★ 给满额提前量但「不给强度」，5★ 才额外给「标的方向」。
 * 所以提前量本身是能看见「哪只股票有消息」的——那也是招伤最值钱的地方。
 */
function maskLeaked(n) {
  return {
    id: n.id,
    t: n.t,
    dir: 0,
    type: '未明',
    scope: n.scope,
    power: 0,
    stockId: n.stockId,
    stockName: n.stockName,
    text: n.stockName ? `【${n.stockName}】出现未公开信息，方向待确认` : '出现未公开信息，方向待确认',
    session: n.session,
    until: n.publicAt,
    publicAt: n.publicAt,
    early: true, // 公开前拿到 → 客户端标「内幕」并给倒计时
    masked: true,
  };
}

module.exports = { NewsSystem, TEMPLATES, STOCK_TEMPLATES, ANNOUNCE_TEMPLATES };
