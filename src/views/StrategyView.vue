<script setup>
import { computed } from 'vue'
import { useCatalysts } from '../lib/catalysts'

const props = defineProps({
  dashboard: { type: Object, default: null }
})

const { verifiedCount } = useCatalysts()

const mantra = [
  '先定主线，再选个股；无主线，空仓等待。',
  '先寻主线再寻龙，二板筛选三分清。',
  '早盘封板领群雄，题材纯正不蹭风。',
  '良性换手强承接，一拉板块众跟风。',
  '分歧买入一致卖，高位爆量要收工。',
  '破位止损不扛单，退潮空仓莫强攻。'
]

const gates = [
  {
    no: '01',
    title: '主线关 · 连续两日靠前',
    body:
      '今日与昨日涨停家数都 ≥ 2，且进入家数排名前列。冷门板块偶发一日涨停，没有昨日的资金记忆，不构成主线。',
    check: '对应数据：sectors.mainCandidates / checks.continuity'
  },
  {
    no: '02',
    title: '梯队关 · 高中有低',
    body:
      '同一板块内同时存在高位连板（≥3 板）、中位二板、低位首板。只有一只票孤零零上涨，是独苗，不是板块效应。',
    check: '对应数据：ladder.high / mid / first 与 complete'
  },
  {
    no: '03',
    title: '资金承接关 · 四项证据',
    body:
      '不再只看“连续两日主力净流入”一条线，而是核对四项证据：① 主力资金今、昨两日真实净流入；② 量能，同股今日成交额 ≥ 昨日 75%；③ 封单，涨停股封单合计 / 流通市值 ≥ 0.5%；④ 溢价 / 晋级，昨日涨停股今日平均溢价为正且板块晋级率 ≥ 30%。至少 3 项成立、且主力资金不硬性转负才通过。',
    check: '对应数据：checks.money.evidence（主力资金 / 量能 / 封单 / 溢价晋级）'
  },
  {
    no: '04',
    title: '催化关 · 题材纯正（人工）',
    body:
      '政策文件、产业订单/涨价/技术突破、事件驱动，至少有一项可核实证据。纯传闻、无信源小作文、蹭热点改名，直接排除。未核验催化的个股只显示观察分，不解除观察状态；数据三关不替代人工催化核验。',
    check: '对应动作：每个板块右上角「催化核验」，人工标记'
  }
]

const sentimentWindows = [
  ['进攻窗口', '晋级率 ≥35%、炸板率 <35%、昨日溢价 ≥0、最高板 ≥3，且首板与中位板仍有接力。此时才允许提高观察优先级。'],
  ['观察窗口', '数据介于进攻与防守之间：可以跟踪最强核心，但不把仓位打满，不追一致加速。'],
  ['防守窗口', '炸板率 ≥45%，或晋级率 <25%，或昨日溢价转负且炸板率 ≥30%。降频、空仓，不接高位断板。']
]

const weakLadder = [
  ['跌停反包', 92, '昨日跌停，今日回封或盘中转强。最极端的弱转强，必须结合板块与催化，不单独作为买入理由。'],
  ['炸板回封', 86, '昨日炸板未封，今日重新封板 / 转强，说明昨日抛压被资金承接。'],
  ['烂板转强', 78, '昨日封板但炸过，今日封得更干净；筹码换手后转强。'],
  ['连板晋级', 66, 'N 板 → N+1 板。按高度、封板时间与封单质量确认，不把晋级本身当利好。'],
  ['封板提速', 64, '首封时间比昨日提前 ≥30 分钟，主动性增强。'],
  ['强转强', 56, '昨日涨停，今日延续强势；没有额外惊喜，只算基础项。'],
  ['新晋涨停', 48, '首板或缺少昨日样本，必须等次日二板确认，不参与第一天的一致。']
]

const geneFactors = [
  ['情绪环境', 15, '冰点 34 / 退潮 48 / 混沌 66 / 修复 84 / 主升 94；进攻信号 +6，防守信号 -10。'],
  ['板块地位', 18, '三关就绪 96 起，按通过关数、龙头身份、板块最高板加分。'],
  ['弱转强', 22, '按左侧 48–92 分映射；盘中未封板时叠加距涨停强度。'],
  ['封板质量', 20, '首封时间 50% + 封单占流通 40% + 炸板扣分 10%；未封板时看近板与量能。'],
  ['筹码结构', 10, '换手 3%–20% 为良性；流通市值 50–300 亿更适配短线。'],
  ['历史画像', 15, '六维分桶样本延续率合成；少于 3 条样本的桶不参与加权。']
]

const coreTiers = [
  ['核心先锋', '2–5 板，0 炸板，封单 ≥1.5% 流通，换手 3%–20%，首封不晚于 10:30，板块地位靠前。准备池优先，但仍需三关与催化核验。'],
  ['分歧转强', '有 1–2 次炸板或换手 20%–30%，但当天仍回封。只给观察位，次日竞价确认承接后才考虑。'],
  ['容量中军', '流通 ≥80 亿且成交 ≥10 亿，或流通 ≥200 亿。容纳大资金但短线弹性弱，不能当连板先锋用。'],
  ['高位分歧', '5 板以上且多次炸板，或换手 ≥35%。只观察，不接力，不占用核心仓位。']
]

const nodeTiers = [
  ['破局龙', '修复 / 主升期的市场空间板（最高板 ≥3），负责打开高度；封板必须干净，炸板多或爆量只验证。'],
  ['空间板', '与市场最高板同高，是情绪高度的锚；高位空间板若炸板 ≥3 次或换手 ≥35%，标签降为「高位空间板」并只观察。'],
  ['卡位节点', '距空间板 1 板且自身 ≥3 板；龙头分歧时第一顺位卡位，次日看谁先封板。'],
  ['转势板', '昨日跌停 / 炸板 / 烂板，今日回封或转强；情绪由冰点转修复时的关键节点。'],
  ['梯队节点', '距空间板 2 板的中位连板；只在板块三关与强封条件下使用。'],
  ['补涨节点', '空间板之外的低位强封核心（2 板、0 炸、封单厚、换手低）；走补涨 / 接力，不追高。'],
  ['梯队跟随', '距空间板 ≥3 板且封板质量一般；只解释，不占准备池前排。'],
  ['高位空间板', '5 板以上或与最高板同高，但炸板 ≥3 次或换手 ≥35%；节点价值高但风险更大，只观察。']
]

const nodeFactors = [
  ['情绪适配', 10, '冰点 20 / 退潮 36 / 混沌 56 / 修复 74 / 主升 88，再按进攻、溢价、晋级率、炸板率修正。'],
  ['节点票', 12, '空间 / 卡位 / 转势 / 补涨等结构分；炸板与过热换手会在节点分里再打折。'],
  ['连板高度', 10, '相对市场空间板打分：同高或离顶 1 板最优先，离顶 ≥3 板只是跟随。'],
  ['流通市值', 6, '50–120 亿最适配短线；200 亿以上按中军降权，500 亿以上明显降权。']
]

const roles = [
  {
    key: 'dragon',
    name: '情绪连板龙',
    tag: '高度 · 封板 · 带动性',
    body:
      '板块的情绪核心，不一定是涨幅最大，但一定是封板最早、封单最硬、连板最高，能带着同板块跟风。高位断板或封单快速撤走，核心地位即失效。',
    cues: ['连板高度第一', '早盘封板', '封单占流通 ≥ 2%', '炸板少', '板块跟风 ≥ 2 家']
  },
  {
    key: 'mid',
    name: '趋势中军龙头',
    tag: '市值 · 成交 · 承接',
    body:
      '板块里的大市值核心，负责稳定重心与容纳大资金。不追求连板，看 5 日趋势、主力净流入、回踩缩量企稳。中军走坏，板块很难持续。',
    cues: ['流通市值 ≥ 80 亿', '成交额充足', '主力净流入', '沿 5 日线', '回踩有承接']
  },
  {
    key: 'catchup',
    name: '补涨龙',
    tag: '低位 · 早封 · 空间',
    body:
      '主线确认后的低位补涨。龙头打出高度，资金沿同一题材寻找低位首板。只做板块内、有催化、早盘主动封板的补涨，不做杂毛跟风。',
    cues: ['同题材', '低位首板', '早盘封板', '换手 3%–20%', '龙头仍在高位']
  },
  {
    key: 'vanguard',
    name: '首板先锋',
    tag: '启动 · 确认 · 试错',
    body:
      '板块刚启动时的第一梯队。首板只做观察，次日二板才是确认。若次日低开无承接、板块没有第二只跟风，按一日游处理。',
    cues: ['首板', '题材新', '次日二板确认', '板块扩散', '不孤军奋战']
  }
]

const disciplines = [
  ['分歧买入一致卖', '一致加速、集体高开是兑现区，不是新买点；分歧回踩、核心承接才是观察区。'],
  ['高位爆量要收工', '连板 ≥ 4 且换手 ≥ 25%，或封单快速衰减，说明筹码松动，先退出观察。'],
  ['破位止损不扛单', '买入逻辑被破坏（跌破关键承接位/板块核心断板），先止损，不补仓摊薄。'],
  ['退潮空仓莫强攻', '炸板率抬升、晋级率骤降、昨日溢价转负，进入退潮期，最优解是空仓等修复。']
]

const workflowGroups = [
  {
    key: 'after',
    label: '盘后',
    time: '15:00 – 21:30',
    note: '把今天的数据变成明天的条件单；任何一关不过，都不进入执行清单。',
    steps: [
      {
        time: '15:00–15:30',
        title: '收盘定格',
        body:
          '收盘后重新拉取涨停池、炸板池、情绪与板块资金。盘中的封板数、炸板次数都会变化，只认收盘后的快照。',
        out: '收盘快照 · 情绪分数 · 数据降级清单',
        veto: '数据未恢复，或三关通过数为 0 → 不进入隔夜流程'
      },
      {
        time: '15:30–16:30',
        title: '三关筛选',
        body:
          '逐项检查连续两日家数、高 / 中 / 低梯队、资金四项证据（主力两日净流入 / 量能 / 封单 / 溢价晋级）。任一关缺失就保留观察，不用近似值放行。',
        out: '三关通过板块清单',
        veto: '没有板块同时通过三关 → 空仓等待'
      },
      {
        time: '16:30–18:00',
        title: '催化核验',
        body:
          '只接受政策文件、产业订单 / 涨价 / 技术突破、事件驱动；小作文、聊天记录、无信源脉冲直接排除。',
        out: '政策 / 产业 / 事件标记与信源备注',
        veto: '纯传闻或无原始信源 → 剔除，不进入候选'
      },
      {
        time: '18:00–19:30',
        title: '画像匹配',
        body:
          '用历史老龙头六维分桶检查候选：高度、首封、封单、换手、流通市值、板块家数。少于 3 条样本的桶不加权。',
        out: '画像分与命中 / 缺失维度',
        veto: '画像分 < 55 或关键维度缺失 → 降级观察'
      },
      {
        time: '19:30–21:00',
        title: '隔夜条件单',
        body:
          '只在三关 + 情绪修复 / 主升时制定。弱转强优先，板块最高板龙头即使被炸板 / 换手罚分也要找回核验并明示风险；写清高开执行区间、放弃区间、止损与仓位。',
        out: '标的、价格区间、触发条件、失效条件、仓位',
        veto: '冰点 / 退潮 / 混沌 → 不挂隔夜单'
      },
      {
        time: '21:00 后',
        title: '定稿封存',
        body:
          '把计划压缩成三句话：什么价格执行、什么情况放弃、什么情况止损。定稿后不再在夜里改计划。',
        out: '次日竞价检查清单',
        veto: '临盘临时起意 → 一律不执行'
      }
    ]
  },
  {
    key: 'pre',
    label: '盘前',
    time: '09:15 – 09:30',
    note: '只验证昨晚的计划，不新增标的。9:20 前的一切挂单都可能被撤掉。',
    steps: [
      {
        time: '09:15–09:20',
        title: '试撮观察',
        body:
          '看高开方向与竞价额，但这段可以撤单，虚假挂单多。只做记录，不把“确认”当真。',
        out: '候选高开 / 竞价额初值',
        veto: '9:20 前不做执行决定'
      },
      {
        time: '09:20–09:25',
        title: '锁单复核',
        body:
          '不可撤单窗口。逐条核对 +2% ~ +8%、竞价额 ≥ 2000 万且 ≥ 昨成交 2%、同板块 ≥ 2 只强势、三关与催化。',
        out: '可执行 / 观察 / 放弃三档',
        veto: '任一硬条件不满足 → 放弃，不追高'
      },
      {
        time: '09:25–09:30',
        title: '定稿',
        body:
          '竞价价格锁定。高开超出 +6% 或跌回平盘，隔夜条件单直接失效；不在计划内的票不临时加入。',
        out: '最终执行清单',
        veto: '价格越界或板块无共振 → 取消'
      }
    ]
  },
  {
    key: 'open',
    label: '开盘',
    time: '09:30 – 10:00',
    note: '竞价只是门票，承接才决定这笔交易是否成立。',
    steps: [
      {
        time: '09:30–09:35',
        title: '承接验证',
        body:
          '看开盘 5 分钟能否放量站稳竞价价与分时均线；高开低走、放量砸盘，按失败处理。',
        out: '持有 / 退出',
        veto: '跌破昨收 -3% 或分时均线持续走弱 → 先退出'
      },
      {
        time: '09:35–10:00',
        title: '去弱留强',
        body:
          '同板块核心同步走强才继续持有；板块只剩一只独苗、跟风股集体回落，降低预期。',
        out: '持仓调整记录',
        veto: '不补仓摊低成本，不把短线做成中线'
      }
    ]
  }
]

const auctionRules = [
  [
    '9:20 是可信边界',
    '9:15–9:20 可撤单，挂了再撤可以伪装强势，不能作为强度证据；9:20–9:25 不可撤单，是最可信的确认窗口；9:25 后价格锁定，只做最后确认并等 9:30 承接，不再新增标的。'
  ],
  [
    '涨幅 +2% ~ +8%',
    '低于 +2% 说明资金态度不够强，高于 +8% 追高容错低。竞价翻绿直接剔除，不做“低开抢反弹”。'
  ],
  [
    '竞价额 ≥ 2000 万且 ≥ 昨成交 2%',
    '只有价格没有量，是虚强；只有量没有价格，是分歧。两个条件同时满足，才算有效放量。'
  ],
  [
    '同板块 ≥ 2 只强势',
    '至少 2 只同板块个股竞价额超千万且高开 ≥ 2%，才算板块共振；孤军高开不做。'
  ],
  [
    '三关 + 催化，缺一不可',
    '板块三关未过、催化未核验，竞价分再高也只显示观察，不进入执行清单。'
  ],
  [
    '盘中只认封板确认',
    '9:30–15:00 按封板确认 → 近板强度 → 量比 / 成交 → 板块共振 → 弱转强排序；未封板不算涨停，炸板不回封按失效处理。只列最强 5 只。'
  ]
]

const overnightRules = [
  ['只在三关 + 修复 / 主升', '资金关按四项证据核对；数据未就绪、冰点、退潮、混沌都不挂隔夜单，没有主线时空仓就是最优解。'],
  ['弱转强优先，只做 2–5 板核心', '跌停反包 / 炸板回封 / 烂板转强 > 连板晋级 > 新晋首板；不碰杂毛补涨，5 板以上只观察，炸过板的不进严格候选；炸板多、换手过热的大市值中军也不占准备池前排。'],
  ['催化必须人工核验', '政策 / 产业 / 事件要有原始信源；纯传闻、无信源小作文、一天脉冲直接排除。'],
  ['条件单而非预测单', '高开 +1% ~ +4% 执行，高开 > +6% 放弃，低开 < -2% 放弃，9:25 跌回平盘失效。'],
  ['仓位和止损写死', '单票 ≤ 10%，隔夜总仓 ≤ 30%；跌破昨收 -3% 或分时均线走弱，先退出再复盘。'],
  ['21:30 后不临时改计划', '竞价开始只验证不追加；夜里突发消息先记录，次日按失效条件处理。']
]

const profileDims = [
  ['连板高度', '3–5 板', '高度是辨识度，也是分歧来源；≥ 5 板只观察'],
  ['首封时间', '越早越好', '早盘主动封板，说明资金抢筹，而非尾盘偷袭'],
  ['封单 / 流通', '≥ 1%', '封单薄则开板概率高；≥ 2% 更强'],
  ['换手率', '3%–20%', '太低说明筹码没换手，太高说明分歧过大'],
  ['流通市值', '50–300 亿', '太小易被操纵，太大短线拉不动'],
  ['板块涨停家数', '≥ 3 家', '有梯队才有带动性，独苗不算主线']
]

const profileMethod = [
  '样本定义：板块当日 ≥ 2 家涨停，且板块内领涨股 ≥ 3 板；按“板块 + 日期 + 代码”去重。',
  '标签口径：次日是否继续涨停、次日是否高开、隔夜跳空幅度，全部来自历史日线，不使用未来数据。',
  '六维分桶：高度、首封时间、封单 / 流通、换手、流通市值、板块涨停家数；每桶少于 3 条样本时只展示，不参与加权。',
  '画像分：50 +（该桶次日延续率 − 全样本延续率）× 1.8，再与静态规则分按 62% / 38% 合成。',
  '样本累积：上游涨停池只保留约 15 个交易日，本机每天增量累积，上限 120 个交易日 / 600 条样本。'
]

const accuracyNotes = [
  [
    '没有公开验证的“高准确率”仓库',
    '我们检索了 A 股数据、量化与短线项目，没有找到经过长期实盘验证、可复现的高准确率竞价 / 龙头选股开源项目。本项目不复制任何“稳赚信号”。'
  ],
  [
    '样本延续率不是胜率',
    '画像里的“次日延续率”只是历史样本中继续涨停的比例，未扣交易成本、滑点、无法成交与停牌，不能当成策略胜率。'
  ],
  [
    '必须自己做前向验证',
    '每天记录候选与次日结果，至少连续 20–60 个交易日；同时记录“未执行 / 执行偏差”。只统计成功案例没有意义。'
  ],
  [
    '对比基线再谈有效',
    '把候选与“同板块随机 3 板股”的次日表现对比；如果跑不赢基线，说明画像没有增量信息。'
  ],
  [
    '失效就停用',
    '情绪进入退潮、监管特停增多、数据源连续降级、画像样本不足 20 个交易日时，暂停使用并复盘。'
  ]
]

const verifyFields = ['日期', '代码 / 板块', '角色与画像分', '竞价硬条件', '次日开盘 / 收盘', '是否延续', '执行偏差']

const hotshotTraders = [
  {
    key: 'bj',
    name: '北京炒家',
    tag: '首板套利 · 板块效应 · 分仓试错',
    core: '只打 9% 以上的板，不做半路；先看板块有没有整体效应，再决定打哪一只。',
    picks: [
      '首板为主：回封板、换手板、缩量二板、尾盘板，按盘中“亮点”临场选。',
      '同一板块必须有多只涨停 / 跟风，独苗不打；封单与封板时间比故事重要。',
      '分仓、多账户、单票小仓，用试错换命中率；公开表示不做盘前预设。'
    ],
    encoded: [
      '首板套利：同行业涨停 ≥3 家或板块热度 ≥45，才进入“今日审美命中”。',
      '缩量二板加权：2 板换手 <3% 给换手满分，同时提示“开板承接未知”。',
      '封板质量占 30%、板块占 18%；封单 <0.7% 或尾盘板直接不选。',
      '首板次日只做一进二验证，仓位 0.5–1 成，不重仓。'
    ],
    notCopied: '不复制多账户分仓和“盘中凭感觉”的不可复现部分；我们把条件事前写死，盘中只做验证。'
  },
  {
    key: 'kb',
    name: '92科比',
    tag: '情绪周期 · 只做两端 · 分歧转强',
    core: '低位震荡做首板，主升做龙头，高位震荡做补涨 / 切换，主跌空仓；中位股不碰。',
    picks: [
      '只做高位绝对龙头，或低位首板 / 一进二；避开不上不下的中位板。',
      '人气与流动性是溢价来源，题材要有新闻敏感度，不买没有资金关注的票。',
      '买点在分歧转强、板上确认，不做半路；低于预期立刻走，不补仓摊薄。'
    ],
    encoded: [
      '2 板给最高身位分；3 板只在唯一 / 领涨 / 最高板时保留，4 板以上基本不给打板分。',
      '三板组、中位三板、梯队跟随在复盘里直接剔除，不进入待选。',
      '情绪窗口决定能不能出手：退潮 / 防守只观察，进攻窗口才允许提高仓位。',
      '弱转强单独加分：跌停反包、炸板回封、烂板转强按 92 / 86 / 78 分映射。'
    ],
    notCopied: '不把“情绪周期”包装成精确预测；它只是仓位开关，周期判断与数据闸门冲突时，以数据为准。'
  },
  {
    key: 'yr',
    name: '全能的野人',
    tag: '龙空龙 · 只做龙一 · 等不到就不做',
    core: '有龙做龙，无龙空仓；只做板块和市场最强的龙一，不做补涨龙，不做高切低。',
    picks: [
      '只认龙头：能扛住分歧、带动板块、封板最硬的那一只，跟风一律不看。',
      '没有龙头就空仓等待，等待本身是风控，不是错过。',
      '龙头断板 / 走弱就退出，不切低位补涨，不恋战。'
    ],
    encoded: [
      '同板块按连板高度与封板质量排位，只有第 1 位标“板块龙一”，其余明确提示非龙一。',
      '明日待选最多 5 只、同板块最多 2 只；没有合格载体就直接输出空仓提示。',
      '板块无效应、节点只是跟随、封单薄、尾盘板，一律不进入可打板列表。',
      '复盘只留前排核心，后排杂毛进入“剔除池”并写明原因。'
    ],
    notCopied: '不把“龙头”简化成最高板：最高板炸板多、换手过热时只当风向标，不自动成为买入对象。'
  }
]

const hotshotConsensus = [
  ['01 先板块，后个股', '三家都不做孤立涨停。板块没有 3 家以上涨停、没有连续性与梯队，个股封得再早也只观察。'],
  ['02 只做前排 / 两端', '首板或高位龙头，避开中位三板与后排跟风；“看起来便宜”的低位杂毛不是机会。'],
  ['03 封板质量是硬通货', '首封时间、封单占流通、炸板次数、换手区间，比题材故事更早决定成败。'],
  ['04 买点只在板上 / 转强', '不半路、不低吸跟风；竞价高开过多、秒板、撤单，都按放弃处理。'],
  ['05 空仓是默认选项', '没有合格载体、板块退潮、核心断板，最优解是空仓；不拿后排凑数。']
]

const hotshotAppGates = [
  ['今日命中', '1–3 板、板块热度 ≥45 且同板 ≥3 家或至少过 1 关、炸板 <3、换手 ≤40%、封单 ≥0.7%、非尾盘板、审美 ≥62；同板块最多 2 只、总共最多 5 只。'],
  ['明日可打板', '1–2 板、板块成立、节点非风险、封单 ≥0.7% 且非尾盘、换手 ≤30%、流通 20–300 亿；首板炸板 ≤1 且首封 ≤10:30，二板炸板 ≤2 且非跟随；审美 ≥65。'],
  ['只观察', '方向对但条件未齐：封单薄、首封晚、炸板多、换手过热、流通过小 / 过大、板块不足、同板块名额已满。只列原因，不给买点。'],
  ['空仓', '可打板为 0 时直接提示“龙空龙”，不降标准补位；审美分只用于排序，不是胜率。']
]

const hotshotSources = [
  ['北京炒家 · 东方财富路演', 'http://roadshow.eastmoney.com/zw/20260529191838074681040'],
  ['北京炒家 · 55188 复盘总结', 'https://www.55188.com/topics-8739933.html'],
  ['北京炒家 · 360doc 访谈整理', 'http://www.360doc.cn/article/82999282_1143985706.html'],
  ['北京炒家 · 新浪股吧讨论', 'http://guba.sina.cn/view_47732_1652.html'],
  ['92科比 · 淘股吧文章', 'http://m.taoguba.com.cn/a/2vzjAKdmgsV'],
  ['92科比 · Wogoo 观点整理', 'https://www.wogoo.com/sq/t/c6be92aa734c47608d463ebd6096c73b'],
  ['92科比 · 55188 讨论', 'https://www.55188.com/thread-15260611-1-1.html'],
  ['全能的野人 · 今日头条', 'https://m.toutiao.com/a7685780910100300328/'],
  ['全能的野人 · 淘股吧', 'https://m.tgb.cn/Article/6340046/1'],
  ['全能的野人 · 雪球', 'https://xueqiu.com/2858934390/304700772']
]

const currentGate = computed(() => props.dashboard && props.dashboard.gate)
</script>

<template>
  <div class="view">
    <section class="mantra">
      <div class="eyebrow">交易总纲 · MANTRA</div>
      <h3>龙头口诀</h3>
      <div class="mantra-lines">
        <div v-for="(line, idx) in mantra" :key="idx" class="mantra-line">
          <span class="no">{{ String(idx + 1).padStart(2, '0') }}</span>
          <span>{{ line }}</span>
        </div>
      </div>
      <div class="mantra-roles">
        资金与换手健康 · 情绪连板龙 · 趋势中军龙头 · 补涨龙 · 盘后复盘
      </div>
    </section>

    <section v-if="currentGate" class="gate-mirror" :class="`gate-mirror--${currentGate.key}`">
      <div>
        <span class="dim">当前系统结论</span>
        <b>{{ currentGate.label }}</b>
      </div>
      <span class="chip" :class="currentGate.key === 'ready' ? 'chip--gold' : 'chip--dim'">
        已核验催化 {{ verifiedCount }} 个
      </span>
    </section>

    <section class="section">
      <header class="section-head">
        <span class="section-title">标准化流程</span>
        <span class="section-count">盘后定计划 · 盘前只验证</span>
      </header>
      <div class="workflow">
        <div v-for="group in workflowGroups" :key="group.key" class="workflow-group">
          <div class="wf-group-head">
            <div class="wf-group-id">
              <span class="wf-phase" :class="`wf-phase--${group.key}`">{{ group.label }}</span>
              <b class="mono">{{ group.time }}</b>
            </div>
            <p>{{ group.note }}</p>
          </div>
          <div class="wf-steps">
            <div v-for="(step, idx) in group.steps" :key="step.title" class="wf-step">
              <div class="wf-rail">
                <span class="wf-dot"></span>
                <i v-if="idx < group.steps.length - 1"></i>
              </div>
              <div class="wf-body">
                <div class="wf-title">
                  <b>{{ step.title }}</b>
                  <span class="mono">{{ step.time }}</span>
                </div>
                <p>{{ step.body }}</p>
                <div class="wf-meta">
                  <span class="wf-out">产出：{{ step.out }}</span>
                  <span class="wf-veto">一票否决：{{ step.veto }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="section">
      <header class="section-head">
        <span class="section-title">四道闸门</span>
        <span class="section-count">01 / 02 / 03 数据三关 · 04 人工核验</span>
      </header>
      <div class="strategy-list">
        <div v-for="gate in gates" :key="gate.no" class="strategy-item">
          <span class="strategy-no">{{ gate.no }}</span>
          <div class="strategy-body">
            <h4>{{ gate.title }}</h4>
            <p>{{ gate.body }}</p>
            <div class="check-map">{{ gate.check }}</div>
          </div>
        </div>
      </div>
    </section>

    <section class="section">
      <header class="section-head">
        <span class="section-title">竞价 / 盘中抓强 · 六条硬规则</span>
        <span class="section-count">9:15–15:00 · 1.5 秒刷新</span>
      </header>
      <div class="stage-rail">
        <div class="stage-cell stage-cell--trial">
          <b class="mono">9:15</b>
          <span>试撮</span>
          <small>可撤单</small>
        </div>
        <div class="stage-cell stage-cell--locked">
          <b class="mono">9:20</b>
          <span>锁单</span>
          <small>不可撤</small>
        </div>
        <div class="stage-cell stage-cell--final">
          <b class="mono">9:25</b>
          <span>定稿</span>
          <small>价格锁定</small>
        </div>
        <div class="stage-cell stage-cell--open">
          <b class="mono">9:30</b>
          <span>承接</span>
          <small>看开盘</small>
        </div>
        <div class="stage-cell stage-cell--open">
          <b class="mono">10:00</b>
          <span>盘中</span>
          <small>实时抓板</small>
        </div>
      </div>
      <div class="strategy-list">
        <div v-for="(rule, idx) in auctionRules" :key="rule[0]" class="strategy-item">
          <span class="strategy-no">A{{ idx + 1 }}</span>
          <div class="strategy-body">
            <h4>{{ rule[0] }}</h4>
            <p>{{ rule[1] }}</p>
          </div>
        </div>
      </div>
      <div class="panel panel-pad honesty-box">
        <b>为什么不能承诺“竞价准确率”</b>
        <p>
          公开数据源没有长期、完整、免费的集合竞价历史快照，无法做严谨的竞价因子回测。
          本页的竞价规则来自交易常识与实时数据约束，只能帮助排除“虚强、追高、孤军”，
          不能保证次日溢价，更不是胜率。
        </p>
      </div>
    </section>

    <section class="section">
      <header class="section-head">
        <span class="section-title">隔夜计划 · 六条硬规则</span>
        <span class="section-count">15:00 后定稿 · 不临时加单</span>
      </header>
      <div class="strategy-list">
        <div v-for="(rule, idx) in overnightRules" :key="rule[0]" class="strategy-item">
          <span class="strategy-no">O{{ idx + 1 }}</span>
          <div class="strategy-body">
            <h4>{{ rule[0] }}</h4>
            <p>{{ rule[1] }}</p>
          </div>
        </div>
      </div>
      <div class="plan-spec">
        <div class="plan-spec-bar">
          <div class="ps-zone ps-zone--abandon"><b>-2%</b><small>低开放弃</small></div>
          <div class="ps-zone ps-zone--buy"><b>+1% ~ +4%</b><small>执行区间</small></div>
          <div class="ps-zone ps-zone--cancel"><b>+6%</b><small>高开放弃</small></div>
        </div>
        <div class="plan-spec-grid">
          <div><small>单票上限</small><b>10%</b></div>
          <div><small>隔夜总仓</small><b>30%</b></div>
          <div><small>止损参考</small><b>-3%</b></div>
          <div><small>定稿时间</small><b>21:30</b></div>
        </div>
      </div>
    </section>

    <section class="section">
      <header class="section-head">
        <span class="section-title">三种龙头角色</span>
        <span class="section-count">买点不同 · 纪律相同</span>
      </header>
      <div class="strategy-list">
        <div v-for="role in roles" :key="role.key" class="role-card">
          <div class="role-card-head">
            <span class="role-badge" :class="`role-badge--${role.key}`">{{ role.name }}</span>
            <span>{{ role.tag }}</span>
          </div>
          <p>{{ role.body }}</p>
          <div class="cues">
            <span v-for="cue in role.cues" :key="cue" class="chip chip--dim">{{ cue }}</span>
          </div>
        </div>
      </div>
    </section>

    <section class="section">
      <header class="section-head">
        <span class="section-title">情绪周期 · 节点票 · 基因分</span>
        <span class="section-count">把“强”拆成可解释的分数</span>
      </header>

      <div class="window-grid">
        <div
          v-for="(w, i) in sentimentWindows"
          :key="w[0]"
          class="window-card"
          :class="`window-card--${i}`"
        >
          <b>{{ w[0] }}</b>
          <p>{{ w[1] }}</p>
        </div>
      </div>

      <div class="panel panel-pad weak-panel">
        <h4>弱转强优先级 · 分数越高越优先</h4>
        <div v-for="w in weakLadder" :key="w[0]" class="weak-row">
          <span class="weak-score">{{ w[1] }}</span>
          <div class="weak-main">
            <b>{{ w[0] }}</b>
            <p>{{ w[2] }}</p>
          </div>
        </div>
      </div>

      <div class="panel panel-pad gene-panel">
        <h4>龙头基因 · 六因子权重</h4>
        <div v-for="g in geneFactors" :key="g[0]" class="gene-row">
          <div class="gene-label">
            <b>{{ g[0] }}</b>
            <span class="mono">{{ g[1] }}%</span>
          </div>
          <div class="gene-bar">
            <i :style="{ width: `${Math.min(100, g[1] * 5)}%` }"></i>
          </div>
          <p>{{ g[2] }}</p>
        </div>
        <p class="gene-note">
          准备池只收 2 板以上：30% 基因 + 14% 基础分 + 10% 板块热度 + 8% 弱转强 + 10% 情绪适配
          + 12% 节点 + 10% 连板高度 + 6% 流通市值，再扣核心修正。
          最终个股分 = 72% 角色初筛 + 28% 基因。所有分数只用于横向比较，不承诺胜率。
        </p>
      </div>

      <div class="panel panel-pad core-panel node-panel">
        <h4>节点票分层 · 空间 / 卡位 / 转势 / 补涨</h4>
        <div v-for="n in nodeTiers" :key="n[0]" class="core-row">
          <span class="core-tag" :class="{ 'is-core': n[0] === '破局龙' || n[0] === '卡位节点' }">{{ n[0] }}</span>
          <p>{{ n[1] }}</p>
        </div>
        <div class="node-weights">
          <div v-for="n in nodeFactors" :key="n[0]" class="gene-row">
            <div class="gene-label">
              <b>{{ n[0] }}</b>
              <span class="mono">{{ n[1] }}%</span>
            </div>
            <div class="gene-bar">
              <i :style="{ width: `${Math.min(100, n[1] * 6)}%` }"></i>
            </div>
            <p>{{ n[2] }}</p>
          </div>
        </div>
        <p class="gene-note">
          节点分 = 结构分（空间 / 卡位 / 转势 / 补涨）+ 情绪修正 − 封板质量扣分；高位空间板炸板多、换手过热时只验证不接力。
          参考公开短线与量化资料里较稳定的情绪周期、空间板、弱转强、中小流通盘与连板晋级因子；
          没有可验证的高胜率开源短线项目，这些分数是过滤与排序工具，不是胜率预测。
        </p>
      </div>

      <div class="panel panel-pad core-panel">
        <h4>准备池核心分层 · 先排核心，再排观察</h4>
        <div v-for="c in coreTiers" :key="c[0]" class="core-row">
          <span class="core-tag" :class="{ 'is-core': c[0] === '核心先锋' }">{{ c[0] }}</span>
          <p>{{ c[1] }}</p>
        </div>
        <p class="gene-note">
          核心修正：炸板每次 −4（上限 −24）、换手 &gt;20% 每点 −0.6（上限 −14）、容量中军 −4、
          5 板以上 −6、封单 &lt;1% −6、流通 &lt;20 亿 −4、首封晚于 10:30 −4。
          今日示例：中京电子 6 次炸板 + 30.3% 换手 + 86 亿流通 → 容量中军，核心修正 −34，虽然 3 板高于荣联，
          但节点质量被炸板拖到 50 分，跌出准备池；荣联科技 2 板 0 炸、封单 2.58%、换手 6.0%、流通 52.9 亿
          → 核心先锋 + 补涨节点，准备分第 1。
        </p>
      </div>
    </section>

    <section class="section">
      <header class="section-head">
        <span class="section-title">复盘作战室 · 明天怎么打</span>
        <span class="section-count">只做前排核心</span>
      </header>
      <div class="panel panel-pad core-panel">
        <h4>前排过滤 · 拒绝后排杂毛</h4>
        <div class="core-row">
          <span class="core-tag is-core">进榜条件</span>
          <p>
            2–5 板；节点分 ≥50 且非风险节点；炸板 ≤2 次、换手 ≤30%、封单 ≥0.7%、非尾盘板；
            板块三关就绪，或至少 1 关 + 热度 ≥40。只对合格前排估算晋级，不足就空着，不拿后排凑数。
          </p>
        </div>
        <div class="core-row">
          <span class="core-tag">直接剔除</span>
          <p>
            同高度 ≥2 且非最高板的三板组、距顶 ≥2 板的中位三板、梯队跟随 / 后排跟风；
            炸板多、尾盘封板、薄封单、板块 0 关的也剔除，并在“后排剔除”里写明原因。
          </p>
        </div>
        <div class="core-row">
          <span class="core-tag">高度风向标</span>
          <p>
            最高板只当情绪风向标：炸板多、尾盘板、薄封或板块 0 关时只给参考晋级，不进晋级榜；
            最高板断板前，低位核心不抢“总龙头”身份。
          </p>
        </div>
        <p class="gene-note">
          晋级估算 = 平滑基准 × 高度系数 × 前排质量 × 瑕疵折扣，输出 ±9pp 区间。
          基准取今日实测的首板→二板、连板→连板晋级率，并按先验（首板 26% / 连板 40%，k=14）平滑；
          小样本时结果主要受先验约束，是排序工具，不是胜率。
        </p>
      </div>
      <div class="panel panel-pad core-panel">
        <h4>能不能出手 · 弱势切核心抱团 / 分歧切核心</h4>
        <div class="core-row">
          <span class="core-tag">出手闸门</span>
          <p>
            三关空仓；防守 / 冰点 / 退潮只观察；没有合格前排也观察；
            有断层、高位风险或三板组时“能出手 · 只做分歧核心”，总仓 ≤2 成、单票 ≤1 成；
            进攻窗口才允许小仓 ≤3 成。任何模式下都不接后排补涨。
          </p>
        </div>
        <div class="core-row">
          <span class="core-tag">弱势切核心抱团</span>
          <p>
            晋级率跌破 30% 或炸板率升破 40%：删除所有后排与补涨，只抱最高板 / 唯一核心；
            核心不封板就空仓，不低吸跟风。
          </p>
        </div>
        <div class="core-row">
          <span class="core-tag">分歧切核心</span>
          <p>
            高位炸板或断板时：只做最强核心的回封 / 分时转强，不接中位股和后排；
            核心不回封，当天不交易。竞价高开 1%–4% + 竞价额 ≥ 今日成交 3% + 同板块核心同步红盘，才进入执行观察。
          </p>
        </div>
        <p class="gene-note">
          龙头评分 = 42% 节点 + 16% 高度适配 + 10% 市值适配 + 14% 封板质量 + 12% 板块质量 + 6% 弱转强 − 尾盘扣分；
          从合格前排里选龙头，不是简单拿最高板。
        </p>
      </div>
    </section>

    <section class="section">
      <header class="section-head">
        <span class="section-title">打板客审美 · 三家公开思路</span>
        <span class="section-count">公开访谈与复盘 · 未验证胜率</span>
      </header>
      <div class="trader-grid">
        <div v-for="t in hotshotTraders" :key="t.key" class="trader-card">
          <div class="trader-head">
            <b>{{ t.name }}</b>
            <span>{{ t.tag }}</span>
          </div>
          <p class="trader-core">{{ t.core }}</p>
          <div class="trader-block">
            <small>选票审美</small>
            <ul>
              <li v-for="line in t.picks" :key="line">{{ line }}</li>
            </ul>
          </div>
          <div class="trader-block">
            <small>已编码成条件</small>
            <ul class="is-encoded">
              <li v-for="line in t.encoded" :key="line">{{ line }}</li>
            </ul>
          </div>
          <p class="trader-no"><b>不照搬</b>{{ t.notCopied }}</p>
        </div>
      </div>

      <div class="panel panel-pad core-panel">
        <h4>三家共识 · 合并成五条</h4>
        <div v-for="row in hotshotConsensus" :key="row[0]" class="core-row">
          <span class="core-tag is-core">{{ row[0] }}</span>
          <p>{{ row[1] }}</p>
        </div>
      </div>

      <div class="panel panel-pad core-panel">
        <h4>复盘页怎么落地 · 今日命中 / 明日待选 / 只观察 / 空仓</h4>
        <div v-for="row in hotshotAppGates" :key="row[0]" class="core-row">
          <span class="core-tag">{{ row[0] }}</span>
          <p>{{ row[1] }}</p>
        </div>
        <p class="gene-note">
          审美分 = 30% 封板质量 + 18% 板块质量 + 14% 节点 + 12% 身位 + 8% 市值 + 8% 换手
          + 5% 弱转强 + 5% 板块地位。它只回答“谁更像这三家会看的票”，不回答“明天一定涨”。
        </p>
      </div>

      <div class="panel panel-pad honesty-box">
        <b>必须说清楚的三件事</b>
        <p>
          ① 公开胜率是自我描述，无法在本机复现；“审美分”只是排序工具，不是胜率，也不是买入信号。
        </p>
        <p>
          ② 板块采用行业口径，和概念题材不完全等价；同板块是否真的一条主线、催化是否成立，必须人工核对。
        </p>
        <p>
          ③ 缩量二板、首板套利都是风格偏好，不是稳赚规则；缩量二板的开板承接、首板换手过低都可能是陷阱。
        </p>
      </div>

      <div class="panel panel-pad source-panel">
        <h4>公开来源 · 仅作方法研究</h4>
        <div class="source-list">
          <a
            v-for="src in hotshotSources"
            :key="src[1]"
            :href="src[1]"
            target="_blank"
            rel="noopener noreferrer"
          >{{ src[0] }}</a>
        </div>
        <p>
          以上为公开访谈、复盘与讨论页，不代表本工具与作者有合作；引用只为说明规则出处，公开宣称的胜率未经独立验证。
        </p>
      </div>
    </section>

    <section class="section">
      <header class="section-head">
        <span class="section-title">老龙头画像 · 六维与口径</span>
        <span class="section-count">历史样本 · 不是准确率</span>
      </header>
      <div class="profile-grid">
        <div v-for="dim in profileDims" :key="dim[0]" class="profile-dim">
          <small>{{ dim[0] }}</small>
          <b>{{ dim[1] }}</b>
          <p>{{ dim[2] }}</p>
        </div>
      </div>
      <div class="panel panel-pad method-panel">
        <h4>样本怎么来，分数怎么算</h4>
        <div v-for="(line, idx) in profileMethod" :key="idx" class="method-line">
          <span class="mono">{{ String(idx + 1).padStart(2, '0') }}</span>
          <p>{{ line }}</p>
        </div>
      </div>
      <div class="panel panel-pad honesty-box">
        <b>样本偏差必须说清楚</b>
        <p>
          画像只统计“已经走出来的高标”，天然带幸存者偏差；上游涨停池只保留约 15 个交易日，
          本机累积也需要时间。分桶样本少于 3 条时不参与加权，但即使样本足够，历史规律也可能在风格切换后失效。
          请把它当作“排除明显不符合龙头特征”的过滤器，而不是预测器。
        </p>
      </div>
    </section>

    <section class="section">
      <header class="section-head">
        <span class="section-title">执行纪律</span>
        <span class="section-count">知道 ≠ 做到</span>
      </header>
      <div class="panel panel-pad discipline-list">
        <div v-for="(item, idx) in disciplines" :key="idx" class="discipline">
          <b>{{ item[0] }}</b>
          <p>{{ item[1] }}</p>
        </div>
      </div>
    </section>

    <section class="section">
      <header class="section-head">
        <span class="section-title">评分透明</span>
        <span class="section-count">可解释 · 不承诺胜率</span>
      </header>
      <div class="panel panel-pad formula">
        <div class="formula-row">
          <code>热度</code>
          <span>32% 涨停家数 + 22% 连续性 + 24% 梯队完整度 + 14% 资金 + 8% 高度与封板质量。</span>
        </div>
        <div class="formula-row">
          <code>个股</code>
          <span>初筛 = 54% 角色分 + 30% 板块热度 + 16% 就绪度；最终 = 72% 初筛 + 28% 基因分。炸板、尾盘封板、高位爆量、薄封单分别扣分。</span>
        </div>
        <div class="formula-row">
          <code>封顶</code>
          <span>未过三关的板块，个股最高 68 分；新起题材最高 60 分，并统一标记「仅观察」。</span>
        </div>
        <div class="formula-row">
          <code>资金</code>
          <span>四项证据：主力资金（今昨两日真实净流入）、量能（同股成交额 ≥ 昨日 75%）、封单（合计 / 流通 ≥ 0.5%）、溢价 / 晋级（昨日涨停溢价为正且晋级率 ≥ 30%）；至少 3 项成立且主力资金不硬性转负。</span>
        </div>
        <div class="formula-row">
          <code>情绪</code>
          <span>25% 昨日涨停溢价 + 20% 涨停家数 + 20% 连板高度 + 20% 封板质量 + 15% 晋级率；晋级率 ≥35% / 炸板率 <35% 记为进攻，炸板率 ≥45% 或晋级率 <25% 记为防守。</span>
        </div>
        <div class="formula-row">
          <code>基因</code>
          <span>情绪 15% + 板块地位 18% + 弱转强 22% + 封板质量 20% + 筹码结构 10% + 历史画像 15%。</span>
        </div>
        <div class="formula-row">
          <code>竞价</code>
          <span>90% ×（30% 涨幅 + 28% 竞价额 + 24% 板块共振 + 18% 封板质量）× 情绪系数 + 10% 基因分；竞价确认分 ≥ 72。</span>
        </div>
        <div class="formula-row">
          <code>盘中</code>
          <span>62% ×（50% 近板强度 + 25% 量比 + 25% 成交额）+ 38% 基因分；封板确认后不低于基因分 + 2。只列最强 5 只。</span>
        </div>
        <div class="formula-row">
          <code>确认</code>
          <span>竞价：涨幅 +2% ~ +8%、竞价额 ≥ 2000 万且 ≥ 昨成交 2%、同板块 ≥ 2 只强势、三关通过、催化已核验；盘中：最新价与买一贴在涨停价，且属于涨停池 / 三关板块 / 基因 ≥60。</span>
        </div>
        <div class="formula-row">
          <code>隔夜</code>
          <span>50% 基础分 + 30% 基因分 + 20% 板块热度；严格候选 = 三关 + 情绪修复/主升 + 画像 ≥55 + 隔夜分 ≥65 + 2–5 板 + 昨日无炸板 + 节点 ≥50 且非高风险节点。</span>
        </div>
        <div class="formula-row">
          <code>复盘</code>
          <span>晋级估算 = 平滑基准 × 高度系数 × 前排质量 × 瑕疵折扣，输出 ±9pp；基准用今日实测晋级率按先验平滑。前排只留 2–5 板、节点 ≥50、炸板 ≤2、换手 ≤30%、封单 ≥0.7%、非尾盘、非三板组 / 中位三板 / 跟随；高度风向标只看不接。</span>
        </div>
        <div class="formula-row">
          <code>审美</code>
          <span>打板客审美 = 30% 封板质量 + 18% 板块质量 + 14% 节点 + 12% 身位 + 8% 市值 + 8% 换手 + 5% 弱转强 + 5% 板块地位；今日命中 ≥62、明日可打板 ≥65，只用于复盘页排序，不是胜率。</span>
        </div>
        <div class="formula-row">
          <code>节点</code>
          <span>空间板（与市场最高板同高）/ 破局龙（修复、主升期空间板）/ 卡位（离顶 1 板且 ≥3 板）/ 转势（跌停反包、炸板回封、烂板转强）/ 补涨（低位强封核心）/ 梯队跟随；节点分再扣炸板与过热换手，高位空间板只观察。</span>
        </div>
        <div class="formula-row">
          <code>市值</code>
          <span>流通 50–120 亿最适配短线；200 亿以上按中军降权，500 亿以上明显降权，20 亿以下视为操控与流动性风险。</span>
        </div>
        <div class="formula-row">
          <code>准备池</code>
          <span>只收 2 板以上：30% 基因 + 14% 基础分 + 10% 板块热度 + 8% 弱转强 + 10% 情绪适配 + 12% 节点 + 10% 连板高度 + 6% 流通市值，再扣核心修正（炸板 / 过热换手 / 容量中军 / 高位 / 薄封 / 晚封）；高度相对市场空间板计算，每个板块的强封核心即使不是最高板也会补入，中军与高位分歧不占前排，只解释不挂单。</span>
        </div>
        <div class="formula-row">
          <code>画像</code>
          <span>62% 静态规则分 + 38% 样本经验分；经验分 = 50 +（桶延续率 − 全样本延续率）× 1.8，少于 3 条样本的桶不加权。</span>
        </div>
      </div>
    </section>

    <section class="section">
      <header class="section-head">
        <span class="section-title">关于“准确率”与验证</span>
        <span class="section-count">先证明 · 再相信</span>
      </header>
      <div class="accuracy-list">
        <div v-for="(item, idx) in accuracyNotes" :key="item[0]" class="accuracy-card">
          <span class="mono">V{{ idx + 1 }}</span>
          <div>
            <b>{{ item[0] }}</b>
            <p>{{ item[1] }}</p>
          </div>
        </div>
      </div>
      <div class="panel panel-pad verify-panel">
        <h4>前向验证记录字段</h4>
        <div class="verify-fields">
          <span v-for="field in verifyFields" :key="field" class="chip chip--dim">{{ field }}</span>
        </div>
        <p>
          建议每周统计：候选数、实际执行数、次日延续率、平均跳空、假信号比例、最大单笔亏损。
          只有连续 20 个交易日以上、且跑赢同板块基线，才谈得上“这个流程对我有效”。
        </p>
      </div>
    </section>

    <section class="section">
      <header class="section-head">
        <span class="section-title">数据与开源参考</span>
        <span class="section-count">证据优先</span>
      </header>
      <div class="panel panel-pad source-list">
        <div class="source-row">
          <b>行情报价</b>
          <span>腾讯财经公开接口，价格 / 涨跌幅 1 秒轮询，开盘与盘中自动更新。</span>
        </div>
        <div class="source-row">
          <b>涨停 / 炸板</b>
          <span>东方财富 push2ex 公开涨停池、炸板池、跌停池，包含封板时间、封单、连板数。</span>
        </div>
        <div class="source-row">
          <b>板块资金</b>
          <span>东方财富板块资金流公开接口 + 涨停池封单 / 同股量能 / 昨日涨停溢价与晋级率，合成为资金四项证据；受限时展示本机持久化的每日快照并明确标注，不把近似值当作通过。</span>
        </div>
        <div class="source-row">
          <b>板块目录</b>
          <span>内置 496 个行业板块快照，池内板块名做归一化匹配，避免接口抖动导致映射丢失。</span>
        </div>
        <div class="source-row">
          <b>历史日线</b>
          <span>腾讯历史 K 线公开接口，用于老龙头样本的次日延续与隔夜跳空；只做统计，不预测。</span>
        </div>
        <div class="source-row">
          <b>竞价数据</b>
          <span>腾讯批量行情 + 东方财富涨停池；9:15–9:30 每 1.5 秒刷新，9:20 前只作试撮观察。</span>
        </div>
        <div class="source-row">
          <b>盘中扫描</b>
          <span>东方财富全市场涨幅榜（沪深两市，约 1.8 秒缓存）+ 涨停池 + 腾讯五档，盘中实时排序最强 5 只，未封板不当作涨停。</span>
        </div>
        <div class="divider" style="margin: 6px 0"></div>
        <div class="source-row">
          <b>InStock</b>
          <span>
            <a href="https://github.com/myhhub/stock" target="_blank" rel="noopener">myhhub/stock</a>
            —— A 股数据采集与指标工程的实践参考。
          </span>
        </div>
        <div class="source-row">
          <b>AKShare</b>
          <span>
            <a href="https://github.com/akfamily/akshare" target="_blank" rel="noopener">akfamily/akshare</a>
            —— 公开数据接口目录与字段口径参考。
          </span>
        </div>
        <div class="source-row">
          <b>Qlib</b>
          <span>
            <a href="https://github.com/microsoft/qlib" target="_blank" rel="noopener">microsoft/qlib</a>
            —— 因子研究与回测框架参考。
          </span>
        </div>
        <div class="source-row">
          <b>QUANTAXIS</b>
          <span>
            <a href="https://github.com/QUANTAXIS/QUANTAXIS" target="_blank" rel="noopener">QUANTAXIS</a>
            —— 行情与交易系统工程参考。
          </span>
        </div>
        <div class="source-row">
          <b>Hikyuu</b>
          <span>
            <a href="https://github.com/fasiondog/hikyuu" target="_blank" rel="noopener">hikyuu</a>
            —— A 股回测引擎与指标计算口径参考。
          </span>
        </div>
        <div class="source-row">
          <b>easyquotation</b>
          <span>
            <a href="https://github.com/shidenggui/easyquotation" target="_blank" rel="noopener">easyquotation</a>
            —— 实时行情封装的工程思路参考。
          </span>
        </div>
        <p class="source-honest">
          说明：开源社区没有找到「经过长期验证、可公开复现的高准确率龙头选股仓库」。
          Star 数、README 口号和截图都不能证明“最准确 / 最强势”。本项目只按可复核性借鉴：
          数据接口清晰、回测框架成熟、指标定义透明；不复制任何“稳赚”信号，也不宣称胜率。
          真正的超额来自主线判断、位置选择与纪律执行。
        </p>
      </div>
    </section>

    <section class="section">
      <header class="section-head">
        <span class="section-title">这个工具不做什么</span>
      </header>
      <div class="panel panel-pad nos-list">
        <div>不预测明天哪只票会涨停，只筛出“如果主线成立，应该盯谁”。</div>
        <div>不把涨幅第一当成龙头，不给孤零零的独苗高分。</div>
        <div>不自动判断新闻真假；催化必须人工核验，传闻直接排除。</div>
        <div>不在数据不足时硬给结论；接口异常会降级并明确提示。</div>
        <div>不宣称竞价 / 隔夜“准确率”，不提供自动下单，也不把样本统计包装成回测收益。</div>
        <div>不替你做仓位决定；所有条件单都必须在你的券商端自行复核后手动提交。</div>
      </div>
    </section>

    <div class="disclaimer">
      <b>风险提示：</b>本应用仅用于个人学习、复盘与行情观察，所有内容不构成投资建议或收益承诺。
      A 股短线波动极大，任何模型都无法消除亏损风险。请独立判断、控制仓位、严格执行止损。
    </div>
  </div>
</template>

<style scoped>
.mantra-roles {
  position: relative;
  z-index: 1;
  margin-top: 13px;
  padding-top: 10px;
  border-top: 1px dashed rgba(243, 199, 119, 0.18);
  font-size: 11.5px;
  letter-spacing: 0.08em;
  color: rgba(243, 199, 119, 0.6);
}

.gate-mirror {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.022);
}

.gate-mirror > div {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
}

.gate-mirror b {
  font-size: 14.5px;
  font-weight: 650;
  color: var(--text-soft);
}

.gate-mirror--empty b {
  color: #ff9aa2;
}

.gate-mirror--defend b {
  color: var(--warn);
}

.gate-mirror--ready b {
  color: var(--gold);
}

.check-map {
  margin-top: 7px;
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: 0.02em;
  color: var(--dim);
  word-break: break-all;
}

.cues {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.discipline-list {
  display: flex;
  flex-direction: column;
  gap: 11px;
}

.discipline b {
  display: block;
  font-family: "STKaiti", "KaiTi", serif;
  font-size: 14.5px;
  letter-spacing: 0.08em;
  color: #e8d3a8;
}

.discipline p {
  margin: 3px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--muted);
}

.source-honest {
  margin: 8px 0 0;
  padding-top: 8px;
  border-top: 1px dashed rgba(255, 255, 255, 0.07);
  font-size: 11.5px;
  line-height: 1.75;
  color: var(--dim);
}

.nos-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.nos-list div {
  position: relative;
  padding-left: 15px;
  font-size: 12px;
  line-height: 1.65;
  color: var(--muted);
}

.nos-list div::before {
  content: "×";
  position: absolute;
  left: 0;
  top: 0;
  font-family: var(--mono);
  font-size: 11px;
  color: rgba(255, 84, 96, 0.6);
}

.workflow {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.workflow-group {
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.018);
}

.wf-group-head {
  padding: 11px 13px 9px;
  border-bottom: 1px dashed rgba(243, 199, 119, 0.14);
  background: rgba(243, 199, 119, 0.025);
}

.wf-group-id {
  display: flex;
  align-items: center;
  gap: 8px;
}

.wf-phase {
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid rgba(243, 199, 119, 0.28);
  background: rgba(243, 199, 119, 0.08);
  font-size: 10.5px;
  letter-spacing: 0.12em;
  color: var(--gold);
}

.wf-phase--pre {
  border-color: rgba(143, 183, 255, 0.28);
  background: rgba(143, 183, 255, 0.08);
  color: #9dbfff;
}

.wf-phase--open {
  border-color: rgba(127, 209, 168, 0.28);
  background: rgba(127, 209, 168, 0.08);
  color: #7fd1a8;
}

.wf-group-id b {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text-soft);
}

.wf-group-head p {
  margin: 5px 0 0;
  font-size: 11.3px;
  line-height: 1.6;
  color: var(--dim);
}

.wf-steps {
  padding: 10px 13px 12px;
}

.wf-step {
  display: grid;
  grid-template-columns: 16px 1fr;
  gap: 9px;
}

.wf-step + .wf-step {
  margin-top: 12px;
}

.wf-rail {
  position: relative;
  display: flex;
  justify-content: center;
}

.wf-dot {
  width: 7px;
  height: 7px;
  margin-top: 4px;
  border-radius: 50%;
  background: var(--gold);
  box-shadow: 0 0 0 3px rgba(243, 199, 119, 0.1);
}

.wf-rail i {
  position: absolute;
  top: 14px;
  bottom: -5px;
  width: 1px;
  background: linear-gradient(180deg, rgba(243, 199, 119, 0.26), rgba(243, 199, 119, 0.04));
}

.wf-body {
  min-width: 0;
}

.wf-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.wf-title b {
  font-size: 13px;
  font-weight: 650;
  color: var(--text-soft);
}

.wf-title span {
  flex: none;
  font-size: 10.3px;
  color: var(--dim);
}

.wf-body > p {
  margin: 4px 0 0;
  font-size: 11.6px;
  line-height: 1.68;
  color: var(--muted);
}

.wf-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 6px;
  padding: 6px 8px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.025);
}

.wf-out,
.wf-veto {
  font-size: 10.6px;
  line-height: 1.55;
}

.wf-out {
  color: rgba(127, 209, 168, 0.8);
}

.wf-veto {
  color: rgba(255, 154, 162, 0.78);
}

.stage-rail {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 4px;
  margin-bottom: 10px;
}

.stage-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 5px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.02);
  text-align: center;
}

.stage-cell b {
  font-size: 12px;
  color: var(--text-soft);
}

.stage-cell span {
  font-size: 11px;
  color: var(--muted);
}

.stage-cell small {
  font-size: 9.8px;
  color: var(--dim);
}

.stage-cell--trial b {
  color: #9dbfff;
}

.stage-cell--locked {
  border-color: rgba(243, 199, 119, 0.26);
  background: rgba(243, 199, 119, 0.05);
}

.stage-cell--locked b {
  color: var(--gold);
}

.stage-cell--final b {
  color: #ff9aa2;
}

.stage-cell--open b {
  color: #7fd1a8;
}

.honesty-box {
  margin-top: 10px;
}

.honesty-box b {
  display: block;
  margin-bottom: 4px;
  font-size: 12px;
  color: #f3c777;
}

.honesty-box p {
  margin: 0;
  font-size: 11.4px;
  line-height: 1.72;
  color: var(--muted);
}

.plan-spec {
  margin-top: 10px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.018);
}

.plan-spec-bar {
  display: grid;
  grid-template-columns: 1fr 1.4fr 1fr;
  gap: 1px;
  background: var(--line);
}

.ps-zone {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 9px 6px;
  background: var(--panel);
  text-align: center;
}

.ps-zone b {
  font-size: 12.5px;
}

.ps-zone small {
  font-size: 9.8px;
  color: var(--dim);
}

.ps-zone--abandon b {
  color: #7fd1a8;
}

.ps-zone--buy {
  background: rgba(243, 199, 119, 0.06);
}

.ps-zone--buy b {
  color: var(--gold);
}

.ps-zone--cancel b {
  color: #ff8d96;
}

.plan-spec-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1px;
  background: var(--line);
}

.plan-spec-grid > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 4px;
  background: var(--panel);
  text-align: center;
}

.plan-spec-grid small {
  font-size: 9.8px;
  color: var(--dim);
}

.plan-spec-grid b {
  font-size: 12.5px;
  color: var(--text-soft);
}

.window-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  margin-bottom: 10px;
}

.window-card {
  padding: 9px 9px 8px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.02);
}

.window-card b {
  display: block;
  font-size: 12px;
  letter-spacing: 0.03em;
}

.window-card p {
  margin: 3px 0 0;
  font-size: 10.4px;
  line-height: 1.55;
  color: var(--muted);
}

.window-card--0 {
  border-color: rgba(255, 84, 96, 0.22);
  background: rgba(255, 84, 96, 0.04);
}

.window-card--0 b {
  color: #ff9aa2;
}

.window-card--1 {
  border-color: rgba(255, 180, 94, 0.2);
  background: rgba(255, 180, 94, 0.04);
}

.window-card--1 b {
  color: var(--warn);
}

.window-card--2 {
  border-color: rgba(43, 211, 154, 0.2);
  background: rgba(43, 211, 154, 0.04);
}

.window-card--2 b {
  color: #7ce6bf;
}

.weak-panel,
.gene-panel,
.core-panel {
  margin-bottom: 10px;
}

.weak-panel h4,
.gene-panel h4,
.core-panel h4 {
  margin: 0 0 7px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--gold);
}

.weak-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.weak-row:last-child {
  border-bottom: 0;
}

.weak-score {
  flex: 0 0 auto;
  width: 27px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  border: 1px solid var(--gold-line);
  background: var(--gold-soft);
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--gold);
}

.weak-main {
  min-width: 0;
  flex: 1;
}

.weak-main b {
  font-size: 12px;
  font-weight: 600;
}

.weak-main p {
  margin: 2px 0 0;
  font-size: 10.7px;
  line-height: 1.55;
  color: var(--muted);
}

.gene-row {
  padding: 6px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.gene-label {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
  font-size: 11px;
}

.gene-label b {
  font-weight: 600;
  color: var(--text-soft);
}

.gene-label span {
  font-size: 10.5px;
  color: var(--gold);
}

.gene-bar {
  height: 4px;
  margin-top: 4px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.05);
  overflow: hidden;
}

.gene-bar i {
  display: block;
  max-width: 100%;
  height: 100%;
  border-radius: 3px;
  background: linear-gradient(90deg, rgba(243, 199, 119, 0.55), var(--gold));
}

.gene-row p {
  margin: 4px 0 0;
  font-size: 10.5px;
  line-height: 1.55;
  color: var(--dim);
}

.core-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.core-row:last-of-type {
  border-bottom: 0;
}

.core-tag {
  flex: 0 0 auto;
  min-width: 58px;
  padding: 2px 6px;
  border-radius: 5px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.03);
  text-align: center;
  font-size: 10px;
  line-height: 1.5;
  color: var(--muted);
}

.core-tag.is-core {
  border-color: rgba(226, 116, 100, 0.45);
  background: rgba(226, 116, 100, 0.12);
  color: #f0a596;
}

.core-row p {
  margin: 0;
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--dim);
}

.gene-note {
  margin: 9px 0 0;
  padding-top: 8px;
  border-top: 1px dashed rgba(255, 255, 255, 0.07);
  font-size: 10.5px;
  line-height: 1.65;
  color: var(--muted);
}

.node-panel .core-tag {
  min-width: 68px;
}

.node-weights {
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px dashed rgba(255, 255, 255, 0.07);
}

.profile-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px;
  margin-bottom: 10px;
}

.profile-dim {
  padding: 9px 10px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.02);
}

.profile-dim small {
  display: block;
  font-size: 10.4px;
  color: var(--dim);
}

.profile-dim b {
  display: block;
  margin-top: 2px;
  font-size: 13px;
  color: var(--gold);
}

.profile-dim p {
  margin: 3px 0 0;
  font-size: 10.7px;
  line-height: 1.55;
  color: var(--muted);
}

.method-panel h4,
.verify-panel h4 {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 650;
  color: var(--text-soft);
}

.method-line {
  display: grid;
  grid-template-columns: 22px 1fr;
  gap: 6px;
  margin-top: 7px;
}

.method-line span {
  padding-top: 1px;
  font-size: 10.3px;
  color: rgba(243, 199, 119, 0.58);
}

.method-line p {
  margin: 0;
  font-size: 11.4px;
  line-height: 1.68;
  color: var(--muted);
}

.accuracy-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}

.accuracy-card {
  display: grid;
  grid-template-columns: 22px 1fr;
  gap: 7px;
  padding: 9px 10px;
  border: 1px solid var(--line);
  border-left: 2px solid rgba(243, 199, 119, 0.35);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.018);
}

.accuracy-card > span {
  padding-top: 1px;
  font-size: 10.3px;
  color: rgba(243, 199, 119, 0.58);
}

.accuracy-card b {
  font-size: 12.2px;
  font-weight: 650;
  color: var(--text-soft);
}

.accuracy-card p {
  margin: 4px 0 0;
  font-size: 11.2px;
  line-height: 1.65;
  color: var(--muted);
}

.verify-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.verify-panel p {
  margin: 8px 0 0;
  font-size: 11.2px;
  line-height: 1.65;
  color: var(--dim);
}

.trader-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 10px;
}

.trader-card {
  padding: 12px 13px;
  border: 1px solid var(--line);
  border-left: 2px solid rgba(243, 199, 119, 0.38);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.02);
}

.trader-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
}

.trader-head b {
  font-size: 14px;
  color: var(--gold);
}

.trader-head span {
  font-size: 10px;
  color: var(--dim);
}

.trader-core {
  margin: 6px 0 0;
  font-size: 11.6px;
  line-height: 1.65;
  color: var(--text-soft);
}

.trader-block {
  margin-top: 8px;
  padding-top: 7px;
  border-top: 1px dashed rgba(255, 255, 255, 0.07);
}

.trader-block small {
  display: block;
  font-size: 9.5px;
  letter-spacing: 0.08em;
  color: var(--dim);
}

.trader-block ul {
  margin: 5px 0 0;
  padding-left: 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.trader-block li {
  font-size: 10.8px;
  line-height: 1.62;
  color: var(--muted);
}

.trader-block ul.is-encoded li::marker {
  color: rgba(243, 199, 119, 0.8);
}

.trader-no {
  margin: 8px 0 0;
  font-size: 10.6px;
  line-height: 1.6;
  color: var(--dim);
}

.trader-no b {
  display: inline-block;
  margin-right: 5px;
  font-weight: 600;
  color: var(--warn);
}

.source-panel h4 {
  margin: 0 0 7px;
  font-size: 12px;
  font-weight: 650;
  color: var(--text-soft);
}

.source-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.source-list a {
  font-size: 10.8px;
  line-height: 1.5;
  color: rgba(243, 199, 119, 0.82);
  text-decoration: none;
  word-break: break-all;
}

.source-list a:active {
  color: var(--gold);
}

.source-panel p {
  margin: 8px 0 0;
  font-size: 10.4px;
  line-height: 1.6;
  color: var(--dim);
}
</style>