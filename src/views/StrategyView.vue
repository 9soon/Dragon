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
    title: '催化关 · 题材纯正',
    body:
      '政策文件、产业订单/涨价/技术突破、事件驱动，至少有一项可核实证据。纯传闻、无信源小作文、蹭热点改名，直接排除。未核验催化的个股只显示观察分，不解除观察状态。',
    check: '对应动作：每个板块右上角「催化核验」，人工标记'
  },
  {
    no: '04',
    title: '资金关 · 连续两日净流入',
    body:
      '板块连续 2 个交易日主力净流入。当天脉冲、次日集体低开的一日游，在资金维度就过不了关。接口受限时展示「今日 + 5 日」金色近似参考，但资金关仍算未通过。',
    check: '对应数据：money.today / yesterday / proxy'
  }
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
          '逐项检查连续两日家数、高 / 中 / 低梯队、连续两日资金。任一关缺失就保留观察，不用近似值放行。',
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
          '只在三关 + 情绪修复 / 主升时制定。写清高开执行区间、放弃区间、止损与仓位，不用“感觉会涨”替代条件。',
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
  ]
]

const overnightRules = [
  ['只在三关 + 修复 / 主升', '数据未就绪、冰点、退潮、混沌都不挂隔夜单；没有主线时，空仓就是最优解。'],
  ['只做板块核心 2–5 板', '优先情绪连板龙与趋势中军，不碰杂毛补涨；5 板以上只观察，炸过板的降级。'],
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
        <span class="section-count">01 / 02 / 04 数据三关 · 03 人工核验</span>
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
        <span class="section-title">竞价抓强 · 五条硬规则</span>
        <span class="section-count">9:15–9:30 · 1.5 秒刷新</span>
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
          <span>54% 角色分 + 30% 板块热度 + 16% 板块就绪度；炸板、尾盘封板、高位爆量、薄封单分别扣分。</span>
        </div>
        <div class="formula-row">
          <code>封顶</code>
          <span>未过三关的板块，个股最高 68 分；新起题材最高 60 分，并统一标记「仅观察」。</span>
        </div>
        <div class="formula-row">
          <code>情绪</code>
          <span>25% 昨日涨停溢价 + 20% 涨停家数 + 20% 连板高度 + 20% 封板质量 + 15% 晋级率。</span>
        </div>
        <div class="formula-row">
          <code>竞价</code>
          <span>90% ×（30% 涨幅 + 28% 竞价额 + 24% 板块共振 + 18% 封板质量）× 情绪系数 + 10% 画像分。</span>
        </div>
        <div class="formula-row">
          <code>确认</code>
          <span>竞价分 ≥ 72，且涨幅 +2% ~ +8%、竞价额 ≥ 2000 万且 ≥ 昨成交 2%、同板块 ≥ 2 只强势、三关通过、催化已核验。</span>
        </div>
        <div class="formula-row">
          <code>隔夜</code>
          <span>56% 个股基础分 + 30% 画像分 + 14% 板块热度；三关、情绪修复 / 主升、催化核验缺一不可。</span>
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
          <span>东方财富板块资金流公开接口；受限时展示本机持久化的每日快照与「今日 + 5 日」金色近似参考，并明确标注，不视为通过资金关。</span>
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
  font-size: 9.5px;
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
  font-size: 10px;
}

.gate-mirror b {
  font-size: 13px;
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
  font-size: 8.5px;
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
  font-size: 13px;
  letter-spacing: 0.08em;
  color: #e8d3a8;
}

.discipline p {
  margin: 3px 0 0;
  font-size: 10px;
  line-height: 1.7;
  color: var(--muted);
}

.source-honest {
  margin: 8px 0 0;
  padding-top: 8px;
  border-top: 1px dashed rgba(255, 255, 255, 0.07);
  font-size: 9.5px;
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
  font-size: 10px;
  line-height: 1.65;
  color: var(--muted);
}

.nos-list div::before {
  content: "×";
  position: absolute;
  left: 0;
  top: 0;
  font-family: var(--mono);
  font-size: 9px;
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
  font-size: 8.5px;
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
  font-size: 9.5px;
  font-weight: 500;
  color: var(--text-soft);
}

.wf-group-head p {
  margin: 5px 0 0;
  font-size: 9.3px;
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
  font-size: 11.5px;
  font-weight: 650;
  color: var(--text-soft);
}

.wf-title span {
  flex: none;
  font-size: 8.3px;
  color: var(--dim);
}

.wf-body > p {
  margin: 4px 0 0;
  font-size: 9.6px;
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
  font-size: 8.6px;
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
  grid-template-columns: repeat(4, 1fr);
  gap: 5px;
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
  font-size: 10.5px;
  color: var(--text-soft);
}

.stage-cell span {
  font-size: 9px;
  color: var(--muted);
}

.stage-cell small {
  font-size: 7.8px;
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
  font-size: 10.5px;
  color: #f3c777;
}

.honesty-box p {
  margin: 0;
  font-size: 9.4px;
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
  font-size: 11px;
}

.ps-zone small {
  font-size: 7.8px;
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
  font-size: 7.8px;
  color: var(--dim);
}

.plan-spec-grid b {
  font-size: 11px;
  color: var(--text-soft);
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
  font-size: 8.4px;
  color: var(--dim);
}

.profile-dim b {
  display: block;
  margin-top: 2px;
  font-size: 11.5px;
  color: var(--gold);
}

.profile-dim p {
  margin: 3px 0 0;
  font-size: 8.7px;
  line-height: 1.55;
  color: var(--muted);
}

.method-panel h4,
.verify-panel h4 {
  margin: 0 0 6px;
  font-size: 10.5px;
  font-weight: 650;
  color: var(--text-soft);
}

.method-line {
  display: grid;
  grid-template-columns: 20px 1fr;
  gap: 6px;
  margin-top: 7px;
}

.method-line span {
  padding-top: 1px;
  font-size: 8.3px;
  color: rgba(243, 199, 119, 0.58);
}

.method-line p {
  margin: 0;
  font-size: 9.4px;
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
  font-size: 8.3px;
  color: rgba(243, 199, 119, 0.58);
}

.accuracy-card b {
  font-size: 10.2px;
  font-weight: 650;
  color: var(--text-soft);
}

.accuracy-card p {
  margin: 4px 0 0;
  font-size: 9.2px;
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
  font-size: 9.2px;
  line-height: 1.65;
  color: var(--dim);
}
</style>