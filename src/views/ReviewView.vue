<script setup>
import { computed, onMounted, ref } from 'vue'
import MarketMood from '../components/MarketMood.vue'
import { fmtMoney, fmtNum, fmtPct, fmtPrice, pctTone } from '../lib/format'
import { getRecAudit } from '../lib/api'

const props = defineProps({
  dashboard: { type: Object, required: true }
})

const review = computed(() => props.dashboard.review || {})
const sentiment = computed(() => props.dashboard.sentiment)
const tiers = computed(() => (review.value.prevPremium && review.value.prevPremium.byTier) || [])
const promotion = computed(() => review.value.promotion || sentiment.value.promotion || {})
const ladder = computed(() => review.value.ladder || [])
const ladderFlow = computed(() => review.value.ladderFlow || {})
const flowRows = computed(() => ladderFlow.value.rows || [])
const flowReady = computed(() => !!ladderFlow.value.prevReady)
const eliminated = computed(() => ladderFlow.value.stocks || [])
const firstTierEliminated = computed(() => {
  const row = flowRows.value.find((x) => x.lbc === 1)
  return row ? row.eliminated : 0
})
const showAllElim = ref(false)
const eliminatedShown = computed(() =>
  showAllElim.value ? eliminated.value : eliminated.value.slice(0, 6)
)
const distribution = computed(() => review.value.distribution || [])
const maxDist = computed(() => Math.max(1, ...distribution.value.map((x) => x.todayCount)))
const blown = computed(() => review.value.blownTop || [])
const down = computed(() => review.value.downTop || [])
const plan = computed(() => review.value.plan || null)
const planAction = computed(() => (plan.value && plan.value.action) || null)
const planBlocked = computed(() => !!planAction.value && planAction.value.canAct === 'no')
const nearGateSectors = computed(() => {
  const gate = props.dashboard.gate || {}
  if (gate.key !== 'empty') return []
  const sectors = props.dashboard.sectors || {}
  const seen = new Set()
  const pool = []
  for (const list of [sectors.mainCandidates, sectors.newThemes]) {
    for (const s of list || []) {
      if (!s || s.gatesPassed !== 2 || seen.has(s.name)) continue
      seen.add(s.name)
      pool.push(s)
    }
  }
  return pool
    .sort(
      (a, b) =>
        (b.todayCount || 0) - (a.todayCount || 0) ||
        ((b.ladder && b.ladder.score) || 0) - ((a.ladder && a.ladder.score) || 0)
    )
    .slice(0, 4)
})

function sectorMoneyPass(s) {
  const check = ((s && s.checks) || []).find((c) => c.key === 'money')
  const evidence = (check && check.evidence) || []
  return {
    pass: evidence.filter((e) => e.state === 'pass').length,
    total: evidence.length
  }
}

function sectorFailReason(s) {
  const checks = (s && s.checks) || []
  const labels = new Set(checks.map((c) => c.label))
  const parts = checks
    .filter((c) => !c.pass)
    .map((c) => `${c.label}：${c.detail || '未通过'}`)
  const extra = ((s && s.missing) || []).filter((m) => !labels.has(m))
  if (extra.length) parts.push(`数据缺口：${extra.join('、')}`)
  const pending = checks
    .flatMap((c) => c.evidence || [])
    .filter((e) => e.state === 'unknown')
    .map((e) => e.label)
  if (pending.length) parts.push(`数据待确认：${pending.join('、')}`)
  return parts.join('；')
}
const promoRank = computed(() => (plan.value && plan.value.promotionRank) || [])
const heightWatch = computed(() => (plan.value && plan.value.heightWatch) || [])
const oneWordWatch = computed(() => (plan.value && plan.value.oneWordWatch) || [])
const nuclearWatch = computed(() => (plan.value && plan.value.nuclearWatch) || [])
const rejected = computed(
  () => (plan.value && plan.value.rejected) || { total: 0, samples: [] }
)
const planReview = computed(() => (plan.value && plan.value.review) || [])
const calibration = computed(() => (plan.value && plan.value.calibration) || null)
const calBuckets = computed(() => (calibration.value && calibration.value.buckets) || [])
const showCalibration = ref(false)
const showRejected = ref(false)
const hotshot = computed(() => (plan.value && plan.value.hotshot) || null)
const hotshotToday = computed(
  () => (hotshot.value && hotshot.value.today && hotshot.value.today.list) || []
)
const hotshotReady = computed(
  () => (hotshot.value && hotshot.value.tomorrow && hotshot.value.tomorrow.ready) || []
)
const hotshotWatch = computed(
  () => (hotshot.value && hotshot.value.tomorrow && hotshot.value.tomorrow.watch) || []
)
const overnightBrief = computed(() => props.dashboard.overnightBrief || null)
const overnightTop = computed(() =>
  ((overnightBrief.value && overnightBrief.value.recommendations) || []).slice(0, 3)
)
const overnightModeKey = computed(
  () => (overnightBrief.value && overnightBrief.value.mode && overnightBrief.value.mode.key) || ''
)
const overnightFinal = computed(() => overnightModeKey.value === 'final')
const overnightModeLabel = computed(
  () =>
    ({
      final: '盘后定稿',
      preview: '盘中预演',
      locked: '盘前不追加'
    })[overnightModeKey.value] || '隔夜计划'
)
const tailBrief = computed(() => props.dashboard.tailBrief || null)
const tailTop = computed(() => ((tailBrief.value && tailBrief.value.items) || []).slice(0, 3))
const tailVisible = computed(
  () => !!(tailBrief.value && tailBrief.value.mode !== 'before')
)
const tailTone = computed(() => {
  const status = tailBrief.value ? tailBrief.value.status : ''
  if (status === 'closed' || status === 'ready' || status === 'live') return 'chip--gold'
  if (status === 'empty') return 'chip--warn'
  return 'chip--dim'
})
const recAudit = ref(null)
const recLoading = ref(false)
const recError = ref('')
const showAllRecDays = ref(false)
const recActionable = computed(() => (recAudit.value && recAudit.value.actionable) || {})
const recWatch = computed(() => (recAudit.value && recAudit.value.watch) || {})
const recDays = computed(() => (recAudit.value && recAudit.value.days) || [])
const recDaysShown = computed(() =>
  showAllRecDays.value ? recDays.value : recDays.value.slice(0, 4)
)
const recToday = computed(() => (recAudit.value && recAudit.value.today) || null)
const recWinTone = computed(() => {
  const v = recActionable.value.winRate
  if (v == null) return 'is-flat'
  return v >= 50 ? 'is-up' : 'is-down'
})
const recNoEntryReason = computed(() => {
  const counts = {}
  for (const day of recDays.value) {
    if (!day.actionable) continue
    for (const row of day.rows || []) {
      if (row.status !== 'evaluated' || row.trigger === 'trigger') continue
      counts[row.trigger] = (counts[row.trigger] || 0) + 1
    }
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => `${TRIGGER_LABELS[key] || key} ${n}`)
    .join(' · ')
})

const recOvernight = computed(() => (recAudit.value && recAudit.value.overnight) || null)
const onWindow = computed(() => (recOvernight.value && recOvernight.value.window) || {})
const onStrict = computed(() => (recOvernight.value && recOvernight.value.strict) || {})
const onStandby = computed(() => (recOvernight.value && recOvernight.value.standby) || {})
const onPrep = computed(() => (recOvernight.value && recOvernight.value.prep) || {})
const onWatch = computed(() => (recOvernight.value && recOvernight.value.watch) || {})
const onLearning = computed(() => (recOvernight.value && recOvernight.value.learning) || null)
const onGates = computed(() => (recOvernight.value && recOvernight.value.gates) || null)
const onDays = computed(() => (recOvernight.value && recOvernight.value.days) || [])
const onDaysShown = computed(() => onDays.value.slice(0, 3))
const onShowObservations = ref(false)
const onShareText = computed(
  () =>
    (recOvernight.value && recOvernight.value.share && recOvernight.value.share.text) || ''
)
const shareState = ref('')
const onBuckets = computed(() => (onLearning.value && onLearning.value.buckets) || {})
const onGapBuckets = computed(() =>
  ((onBuckets.value && onBuckets.value.gap) || []).filter((b) => b.samples)
)
const onScoreBuckets = computed(() =>
  ((onBuckets.value && onBuckets.value.score) || []).filter((b) => b.samples)
)
const onLbcBuckets = computed(() =>
  ((onBuckets.value && onBuckets.value.lbc) || []).filter((b) => b.samples)
)
const onHeatBuckets = computed(() =>
  ((onBuckets.value && onBuckets.value.heat) || []).filter((b) => b.samples)
)
const onGatesLine = computed(() => {
  const g = onGates.value
  if (!g || !g.days) return ''
  const miss = (g.topMissing || [])
    .map((x) => `${x.label} ${x.count} 次`)
    .join(' · ')
  return `近 ${g.days} 个定稿日：三关全过 ${g.passDays} 天${
    miss ? `；最强板块常见缺口：${miss}` : ''
  }`
})

const ON_TRIGGER_LABELS = {
  lowOpen: '低开 <-2%',
  flatOpen: '平开 -2~1%',
  trigger: '触发 1–4%',
  highChase: '高开 4–6%',
  abandonGap: '放弃 >6%',
  unknown: '待核对'
}

function onTriggerLabel(row) {
  if (row.status === 'pending') return '待次日'
  if (row.status === 'noKline' || row.status === 'badBar') return '数据缺失'
  return ON_TRIGGER_LABELS[row.trigger] || '待核对'
}

function visibleOnRows(day) {
  const rows = (day && day.rows) || []
  if (onShowObservations.value) return rows
  return rows.filter((row) => row.cohort === 'strict')
}

async function writeClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch (err) {
      /* 无剪贴板权限时退回旧方案 */
    }
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.top = '-1000px'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch (err) {
    ok = false
  }
  document.body.removeChild(ta)
  return ok
}

async function copyOvernightShare() {
  if (!onShareText.value) return
  const ok = await writeClipboard(onShareText.value)
  shareState.value = ok ? '已复制，可直接分享' : '复制失败，请长按选择文本'
  setTimeout(() => {
    shareState.value = ''
  }, 2200)
}

async function loadRecAudit(force = false) {
  if (recLoading.value) return
  recLoading.value = true
  recError.value = ''
  try {
    recAudit.value = await getRecAudit({ days: 10, force })
  } catch (err) {
    recError.value = err.message || '核对失败'
  } finally {
    recLoading.value = false
  }
}

onMounted(() => loadRecAudit())

const TRIGGER_LABELS = {
  trigger: '触发买点',
  flatOpen: '平开未触发',
  lowOpen: '低开未触发',
  highChase: '偏高未追',
  abandonGap: '高开放弃',
  unknown: '待核对'
}

function triggerLabel(row) {
  if (row.status === 'pending') return '待次日收盘'
  if (row.status !== 'evaluated') return '无有效日线'
  return TRIGGER_LABELS[row.trigger] || '待核对'
}

function signed(v, suffix = '%') {
  if (v == null) return '--'
  return `${v > 0 ? '+' : ''}${v}${suffix}`
}

function retTone(v) {
  if (v == null) return 'is-flat'
  return v > 0 ? 'is-up' : v < 0 ? 'is-down' : 'is-flat'
}

function shortDate(stamp) {
  return stamp ? `${stamp.slice(4, 6)}-${stamp.slice(6, 8)}` : '--'
}

function nightTags(c) {
  return Array.from(new Set((c && c.tags) || [])).slice(0, 4)
}

const live = computed(() => props.dashboard.dataMode === 'live')
const snapshotLabel = computed(() => {
  const d = props.dashboard
  const m = d.market || {}
  if (d.dataMode === 'live') return '盘中实时'
  if (!d.isTodayData) {
    return ['preopen', 'auction', 'waiting'].includes(m.key) ? '盘前快照' : '最近交易日'
  }
  if (m.key === 'lunch') return '午间快照'
  return '收盘快照'
})

const promotionOverall = computed(() => promotion.value.overall || {})
const promotionCore = computed(() => sentiment.value.promotionCore || null)
const premium = computed(() => sentiment.value.premium || {})

function elimChip(item) {
  if (item.status === 'blown') return 'chip--red'
  if (item.status === 'limitDown') return 'chip--green'
  if (item.status === 'noQuote') return 'chip--dim'
  return 'chip--warn'
}

const conclusion = computed(() => {
  const s = sentiment.value
  const gate = props.dashboard.gate || {}
  const parts = []
  parts.push(
    `今日涨停 ${s.limitUp} 家，最高 ${s.maxBoard} 板，炸板率 ${s.blowRate}%，昨日涨停溢价 ${
      premium.value.skip ? '待更新' : fmtPct(premium.value.avg)
    }。`
  )
  if (promotionCore.value && promotionCore.value.rate != null) {
    parts.push(
      `主板晋级率 ${promotionCore.value.rate}%（${promotionCore.value.promoted}/${promotionCore.value.total}），全市场 ${
        promotionOverall.value.rate == null ? '--' : `${promotionOverall.value.rate}%`
      }（${promotionOverall.value.promoted || 0}/${promotionOverall.value.total || 0}）。`
    )
  } else if (promotionOverall.value.rate != null) {
    parts.push(`整体晋级率 ${promotionOverall.value.rate}%（${promotionOverall.value.promoted}/${promotionOverall.value.total}）。`)
  }
  if (gate.key === 'empty') {
    parts.push('没有板块同时通过连续性、梯队与资金三关，情绪再好也缺少主线载体。按口诀：无主线，空仓等待。')
  } else if (gate.key === 'defend') {
    parts.push('虽有板块数据达标，但情绪处于退潮/冰点区间。降低频率，只跟踪最强核心，不参与一致加速。')
  } else {
    parts.push('已有板块通过数据三关。下一步只做人工催化核验，围绕最强核心制定分歧买点，不做跟风补涨的临时起意。')
  }
  parts.push('复盘写在收盘后，执行放在计划里；不把盘中冲动带进明天的交易。')
  return parts.join('')
})

function tierTone(v) {
  if (v == null) return 'is-flat'
  return v > 0 ? 'is-up' : v < 0 ? 'is-down' : 'is-flat'
}
</script>

<template>
  <div class="view">
    <section class="review-head">
      <div class="eyebrow">盘后复盘 · REVIEW</div>
      <div class="review-title-row">
        <h2>{{ dashboard.tradeDateLabel }} 复盘</h2>
        <span class="chip chip--dim">上一交易日 {{ dashboard.prevTradeDateLabel || '--' }}</span>
      </div>
      <p class="review-desc">
        先看作战室结论，再看情绪温度、昨日涨停赚钱效应与连板天梯。复盘不是总结涨了多少，而是判断明天该不该出手、只做哪只核心。
      </p>
    </section>

    <div v-if="live" class="review-banner">
      <span>●</span>
      <div><b>盘中快照：</b>数据会随封板与炸板变化，收盘后再次打开复盘会更完整。</div>
    </div>

    <MarketMood :sentiment="dashboard.sentiment" />

    <section class="section rec-audit-section">
      <header class="section-head">
        <span class="section-title">推荐复盘</span>
        <span class="section-count">近 10 日 · 次日日线核对</span>
      </header>

      <div class="panel rec-audit">
        <div v-if="!recAudit && recLoading" class="rec-empty">
          正在用次日日线核对此前的晋级榜与明日待选…
        </div>
        <div v-else-if="!recAudit && recError" class="rec-empty">
          核对失败：{{ recError }}
          <button class="rec-retry" type="button" @click="loadRecAudit(true)">重试</button>
        </div>
        <template v-else-if="recAudit">
          <div class="rec-stats">
            <div class="rec-stat">
              <small>可执行样本</small>
              <b>{{ recActionable.evaluated || 0 }}</b>
              <span>共记录 {{ recActionable.samples || 0 }}</span>
            </div>
            <div class="rec-stat">
              <small>触发买点</small>
              <b>{{ recActionable.triggered || 0 }}</b>
              <span>按计划竞价区间</span>
            </div>
            <div class="rec-stat">
              <small>触发胜率</small>
              <b :class="recWinTone">
                {{ recActionable.winRate != null ? recActionable.winRate + '%' : '--' }}
              </b>
              <span>{{ recActionable.wins || 0 }} 胜 / {{ recActionable.triggered || 0 }}</span>
            </div>
            <div class="rec-stat">
              <small>触发均收益</small>
              <b :class="retTone(recActionable.avgRet)">{{ signed(recActionable.avgRet) }}</b>
              <span>开盘→收盘</span>
            </div>
            <div class="rec-stat">
              <small>次日晋级率</small>
              <b>{{ recActionable.promoRate != null ? recActionable.promoRate + '%' : '--' }}</b>
              <span>{{ recActionable.promoted || 0 }} / {{ recActionable.evaluated || 0 }} 只</span>
            </div>
          </div>

          <p class="rec-caveat">
            <template v-if="recActionable.triggered && recActionable.triggered < 5">
              触发样本只有 {{ recActionable.triggered }} 只，只能看方向，不能当稳定胜率。
            </template>
            <template v-else-if="!recActionable.triggered && recActionable.evaluated">
              没有一只按计划竞价区间成交<template v-if="recNoEntryReason">（{{ recNoEntryReason }}）</template>，
              说明“看对晋级”和“买得到”是两件事。
            </template>
            <template v-else-if="!recActionable.evaluated">
              还没有完成次日的可执行样本；台账只记录复盘明确给出的晋级榜 / 明日待选。
            </template>
            <template v-else>
              触发样本按计划竞价区间买入、当日收盘卖出统计，不按事后最优价假设成交。
            </template>
          </p>

          <div v-if="recToday" class="rec-today">
            今天已记录 {{ recToday.items }} 只（{{ recToday.action && recToday.action.label }}），
            {{ recToday.final ? '已收盘定稿' : '收盘后定稿' }}，明日收盘后核对结果。
            <template v-if="recToday.overnight">
              隔夜台账：严格 {{ recToday.overnight.strict }} · 待命
              {{ recToday.overnight.standby || 0 }} · 准备
              {{ recToday.overnight.prep }} · 观察 {{ recToday.overnight.watch }}。
            </template>
            <p
              v-if="recToday.action && recToday.action.blockers && recToday.action.blockers.length"
              class="rec-blockers"
            >
              为什么：{{ recToday.action.blockers.join('；') }}
            </p>
          </div>

          <div v-if="recWatch.evaluated" class="rec-watch-line">
            观察窗口（当时计划明确不出手）：{{ recWatch.evaluated }} 只已核对，触发
            {{ recWatch.triggered }} 只<template v-if="recWatch.winRate != null">
              ，触发胜率 {{ recWatch.winRate }}%</template
            >。这些样本不计入上面的可执行胜率。
          </div>

          <div v-if="recDays.length" class="rec-days">
            <div v-for="day in recDaysShown" :key="day.date" class="rec-day">
              <div class="rec-day-head">
                <b>{{ shortDate(day.date) }}</b>
                <span class="chip" :class="day.actionable ? 'chip--warn' : 'chip--dim'">
                  {{ day.actionable ? '可执行' : '只观察' }}
                </span>
                <span class="rec-day-action">{{ day.action && day.action.label }}</span>
                <span class="rec-day-stat">
                  触发 {{ day.stats.triggered }}/{{ day.stats.evaluated }}
                  <template v-if="day.stats.winRate != null"> · 胜率 {{ day.stats.winRate }}%</template>
                </span>
              </div>
              <div v-for="row in day.rows" :key="row.code" class="rec-row">
                <b>{{ row.name }}</b>
                <span class="rec-code">{{ row.code }}</span>
                <span>{{ row.lbc }} 板</span>
                <span :class="retTone(row.gap)">缺口 {{ signed(row.gap) }}</span>
                <span :class="retTone(row.dayRet)">开→收 {{ signed(row.dayRet) }}</span>
                <span class="rec-trigger" :class="{ 'is-hit': row.trigger === 'trigger' }">
                  {{ triggerLabel(row) }}
                </span>
                <span v-if="row.promoted" class="chip chip--red">晋级</span>
                <span v-else-if="row.touchedLimit" class="chip chip--warn">触板未封</span>
              </div>
            </div>
          </div>

          <button
            v-if="recDays.length > 4"
            class="rec-toggle"
            type="button"
            @click="showAllRecDays = !showAllRecDays"
          >
            {{ showAllRecDays ? '收起，只看最近 4 日' : `展开全部 ${recDays.length} 日` }}
          </button>

          <p class="rec-note">
            只统计复盘里明确给出的“明日连板晋级榜 / 明日打板待选”，并剔除一字 / 秒板；首页观察池、准备池和预警不计入。
            触发口径按计划：首板竞价 +1%–4%，连板 +1%–3%；缺口 &gt;5%/6% 或 &lt; -2% 视为未触发，
            触发样本用次日开盘价近似竞价成交，不按事后最优价假设成交。盘中快照未在收盘后定稿的交易日不纳入统计。
          </p>
        </template>
      </div>
    </section>

    <section v-if="overnightBrief" class="section night-section">
      <header class="section-head">
        <span class="section-title">隔夜三强</span>
        <span class="section-count">{{ overnightModeLabel }} · 最多 3 只 · 按隔夜分</span>
      </header>

      <div class="panel night-panel">
        <div class="night-head">
          <span class="chip" :class="overnightFinal ? 'chip--gold' : 'chip--dim'">
            {{ overnightBrief.statusLabel }}
          </span>
          <p>{{ overnightBrief.reason }}</p>
        </div>

        <div v-if="overnightTop.length" class="night-list">
          <article v-for="(c, i) in overnightTop" :key="c.code" class="night-row">
            <span class="night-rank">{{ i + 1 }}</span>
            <div class="night-body">
              <div class="night-name">
                <b>{{ c.name }}</b>
                <span class="mono">{{ c.code }}</span>
                <span class="chip chip--dim">{{ c.lbc }} 板</span>
                <span class="night-sector">{{ c.sector }}</span>
              </div>
              <div class="night-meta">
                <span>隔夜分 <b>{{ c.score }}</b></span>
                <span>收盘 {{ fmtPrice(c.close) }}</span>
                <span>涨停价 <b class="is-up">{{ fmtPrice(c.limitUp) }}</b></span>
                <span>{{ c.boardRule }}</span>
              </div>
              <div class="night-tags">
                <span v-for="tag in nightTags(c)" :key="tag" class="tag">{{ tag }}</span>
              </div>
              <p v-if="c.why && c.why.length" class="night-why">{{ c.why[0] }}</p>
              <p v-if="c.risks && c.risks.length" class="night-risk">! {{ c.risks[0] }}</p>
            </div>
          </article>
        </div>

        <div v-else class="night-empty">
          <b>今天不凑三只</b>
          <p>{{ overnightBrief.reason }}</p>
          <p class="dim">
            只从三关、情绪、画像、节点与无炸板同时过关的核心中选；没有合格票就空仓，弱票不补位。
          </p>
        </div>

        <p class="night-note">
          <template v-if="overnightFinal">
            盘后定稿，可作为隔夜条件单草稿：竞价高开 +1%–4% 才执行，高开 &gt;6% 放弃，低开 &lt; -2% 放弃；
            单票 ≤10%，隔夜总仓 ≤30%。催化未核验仍不能挂单。
          </template>
          <template v-else>
            当前是「{{ overnightModeLabel }}」，只作预演，不能作为挂单依据；15:00 后重算才可能定稿。
          </template>
          今日一字 / 秒板不进三强；跳空、滑点与停牌都可能让计划失效。
        </p>
      </div>
    </section>

    <section v-if="recAudit" class="section night-ledger-section">
      <header class="section-head">
        <span class="section-title">隔夜台账 · 学习</span>
        <span class="section-count">
          近 {{ onWindow.days || 0 }} 个定稿日 · 次日日线核对
        </span>
      </header>

      <div class="panel night-ledger">
        <p v-if="onGatesLine" class="on-gate-line">{{ onGatesLine }}</p>

        <div class="rec-stats">
          <div class="rec-stat">
            <small>严格三强</small>
            <b>{{ onStrict.samples || 0 }}</b>
            <span>已核对 {{ onStrict.evaluated || 0 }}</span>
          </div>
          <div class="rec-stat">
            <small>触发买点</small>
            <b>{{ onStrict.triggered || 0 }}</b>
            <span>竞价 +1%–4%</span>
          </div>
          <div class="rec-stat">
            <small>触发胜率</small>
            <b :class="onStrict.winRate == null ? 'is-flat' : onStrict.winRate >= 50 ? 'is-up' : 'is-down'">
              {{ onStrict.winRate != null ? onStrict.winRate + '%' : '--' }}
            </b>
            <span>{{ onStrict.wins || 0 }} 胜 / {{ onStrict.triggered || 0 }}</span>
          </div>
          <div class="rec-stat">
            <small>触发均收益</small>
            <b :class="retTone(onStrict.avgRet)">{{ signed(onStrict.avgRet) }}</b>
            <span>开盘→收盘</span>
          </div>
          <div class="rec-stat">
            <small>次日晋级率</small>
            <b>{{ onStrict.promoRate != null ? onStrict.promoRate + '%' : '--' }}</b>
            <span>{{ onStrict.promoted || 0 }} / {{ onStrict.evaluated || 0 }} 只</span>
          </div>
        </div>

        <p class="rec-caveat">
          <template v-if="!onStrict.evaluated">
            严格三强还没有完成次日核对的样本；台账从 11-26 盘后开始积累，不补造历史。
          </template>
          <template v-else-if="onStrict.triggered < 5">
            严格三强已核对 {{ onStrict.evaluated }} 只，触发 {{ onStrict.triggered }} 只；样本少于
            5 只只看方向，不能当稳定胜率。
          </template>
          <template v-else>
            严格三强按次日竞价高开 1%–4% 触发、开盘→收盘统计；已核对
            {{ onStrict.evaluated }} 只，不按事后最优价假设成交。
          </template>
        </p>

        <div class="on-cohorts">
          <span v-if="onStandby.samples">
            候选未执行（情绪未确认）：核对 {{ onStandby.evaluated || 0 }} · 触发
            {{ onStandby.triggered || 0 }}<template v-if="onStandby.winRate != null">
              · 胜率 {{ onStandby.winRate }}%</template
            >
          </span>
          <span>
            准备池对照（不推荐）：核对 {{ onPrep.evaluated || 0 }} · 触发
            {{ onPrep.triggered || 0 }}<template v-if="onPrep.winRate != null">
              · 胜率 {{ onPrep.winRate }}%</template
            >
          </span>
          <span>
            观察池对照（不推荐）：核对 {{ onWatch.evaluated || 0 }} · 触发
            {{ onWatch.triggered || 0 }}<template v-if="onWatch.winRate != null">
              · 胜率 {{ onWatch.winRate }}%</template
            >
          </span>
        </div>

        <div v-if="onLearning" class="on-learning">
          <div class="on-learning-head">
            <b>分桶学习</b>
            <span>样本 &lt;{{ onLearning.minSamples }} 只只看方向，不自动调权重</span>
          </div>
          <p v-for="(note, i) in onLearning.notes" :key="i" class="on-note">{{ note }}</p>

          <div v-if="onGapBuckets.length" class="on-bucket-block">
            <div class="on-bucket-title">按竞价缺口</div>
            <div class="on-bucket-grid">
              <div v-for="b in onGapBuckets" :key="'gap-' + b.label" class="on-bucket">
                <span>{{ b.label }}</span>
                <b :class="b.enough ? retTone(b.avgRet) : ''">
                  {{ b.triggered ? signed(b.avgRet) : '--' }}
                </b>
                <small>
                  {{ b.samples }} 只 · 核对 {{ b.evaluated }} · 触发 {{ b.triggered
                  }}<template v-if="b.winRate != null"> · 胜 {{ b.winRate }}%</template>
                </small>
              </div>
            </div>
          </div>

          <div v-if="onScoreBuckets.length" class="on-bucket-block">
            <div class="on-bucket-title">按隔夜分</div>
            <div class="on-bucket-grid">
              <div v-for="b in onScoreBuckets" :key="'score-' + b.label" class="on-bucket">
                <span>{{ b.label }}</span>
                <b :class="b.enough ? retTone(b.avgRet) : ''">
                  {{ b.triggered ? signed(b.avgRet) : '--' }}
                </b>
                <small>
                  {{ b.samples }} 只 · 核对 {{ b.evaluated }} · 触发 {{ b.triggered
                  }}<template v-if="b.winRate != null"> · 胜 {{ b.winRate }}%</template>
                </small>
              </div>
            </div>
          </div>

          <div v-if="onLbcBuckets.length" class="on-bucket-block">
            <div class="on-bucket-title">按连板高度</div>
            <div class="on-bucket-grid">
              <div v-for="b in onLbcBuckets" :key="'lbc-' + b.label" class="on-bucket">
                <span>{{ b.label }}</span>
                <b :class="b.enough ? retTone(b.avgRet) : ''">
                  {{ b.triggered ? signed(b.avgRet) : '--' }}
                </b>
                <small>
                  {{ b.samples }} 只 · 核对 {{ b.evaluated }} · 触发 {{ b.triggered
                  }}<template v-if="b.winRate != null"> · 胜 {{ b.winRate }}%</template>
                </small>
              </div>
            </div>
          </div>

          <div v-if="onHeatBuckets.length" class="on-bucket-block">
            <div class="on-bucket-title">按板块热度</div>
            <div class="on-bucket-grid">
              <div v-for="b in onHeatBuckets" :key="'heat-' + b.label" class="on-bucket">
                <span>{{ b.label }}</span>
                <b :class="b.enough ? retTone(b.avgRet) : ''">
                  {{ b.triggered ? signed(b.avgRet) : '--' }}
                </b>
                <small>
                  {{ b.samples }} 只 · 核对 {{ b.evaluated }} · 触发 {{ b.triggered
                  }}<template v-if="b.winRate != null"> · 胜 {{ b.winRate }}%</template>
                </small>
              </div>
            </div>
          </div>
        </div>

        <div v-if="onDays.length" class="on-days">
          <div class="on-days-head">
            <b>最近定稿</b>
            <span>最近 {{ onDaysShown.length }} 日</span>
          </div>
          <div v-for="day in onDaysShown" :key="day.date" class="rec-day">
            <div class="rec-day-head">
              <b>{{ shortDate(day.date) }}</b>
              <span class="chip" :class="day.status === 'ready' ? 'chip--green' : 'chip--dim'">
                {{ day.statusLabel || '盘后定稿' }}
              </span>
              <span class="rec-day-action">
                严格 {{ day.stats.strict.samples }} · 待命
                {{ day.stats.standby.samples }} · 准备 {{ day.stats.prep.samples }} · 观察
                {{ day.stats.watch.samples }}
              </span>
              <span class="rec-day-stat">
                触发 {{ day.stats.strict.triggered }}/{{ day.stats.strict.evaluated }}
              </span>
            </div>
            <div
              v-for="row in visibleOnRows(day)"
              :key="day.date + row.cohort + row.code"
              class="rec-row"
            >
              <span class="chip" :class="row.cohort === 'strict' ? 'chip--gold' : 'chip--dim'">
                {{ row.cohortLabel }}
              </span>
              <b>{{ row.name }}</b>
              <span class="rec-code">{{ row.code }}</span>
              <span>{{ row.lbc }} 板</span>
              <span v-if="row.score != null">隔夜分 {{ row.score }}</span>
              <span :class="retTone(row.gap)">缺口 {{ signed(row.gap) }}</span>
              <span :class="retTone(row.dayRet)">开→收 {{ signed(row.dayRet) }}</span>
              <span class="rec-trigger" :class="{ 'is-hit': row.trigger === 'trigger' }">
                {{ onTriggerLabel(row) }}
              </span>
              <span v-if="row.promoted" class="chip chip--red">晋级</span>
              <span v-else-if="row.touchedLimit" class="chip chip--warn">触板未封</span>
            </div>
            <p v-if="!day.stats.strict.samples" class="on-obs-line">
              严格 0 只；<template v-if="day.standbyNames.length"
              >候选未执行 {{ day.standbyNames.join('、') }}；</template>准备池
              {{ day.prepNames.join('、') || '无' }}<template v-if="day.watchNames.length"
              >；观察池 {{ day.watchNames.join('、') }}</template>（对照，不挂单）
            </p>
            <p v-if="!day.rows.length" class="on-obs-line">
              没有候选记录：{{ day.reason || '数据不足' }}
            </p>
          </div>
          <button
            class="rec-toggle"
            type="button"
            @click="onShowObservations = !onShowObservations"
          >
            {{ onShowObservations ? '只看严格三强' : '展开准备池 / 观察池对照' }}
          </button>
        </div>
        <div v-else class="rec-empty">
          还没有隔夜台账。今天盘后定稿后开始记录严格三强与准备池对照，次日收盘后用真实日线核对。
        </div>

        <div v-if="onShareText" class="on-share">
          <div class="on-share-head">
            <b>分享口径</b>
            <button class="on-share-btn" type="button" @click="copyOvernightShare">
              {{ shareState || '复制分享文案' }}
            </button>
          </div>
          <pre>{{ onShareText }}</pre>
        </div>

        <p class="rec-note">
          隔夜台账只记录 15:00 后定稿的计划；只有三关 + 情绪修复/主升的候选才算严格三强，是唯一按“推荐”统计的样本。情绪未确认的候选、准备池与观察池只作对照，不挂单、不计入推荐胜率。
          执行口径固定为竞价高开 1%–4% 触发，&gt;6% 放弃，&lt;-2% 放弃；一字 / 秒板不进严格三强。
          样本少于 5 只只展示方向，不自动调权重；不补造历史。
        </p>
      </div>
    </section>

    <section v-if="tailVisible" class="section tail-review-section">
      <header class="section-head">
        <span class="section-title">尾盘超预期</span>
        <span class="section-count">14:30–15:00 · 最多 3 只 · 明日观察</span>
      </header>

      <div class="panel tail-review-panel">
        <div class="night-head">
          <span class="chip" :class="tailTone">{{ tailBrief.statusLabel }}</span>
          <p>{{ tailBrief.reason }}</p>
        </div>

        <div v-if="tailTop.length" class="night-list">
          <article v-for="(t, i) in tailTop" :key="t.code" class="night-row">
            <span class="night-rank">{{ t.rank || i + 1 }}</span>
            <div class="night-body">
              <div class="night-name">
                <b>{{ t.name }}</b>
                <span class="mono">{{ t.code }}</span>
                <span class="chip chip--gold">未涨停</span>
                <span class="night-sector">{{ t.sector }}</span>
              </div>
              <div class="night-meta">
                <span>预期分 <b>{{ t.score }}</b></span>
                <span :class="pctTone(t.pct)">{{ fmtPct(t.pct) }}</span>
                <span v-if="t.openPct != null">{{ t.openLabel }} {{ fmtPct(t.openPct) }}</span>
                <span>距涨停 {{ fmtPct(t.gapToLimit, { sign: false }) }}</span>
                <span>收盘位置 {{ t.closeStrength == null ? '--' : t.closeStrength + '%' }}</span>
                <span v-if="t.sectorSealCount">板块核心 {{ t.sectorSealCount }} 只</span>
                <span v-if="t.volRatio != null">量比 {{ fmtNum(t.volRatio, 2) }}</span>
                <span v-if="t.recommendTime">推荐 {{ t.recommendTime }}</span>
              </div>
              <div class="night-tags">
                <span v-for="tag in nightTags(t)" :key="tag" class="tag">{{ tag }}</span>
              </div>
              <p v-if="t.reasons && t.reasons.length" class="night-why">{{ t.reasons[0] }}</p>
              <p v-if="t.risks && t.risks.length" class="night-risk">! {{ t.risks[0] }}</p>
              <p v-if="t.plan && t.plan.length" class="tail-review-plan">
                观察：{{ t.plan[0] }}
              </p>
            </div>
          </article>
        </div>

        <div v-else class="night-empty">
          <b>
            {{ tailBrief.status === 'none' ? '当天没有留痕' : tailBrief.status === 'empty' ? '今天没有合格票' : '今天不凑数' }}
          </b>
          <p class="dim">
            {{
              tailBrief.mode === 'live'
                ? '实时尾盘榜在「竞价 / 盘中」页；这里只展示已落盘的留痕。'
                : '只筛今天没涨停、仍在中低位、收盘走强且板块有涨停核心的票；没有就空着，不把尾盘超预期混进隔夜三强。'
            }}
          </p>
        </div>

        <p class="night-note tail-review-note">
          尾盘超预期与隔夜三强分开：它不要求今日封板，也不进入条件单草稿；只从中低位活跃股里找今天没涨停、收盘走强、板块有涨停核心的票。明日竞价高开 +1%–4%
          且同板块至少 1 只涨停核心同步才观察；高开 &gt;5% 或低开 &lt;-2% 直接放弃。
        </p>
      </div>
    </section>

    <section v-if="plan" class="section plan-section">
      <header class="section-head">
        <span class="section-title">短线作战室</span>
        <span class="section-count">{{ live ? '盘中推演' : '收盘推演' }} · 只做前排</span>
      </header>

      <div class="plan-card" :class="`plan-card--${planAction.tone}`">
        <div class="plan-top">
          <span class="plan-stance">{{ planAction.label }}</span>
          <span class="plan-position">{{ planAction.position }}</span>
        </div>
        <p class="plan-summary">{{ planAction.summary }}</p>
        <ul v-if="planAction.blockers && planAction.blockers.length" class="plan-blockers">
          <li v-for="b in planAction.blockers" :key="b">{{ b }}</li>
        </ul>
        <ul class="plan-review">
          <li v-for="line in planReview" :key="line">{{ line }}</li>
        </ul>
        <div class="plan-scenarios">
          <div
            v-for="sc in planAction.scenarios"
            :key="sc.key"
            class="scenario"
            :class="{ 'is-active': sc.active }"
          >
            <div class="scenario-head">
              {{ sc.title }}<em v-if="sc.active">当前适用</em>
            </div>
            <p>{{ sc.text }}</p>
          </div>
        </div>
      </div>

      <div v-if="nearGateSectors.length" class="near-gate">
        <div class="near-gate-head">
          <span>准三关 · 只观察</span>
          <span class="dim">2/3 关 · 不推荐 · 不计胜率</span>
        </div>
        <article v-for="s in nearGateSectors" :key="s.name" class="near-gate-row">
          <div class="near-gate-top">
            <b>{{ s.name }}</b>
            <span class="dim">{{ s.todayCount }} 家涨停 · 今日 #{{ s.rankToday }}</span>
            <span class="chip chip--warn">{{ s.gatesPassed }}/3 关</span>
          </div>
          <div class="near-gate-meta">
            <span>高 {{ s.ladder.high }} · 二 {{ s.ladder.mid }} · 首 {{ s.ladder.first }}</span>
            <span v-if="s.leader">龙头 {{ s.leader.name }} {{ s.leader.lbc }} 板</span>
            <span>资金 {{ sectorMoneyPass(s).pass }}/{{ sectorMoneyPass(s).total }}</span>
          </div>
          <p class="near-gate-gap">差：{{ sectorFailReason(s) }}</p>
        </article>
        <p class="near-gate-note">
          严格三关不降。这里只把“差一关”的强势板块摊开，方便盯明日补缺；不计入推荐、不计胜率、不解除空仓。
        </p>
      </div>

      <div v-if="plan.leader" class="leader-card">
        <div class="leader-head">
          <div class="leader-title">
            <small>龙头评分第一 · {{ plan.leader.tag }}</small>
            <div class="leader-name-row">
              <b>{{ plan.leader.name }}</b>
              <span>{{ plan.leader.lbc }} 板</span>
              <span>{{ plan.leader.sector }}</span>
            </div>
          </div>
          <div class="leader-prob">
            <b>{{ plan.leader.promoProb }}<small>%</small></b>
            <span>晋级估算</span>
          </div>
        </div>
        <div class="leader-meta">
          <span>节点 {{ plan.leader.nodeLabel }} {{ plan.leader.nodeScore }}</span>
          <span>龙头分 {{ plan.leader.leaderScore }}</span>
          <span>封单 {{ plan.leader.sealRatio }}%</span>
          <span>换手 {{ plan.leader.turnover }}%</span>
          <span>{{ plan.leader.floatCapYi }} 亿</span>
          <span v-if="plan.leader.calibrationUsed" class="cal-chip">
            规则 {{ plan.leader.ruleProb }} · 模型 {{ plan.leader.modelProb }}
          </span>
          <span v-if="plan.leader.tradableBoard === false" class="chip chip--warn">今日一字 / 秒板</span>
          <span
            v-if="plan.leader.nuclearLevel && plan.leader.nuclearLevel !== 'low'"
            class="nuke-chip"
            :class="`is-${plan.leader.nuclearLevel}`"
          >防核按钮 {{ plan.leader.nuclearScore }}</span>
          <span
            v-else-if="plan.leader.nuclearNextLevel && plan.leader.nuclearNextLevel !== 'low'"
            class="nuke-chip"
            :class="`is-${plan.leader.nuclearNextLevel}`"
          >明日防核按钮 {{ plan.leader.nuclearNextScore }}</span>
        </div>
        <p class="leader-thesis">{{ plan.leader.thesis }}</p>
        <ul class="leader-why">
          <li v-for="line in plan.leader.why.slice(0, 3)" :key="line">{{ line }}</li>
        </ul>
        <p class="leader-note">{{ plan.leader.note }}</p>
        <div v-if="plan.leader.risks.length" class="leader-risk">
          <span>风险</span>{{ plan.leader.risks.slice(0, 2).join('；') }}
        </div>
      </div>

      <div class="promo-panel">
        <div class="promo-head">
          <span>明日连板晋级榜</span>
          <span>{{ planBlocked ? '观察窗口 · 不构成买入' : '只列前排 · 不含杂毛' }}</span>
        </div>
        <div v-if="promoRank.length" class="promo-list">
          <div
            v-for="item in promoRank"
            :key="item.code"
            class="promo-row"
            :class="{ 'is-top': item.rank === 1 }"
          >
            <div class="promo-rank">{{ item.rank }}</div>
            <div class="promo-main">
              <div class="promo-title">
                <b>{{ item.name }}</b>
                <span class="promo-board">{{ item.lbc }} 板</span>
                <span class="promo-sector">{{ item.sector }}</span>
                <span class="promo-node">{{ item.nodeLabel }} {{ item.nodeScore }}</span>
                <span v-if="!item.tradableBoard" class="chip chip--warn">一字 / 秒板</span>
                <span
                  v-if="item.nuclearLevel && item.nuclearLevel !== 'low'"
                  class="nuke-chip"
                  :class="`is-${item.nuclearLevel}`"
                >核按钮风险 {{ item.nuclearScore }}</span>
                <span
                  v-else-if="item.nuclearNextLevel && item.nuclearNextLevel !== 'low'"
                  class="nuke-chip"
                  :class="`is-${item.nuclearNextLevel}`"
                >明日防核按钮 {{ item.nuclearNextScore }}</span>
              </div>
              <p class="promo-thesis">{{ item.thesis }}</p>
              <p class="promo-why">{{ item.why[0] }}</p>
              <div class="promo-meta">
                <span>首封 {{ item.firstSealLabel }}</span>
                <span>封单 {{ item.sealRatio }}%</span>
                <span>换手 {{ item.turnover }}%</span>
                <span v-if="item.blowCount">炸 {{ item.blowCount }}</span>
                <span>{{ item.floatCapYi }} 亿</span>
              </div>
              <p v-if="item.risks.length" class="promo-risk">
                风险：{{ item.risks.slice(0, 2).join('；') }}
              </p>
            </div>
            <div class="promo-prob">
              <b>{{ item.promoProb }}<small>%</small></b>
              <span>{{ item.probLow }}–{{ item.probHigh }}%</span>
              <em v-if="item.calibrationUsed">规则 {{ item.ruleProb }}<br />模型 {{ item.modelProb }}</em>
            </div>
          </div>
        </div>
        <div v-else class="promo-empty">
          今日没有通过前排过滤的连板核心，明天以观察为主，不为了交易而交易。
        </div>
        <p class="promo-foot">
          概率为规则估算与历史校准模型的保守加权；校准只用当日之前样本做走样本外检验，
          达标才启用。它只用于排序与风险过滤，不是胜率；今日一字 / 秒板即使概率高，
          也不等于明天有舒服买点，执行仍看竞价换手。
          <template v-if="planBlocked">今日计划为不出手，本榜只用于跟踪次日晋级，不是买入清单。</template>
        </p>
      </div>

      <div v-if="oneWordWatch.length" class="oneword-panel">
        <div class="promo-head">
          <span>一字 / 秒板 · 只看不接</span>
          <span>{{ oneWordWatch.length }} 只 · 普通资金难有买点</span>
        </div>
        <div v-for="item in oneWordWatch" :key="item.code" class="oneword-row">
          <div class="oneword-main">
            <div class="promo-title">
              <b>{{ item.name }}</b>
              <span class="promo-board">{{ item.lbc }} 板</span>
              <span class="promo-sector">{{ item.sector }}</span>
              <span class="promo-node">{{ item.nodeLabel }} {{ item.nodeScore }}</span>
              <span class="chip chip--warn">一字 / 秒板</span>
              <span
                v-if="item.nuclearNextLevel && item.nuclearNextLevel !== 'low'"
                class="nuke-chip"
                :class="`is-${item.nuclearNextLevel}`"
              >明日防核按钮 {{ item.nuclearNextScore }}</span>
            </div>
            <p class="oneword-meta">
              首封 {{ item.firstSealLabel }} · 封单 {{ item.sealRatio }}% · 换手 {{ item.turnover }}% ·
              {{ item.floatCapYi }} 亿
            </p>
            <p v-if="item.risks.length" class="promo-risk">
              风险：{{ item.risks.slice(0, 2).join('；') }}
            </p>
          </div>
          <div class="height-ref">
            参考晋级
            <b>{{ item.promoProb }}%</b>
          </div>
        </div>
        <p class="promo-foot">
          这些票今天买不到，晋级概率再高也不能当作可成交收益；明天只看竞价换手与封单是否延续，
          不在竞价直接追一字。
        </p>
      </div>

      <div v-if="calibration" class="cal-panel">
        <button class="cal-toggle" @click="showCalibration = !showCalibration">
          <span>
            晋级概率校准 ·
            {{ calibration.enabled ? `模型权重 ${Math.round(calibration.blendWeight * 100)}%` : '未启用' }}
          </span>
          <span>
            {{ calibration.days }} 天 / {{ calibration.samples }} 样本 ·
            {{ showCalibration ? '收起 ▴' : '看依据 ▾' }}
          </span>
        </button>
        <div v-if="showCalibration" class="cal-body">
          <div class="cal-metrics">
            <div>
              <small>样本外基准</small>
              <b>{{ calibration.testBaseRate == null ? calibration.baseRate : calibration.testBaseRate }}%</b>
            </div>
            <div>
              <small>Top10% 晋级</small>
              <b class="is-up">{{ calibration.topDecile ? calibration.topDecile.rate + '%' : '--' }}</b>
            </div>
            <div>
              <small>AUC</small>
              <b>
                {{ calibration.auc == null ? '--' : calibration.auc }}
                <em v-if="calibration.aucCI">[{{ calibration.aucCI.low }}–{{ calibration.aucCI.high }}]</em>
              </b>
            </div>
            <div>
              <small>Brier</small>
              <b>{{ calibration.brier }} <em>vs {{ calibration.baselineBrier }}</em></b>
            </div>
          </div>
          <p class="cal-line">
            样本外测试 {{ calibration.testDays }} 天 / {{ calibration.testSamples }} 只；全样本基准
            {{ calibration.baseRate }}%（{{ calibration.samples }} 只）。AUC 区间为分层 bootstrap 95%。
          </p>
          <p v-if="calibration.continuation" class="cal-line">
            2 板+ 子样本 {{ calibration.continuation.samples }} 只：基准
            {{ calibration.continuation.baseRate }}%，Top20% 晋级
            {{ calibration.continuation.topQuintile ? calibration.continuation.topQuintile.rate + '%' : '--' }}，
            AUC {{ calibration.continuation.auc == null ? '--' : calibration.continuation.auc }}
            <template v-if="calibration.continuation.aucCI">
              [{{ calibration.continuation.aucCI.low }}–{{ calibration.continuation.aucCI.high }}]
            </template>。
          </p>
          <p v-if="calibration.tradable" class="cal-line">
            可成交子样本 {{ calibration.tradable.samples }} 只（剔除一字 / 秒板）：基准
            {{ calibration.tradable.baseRate }}%，Top10% 晋级
            {{ calibration.tradable.topDecile ? calibration.tradable.topDecile.rate + '%' : '--' }}，
            AUC {{ calibration.tradable.auc == null ? '--' : calibration.tradable.auc }}
            <template v-if="calibration.tradable.aucCI">
              [{{ calibration.tradable.aucCI.low }}–{{ calibration.tradable.aucCI.high }}]
            </template>。
          </p>
          <div v-if="calBuckets.length" class="cal-buckets">
            <div class="cal-bucket-head"><span>同型样本</span><span>样本</span><span>晋级率</span></div>
            <div v-for="b in calBuckets" :key="b.key" class="cal-bucket-row">
              <span>{{ b.key }}</span><span>{{ b.n }}</span><b>{{ b.rate }}%</b>
            </div>
          </div>
          <ul class="cal-notes">
            <li v-for="n in calibration.notes" :key="n">{{ n }}</li>
          </ul>
        </div>
      </div>

      <div v-if="heightWatch.length" class="height-panel">
        <div class="promo-head">
          <span>高度风向标 · 只看不接</span>
          <span>最高 {{ plan.maxBoard }} 板</span>
        </div>
        <div
          v-for="item in heightWatch"
          :key="item.code"
          class="height-row"
          :class="`is-${item.riskLevel}`"
        >
          <div class="height-main">
            <div class="promo-title">
              <b>{{ item.name }}</b>
              <span class="promo-board">{{ item.lbc }} 板</span>
              <span class="promo-sector">{{ item.sector }}</span>
              <span
                v-if="item.nuclearLevel && item.nuclearLevel !== 'low'"
                class="nuke-chip"
                :class="`is-${item.nuclearLevel}`"
              >核按钮风险 {{ item.nuclearScore }}</span>
            </div>
            <p>{{ item.riskShort }} · {{ item.nodeLabel }} {{ item.nodeScore }}</p>
          </div>
          <div class="height-ref">
            参考晋级
            <b>{{ item.promoProb }}%</b>
          </div>
        </div>
        <p class="promo-foot">
          最高板只作为情绪风向标；炸板多 / 尾盘板 / 板块 0 关不进入晋级榜。
        </p>
      </div>

      <div v-if="nuclearWatch.length" class="nuclear-panel">
        <div class="promo-head">
          <span>三板组核按钮 · 只看不接</span>
          <span>小盘缩量 / 无主线 / 封单异常</span>
        </div>
        <div
          v-for="item in nuclearWatch"
          :key="item.code"
          class="nuclear-row"
          :class="`is-${item.nuclearLevel}`"
        >
          <div class="nuclear-main">
            <div class="promo-title">
              <b>{{ item.name }}</b>
              <span class="promo-board">{{ item.lbc }} 板</span>
              <span class="promo-sector">{{ item.sector || '无板块' }}</span>
              <span class="nuke-chip" :class="`is-${item.nuclearLevel}`">
                核按钮 {{ item.nuclearScore }}
              </span>
            </div>
            <p>{{ item.reasons.join('；') }}</p>
          </div>
          <div class="nuclear-next">
            冲 {{ item.board }} 板
            <em>{{ item.nuclearLevel === 'high' ? '高危' : '警惕' }}</em>
          </div>
        </div>
        <p class="promo-foot">
          三板组 = 小盘冷门票用一字 / T 字缩量加速到 3–4 板，封单极大、没有板块主线，
          随后在竞价撤单往下砸（核按钮），常见天地板 / A 杀。高分票不进晋级榜与预警，只在这里提示。
        </p>
      </div>

      <div class="reject-panel">
        <button class="reject-toggle" @click="showRejected = !showRejected">
          <span>后排剔除 {{ rejected.total }} 家</span>
          <span>{{ showRejected ? '收起 ▴' : '看理由 ▾' }}</span>
        </button>
        <div v-if="showRejected" class="reject-list">
          <div v-for="item in rejected.samples" :key="item.code" class="reject-row">
            <span class="reject-cat">{{ item.category }}</span>
            <div class="reject-main">
              <div class="promo-title">
                <b>{{ item.name }}</b>
                <span class="promo-board">{{ item.lbc }} 板</span>
                <span class="promo-sector">{{ item.sector || '无板块' }}</span>
              </div>
              <p>{{ item.reasons.join('；') }}</p>
            </div>
          </div>
          <p v-if="rejected.total > rejected.samples.length" class="reject-more">
            其余 {{ rejected.total - rejected.samples.length }} 家同属后排 / 脏板 / 尾盘板，不逐一列出。
          </p>
        </div>
      </div>

      <div class="plan-triggers">
        <h4>明天怎么执行</h4>
        <ol>
          <li v-for="t in planAction.triggers" :key="t">{{ t }}</li>
        </ol>
        <div class="plan-donot">
          <span>不做</span>
          <ul>
            <li v-for="d in planAction.doNot" :key="d">{{ d }}</li>
          </ul>
        </div>
      </div>
      <p class="section-note">{{ plan.notes[0] }}</p>
    </section>

    <section v-if="hotshot" class="section hotshot-section">
      <header class="section-head">
        <span class="section-title">打板客审美</span>
        <span class="section-count">北京炒家 · 92科比 · 全能的野人</span>
      </header>

      <div class="panel panel-pad hotshot-intro">
        <p>
          把三家公开打法拆成可检查条件：首板要板块效应，二板看缩量与分歧，只做板块龙一；
          没有合格载体就空仓。明日待选只从板块三关全过、且是板块龙一的 1–2 板里取；
          今日一字 / 秒板买不到，不进明日待选，只观察竞价换手；龙一是 3 板或只过 1–2 关的降为观察。
          审美分只用于排序，不是胜率；催化未核验前只算待选。
        </p>
      </div>

      <div class="hotshot-panel">
        <div class="promo-head">
          <span>今日审美命中</span>
          <span>{{ hotshotToday.length }} 只 · 收盘定格 · 只复盘 · 非买入清单</span>
        </div>
        <div v-if="hotshotToday.length" class="hotshot-hits">
          <div v-for="item in hotshotToday" :key="item.code" class="hotshot-hit">
            <div class="hotshot-hit-rank">{{ item.rank }}</div>
            <div class="hotshot-hit-main">
              <div class="promo-title">
                <b>{{ item.name }}</b>
                <span class="promo-board">{{ item.lbc }} 板</span>
                <span class="promo-sector">{{ item.sector }}</span>
                <span class="hotshot-score">审美 {{ item.score }}</span>
                <span v-if="item.oneWord" class="chip chip--warn">一字 / 秒板 · 只复盘</span>
              </div>
              <div class="hotshot-tags">
                <span v-for="tag in item.tags" :key="tag" class="chip chip--dim">{{ tag }}</span>
              </div>
              <p v-for="line in item.why.slice(0, 2)" :key="line" class="hotshot-line">
                {{ line }}
              </p>
              <p v-if="item.risks.length" class="hotshot-risk">
                风险：{{ item.risks.slice(0, 2).join('；') }}
              </p>
            </div>
          </div>
        </div>
        <div v-else class="promo-empty">今日没有同时满足封板、板块与身位审美的票。</div>
      </div>

      <div class="hotshot-panel">
        <div class="promo-head">
          <span>明日打板待选</span>
          <span>{{ planBlocked ? `计划不出手 · 观察 ${hotshotReady.length + hotshotWatch.length}` : `待选 ${hotshotReady.length} · 只观察 ${hotshotWatch.length}` }}</span>
        </div>
        <div v-if="hotshotReady.length" class="hotshot-ready-list">
          <div v-for="item in hotshotReady" :key="item.code" class="hotshot-ready">
            <div class="hotshot-ready-head">
              <div class="promo-title">
                <b>{{ item.name }}</b>
                <span class="promo-board">{{ item.lbc }} 板</span>
                <span class="promo-sector">{{ item.sector }}</span>
              </div>
              <span class="hotshot-bucket">{{ item.bucketLabel }}</span>
              <span
                v-if="item.nuclearLevel && item.nuclearLevel !== 'low'"
                class="nuke-chip"
                :class="`is-${item.nuclearLevel}`"
              >防核按钮 {{ item.nuclearScore }}</span>
              <span class="hotshot-score">审美 {{ item.score }}</span>
            </div>
            <div class="hotshot-tags">
              <span v-for="tag in item.tags" :key="tag" class="chip chip--dim">{{ tag }}</span>
            </div>
            <div class="hotshot-meta">
              <span>首封 {{ item.sealLabel }}</span>
              <span>封单 {{ item.sealRatio }}%</span>
              <span>换手 {{ item.turnover }}%</span>
              <span v-if="item.blowCount">炸 {{ item.blowCount }}</span>
              <span>{{ item.floatCapYi }} 亿</span>
              <span>板块 {{ item.sectorHeat }} · {{ item.sectorCount }} 家</span>
              <span :class="{ 'is-dim': !item.leader }">
                {{ item.leader ? '板块龙一' : '板块非龙一' }}
              </span>
            </div>
            <p class="hotshot-line">{{ item.why[1] }}</p>
            <div v-if="!planBlocked" class="hotshot-entry">
              <span>执行条件</span>
              <ul>
                <li v-for="line in item.entry" :key="line">{{ line }}</li>
              </ul>
            </div>
            <p v-if="!planBlocked" class="hotshot-giveup">放弃：{{ item.giveUp }}</p>
            <p v-if="!planBlocked" class="hotshot-position">仓位：{{ item.position }}</p>
            <p v-else class="hotshot-giveup">今日计划不出手：只记录条件，不给仓位与买点。</p>
            <p v-if="item.risks.length" class="hotshot-risk">
              风险：{{ item.risks.slice(0, 3).join('；') }}
            </p>
          </div>
        </div>
        <div v-else class="promo-empty">{{ hotshot.tomorrow.note }}</div>

        <div v-if="hotshotWatch.length" class="hotshot-watch">
          <div class="hotshot-subhead">
            <span>只观察 · 条件未齐</span>
            <span>{{ hotshotWatch.length }} 只</span>
          </div>
          <div v-for="item in hotshotWatch" :key="item.code" class="hotshot-watch-row">
            <div class="hotshot-watch-title">
              <b>{{ item.name }}</b>
              <span>{{ item.lbc }} 板</span>
              <span>{{ item.sector }}</span>
              <em>审美 {{ item.score }}</em>
            </div>
            <p>{{ item.reason }}</p>
          </div>
        </div>

        <p class="promo-foot">
          <template v-if="hotshotReady.length">{{ hotshot.tomorrow.note }} </template>
          审美分 = 封板 / 板块 / 节点 / 身位 / 市值 / 换手 / 弱转强 / 板块地位；
          明日待选要求板块三关全过 + 板块龙一 + 审美 ≥65；待选不等于可买：催化未核验前只观察，审美分也不是胜率。
        </p>
      </div>
    </section>

    <section class="section">
      <header class="section-head">
        <span class="section-title">昨日涨停 · 今日表现</span>
        <span class="section-count">{{ review.prevPremium ? `${review.prevPremium.quoted}/${review.prevPremium.total} 已报价` : '' }}</span>
      </header>
      <div v-if="tiers.length && !premium.skip" class="tier-grid">
        <div v-for="tier in tiers" :key="tier.key" class="tier-card">
          <small>{{ tier.label }}</small>
          <b :class="tierTone(tier.avg)">{{ tier.avg != null ? fmtPct(tier.avg) : '--' }}</b>
          <span>胜率 {{ tier.winRate != null ? tier.winRate + '%' : '--' }} · {{ tier.count }} 只</span>
        </div>
      </div>
      <div v-else class="empty-mini panel panel-pad">
        昨日池报价尚未就绪（多为盘前或接口波动）。开盘后此表会自动补齐。
      </div>
      <p class="section-note">
        昨日涨停今天平均溢价，是赚钱效应最直接的体温计。首板溢价代表低吸容错，高位溢价代表接力意愿。
      </p>
    </section>

    <section v-if="promotion.first" class="section">
      <header class="section-head">
        <span class="section-title">晋级率</span>
        <span class="section-count">昨日 → 今日</span>
      </header>
      <div class="promote-grid">
        <div class="promote-card">
          <div class="label">昨日首板 → 今日二板</div>
          <div class="rate" :class="promotion.first.rate >= 25 ? 'is-up' : 'is-flat'">
            {{ promotion.first.rate != null ? promotion.first.rate + '%' : '--' }}
          </div>
          <div class="sub">{{ promotion.first.promoted }} / {{ promotion.first.total }} 成功晋级</div>
        </div>
        <div class="promote-card">
          <div class="label">昨日连板 → 今日继续</div>
          <div class="rate" :class="promotion.continuation.rate >= 50 ? 'is-up' : 'is-flat'">
            {{ promotion.continuation.rate != null ? promotion.continuation.rate + '%' : '--' }}
          </div>
          <div class="sub">{{ promotion.continuation.promoted }} / {{ promotion.continuation.total }} 继续封板</div>
        </div>
      </div>
      <p class="section-note">
        首板晋级率低于 20% 说明接力亏钱，连板晋级率骤降说明高位开始分歧。两者同时走弱，直接进入防守。
      </p>
    </section>

    <section class="section">
      <header class="section-head">
        <span class="section-title">连板天梯</span>
        <span class="section-count">{{ ladder.length }} 个高度层</span>
      </header>

      <div class="ladder-livebar">
        <span class="ladder-live" :class="live ? 'is-live' : 'is-snapshot'">
          <i></i>{{ snapshotLabel }}
        </span>
        <template v-if="flowReady">
          <span class="ladder-stat"><small>晋级</small><b class="is-up">{{ ladderFlow.promoted }}</b></span>
          <span class="ladder-stat"><small>淘汰</small><b class="is-down">{{ ladderFlow.eliminated }}</b></span>
          <span v-if="ladderFlow.blown" class="ladder-stat"><small>炸板</small><b>{{ ladderFlow.blown }}</b></span>
        </template>
        <span v-else class="ladder-hint">昨日池未就绪</span>
      </div>

      <div v-if="ladder.length" class="panel ladder-board">
        <div v-for="row in ladder" :key="row.lbc" class="ladder-row">
          <div class="ladder-level">
            <b>{{ row.lbc === 1 ? '首' : row.lbc }}{{ row.lbc !== 1 && row.capped ? '+' : '' }}</b>
            <small>{{ row.lbc === 1 ? '板' : '连板' }} · {{ row.count }}</small>
          </div>
          <div class="ladder-stocks">
            <span v-for="stock in row.stocks" :key="stock.code" class="ladder-stock">
              {{ stock.name }}
              <em>{{ stock.firstSealLabel }}</em>
            </span>
          </div>
        </div>
      </div>
      <div v-else class="empty-mini panel panel-pad">今日暂无涨停天梯数据。</div>
      <p class="section-note">
        高度层随涨停池约 10 秒刷新；7 层以上合并展示并标 +。晋级 / 淘汰按昨日梯队整体统计，见下方流转表。
      </p>
    </section>

    <section v-if="flowReady" class="section">
      <header class="section-head">
        <span class="section-title">梯队流转 · 昨日 → 今日</span>
        <span class="section-count">{{ ladderFlow.total }} 家 · 晋级 {{ ladderFlow.promoted }}</span>
      </header>

      <div v-if="flowRows.length" class="panel flow-board">
        <div v-for="row in flowRows" :key="row.lbc" class="flow-row">
          <div class="flow-level">
            <b>{{ row.label }}</b>
            <small>昨 {{ row.total }} 家</small>
          </div>
          <div class="flow-mid">
            <div class="flow-track">
              <i
                class="flow-fill is-promoted"
                :style="{ width: `${row.total ? (row.promoted / row.total) * 100 : 0}%` }"
              ></i>
              <i
                class="flow-fill is-eliminated"
                :style="{ width: `${row.total ? (row.eliminated / row.total) * 100 : 0}%` }"
              ></i>
            </div>
            <div class="flow-copy">
              <span class="is-up">晋级 {{ row.promoted }}</span>
              <span class="is-down">淘汰 {{ row.eliminated }}</span>
              <span v-if="row.retained" class="dim">数据存疑 {{ row.retained }}</span>
            </div>
          </div>
          <div class="flow-rate" :class="{ 'is-gold': row.rate >= 30 }">
            {{ row.rate }}<small>%</small>
          </div>
        </div>
      </div>

      <div class="panel elim-board">
        <div class="elim-head">
          <span>连板淘汰 · 今日未回封</span>
          <span class="dim">{{ eliminated.length }} 家</span>
        </div>
        <div v-if="eliminated.length" class="elim-list">
          <div v-for="item in eliminatedShown" :key="item.code" class="elim-row">
            <span class="elim-level">{{ item.lbc }}板</span>
            <div class="elim-main">
              <b>{{ item.name }}</b>
              <small>{{ item.sector }}</small>
            </div>
            <span class="chip" :class="elimChip(item)" style="height: 18px">{{ item.statusLabel }}</span>
            <span class="elim-pct mono" :class="tierTone(item.pct)">{{ fmtPct(item.pct) }}</span>
          </div>
          <button
            v-if="eliminated.length > 6"
            class="elim-toggle"
            @click="showAllElim = !showAllElim"
          >
            {{ showAllElim ? '收起' : `展开其余 ${eliminated.length - 6} 家` }}
          </button>
        </div>
        <div v-else class="elim-empty">
          昨日 2 板及以上全部仍封在涨停{{ firstTierEliminated ? `；首板淘汰 ${firstTierEliminated} 家，见上方流转表` : '' }}。
        </div>
      </div>

      <p class="section-note">
        晋级 = 昨日涨停、今日继续封板且高度提升；淘汰 = 今日未出现在涨停池，含首板。下方名单只列昨日 ≥2 连板的淘汰股。
        {{ live ? '盘中回封会自动移回天梯，炸板 / 跌停 / 未封只是当前快照。' : '收盘后为当日定稿。' }}
      </p>
    </section>

    <section class="section">
      <header class="section-head">
        <span class="section-title">涨停板块分布</span>
        <span class="section-count">按家数排序</span>
      </header>
      <div class="panel dist-list">
        <div v-for="item in distribution" :key="item.name" class="dist-row">
          <div class="dist-name">
            {{ item.name }}
            <em v-if="item.todayCount > 1">×{{ item.todayCount }}</em>
          </div>
          <div class="dist-track">
            <div
              class="dist-fill"
              :class="{ 'is-gold': item.dataReady }"
              :style="{ width: `${Math.max(6, (item.todayCount / maxDist) * 100)}%` }"
            ></div>
          </div>
          <div class="dist-num" :class="item.moneyToday > 0 ? 'is-up' : item.moneyToday < 0 ? 'is-down' : ''">
            {{ fmtMoney(item.moneyToday) }}
          </div>
        </div>
        <div v-if="!distribution.length" class="empty-mini">暂无板块分布数据。</div>
      </div>
      <p class="section-note">
        金色条代表三关通过；右侧为板块当日主力净流入。家数多不等于主线，必须结合连续性与梯队。
      </p>
    </section>

    <section class="two-col">
      <div class="panel list-panel">
        <h4>炸板压力</h4>
        <div v-if="!blown.length" class="empty-mini">今日没有重点炸板股。</div>
        <div v-for="item in blown" :key="item.code" class="list-row list-row--stack">
          <div class="blown-head">
            <span class="nm">{{ item.name }}</span>
            <span class="pct" :class="item.pct >= 0 ? 'is-up' : 'is-down'">{{ fmtPct(item.pct) }}</span>
          </div>
          <div class="blown-meta">
            <span>{{ item.sector }}</span>
            <span>炸 {{ item.blowCount }} 次</span>
            <span v-if="item.turnover != null">换手 {{ item.turnover }}%</span>
            <span v-if="item.mainInflow != null" :class="item.mainInflow < 0 ? 'is-down' : 'is-up'">
              主力 {{ fmtMoney(item.mainInflow) }}
            </span>
            <em v-if="item.riskLabel" class="blown-tag">{{ item.riskLabel }}</em>
          </div>
        </div>
        <p class="section-note">
          按连板高度与炸板次数排序；标「放量炸板 · 主力净流出」的只作风险样本，不进入明日待选。
        </p>
      </div>
      <div class="panel list-panel">
        <h4>跌停 / 弱势</h4>
        <div v-if="!down.length" class="empty-mini">今日没有跌停股。</div>
        <div v-for="item in down" :key="item.code" class="list-row">
          <span class="nm">{{ item.name }}</span>
          <span class="sub">{{ item.sector }}</span>
          <span class="pct is-down">{{ fmtPct(item.pct) }}</span>
        </div>
      </div>
    </section>

    <section class="conclusion">
      <h4>复盘结论</h4>
      <p>{{ conclusion }}</p>
    </section>

    <div class="disclaimer">
      <b>口径：</b>炸板率 = 炸板家数 /（涨停 + 炸板）；昨日涨停溢价按昨日连板层级分组统计今日涨跌幅；
      晋级率按“昨日首板今日二板 / 昨日连板今日继续涨停”计算。数据来自公开行情，存在延迟与缺失可能。
    </div>
  </div>
</template>

<style scoped>
.review-head {
  padding: 2px 2px 0;
}

.review-title-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 4px;
}

.review-title-row h2 {
  margin: 0;
  font-size: 23px;
  font-weight: 700;
  letter-spacing: 0.03em;
}

.review-desc {
  margin: 7px 0 0;
  font-size: 12px;
  line-height: 1.75;
  color: var(--muted);
}

/* ---------------- 短线作战室 ---------------- */

.plan-section {
  gap: 12px;
}

.plan-card {
  position: relative;
  padding: 15px;
  border-radius: var(--radius);
  border: 1px solid var(--line);
  background: linear-gradient(155deg, rgba(24, 30, 44, 0.92), rgba(9, 13, 20, 0.96));
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.04),
    0 12px 30px rgba(0, 0, 0, 0.24);
  overflow: hidden;
}

.plan-card::before {
  content: "";
  position: absolute;
  inset: 0 0 auto;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(243, 199, 119, 0.28), transparent 75%);
  pointer-events: none;
}

.plan-card--warn {
  border-color: rgba(243, 199, 119, 0.26);
}

.plan-card--risk {
  border-color: rgba(255, 84, 96, 0.3);
}

.plan-card--ok {
  border-color: rgba(43, 211, 154, 0.26);
}

.plan-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}

.plan-stance {
  font-size: 17.5px;
  font-weight: 700;
  letter-spacing: 0.03em;
  line-height: 1.35;
  color: var(--text);
}

.plan-card--warn .plan-stance {
  color: var(--gold);
}

.plan-card--risk .plan-stance {
  color: var(--up);
}

.plan-card--ok .plan-stance {
  color: var(--down);
}

.plan-position {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--muted);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 3px 7px;
  background: rgba(255, 255, 255, 0.03);
  white-space: nowrap;
}

.plan-summary {
  margin: 9px 0 0;
  font-size: 13.5px;
  line-height: 1.75;
  color: var(--text-soft);
}

.plan-blockers {
  list-style: none;
  margin: 10px 0 0;
  padding: 8px 10px;
  border: 1px solid rgba(255, 180, 94, 0.22);
  border-radius: 8px;
  background: rgba(255, 180, 94, 0.06);
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.plan-blockers li {
  position: relative;
  padding-left: 11px;
  font-size: 12px;
  line-height: 1.65;
  color: var(--warn);
}

.plan-blockers li::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0.62em;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--warn);
}

/* ---------------- 准三关 · 只观察 ---------------- */

.near-gate {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 13px;
  border-radius: var(--radius);
  border: 1px dashed rgba(243, 199, 119, 0.24);
  background: rgba(243, 199, 119, 0.04);
}

.near-gate-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--gold);
}

.near-gate-head .dim {
  font-size: 11px;
  font-weight: 400;
}

.near-gate-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(255, 255, 255, 0.02);
}

.near-gate-top {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
}

.near-gate-top b {
  font-size: 14px;
}

.near-gate-top .chip {
  margin-left: auto;
}

.near-gate-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
}

.near-gate-gap {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--warn);
}

.near-gate-note {
  margin: 0;
  font-size: 11px;
  line-height: 1.65;
  color: var(--muted);
}

.plan-review {
  list-style: none;
  margin: 11px 0 0;
  padding: 9px 0 0;
  border-top: 1px dashed rgba(255, 255, 255, 0.08);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.plan-review li {
  position: relative;
  padding-left: 12px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--muted);
}

.plan-review li::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0.66em;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--gold);
  opacity: 0.65;
}

.plan-scenarios {
  margin-top: 11px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.scenario {
  border: 1px solid var(--line);
  border-left: 2px solid var(--line-strong);
  border-radius: 10px;
  padding: 9px 10px;
  background: rgba(255, 255, 255, 0.018);
}

.scenario.is-active {
  border-color: rgba(243, 199, 119, 0.28);
  border-left-color: var(--gold);
  background: var(--gold-soft);
}

.scenario-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 650;
  color: var(--text-soft);
}

.scenario-head em {
  font-style: normal;
  font-size: 10.5px;
  color: var(--gold);
  border: 1px solid var(--gold-line);
  border-radius: 4px;
  padding: 1px 4px;
}

.scenario p {
  margin: 4px 0 0;
  font-size: 11.5px;
  line-height: 1.65;
  color: var(--muted);
}

.leader-card {
  padding: 15px;
  border-radius: var(--radius);
  border: 1px solid var(--gold-line);
  background: linear-gradient(160deg, rgba(243, 199, 119, 0.1), rgba(13, 18, 28, 0.95) 55%);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.05),
    0 12px 30px rgba(0, 0, 0, 0.24);
}

.leader-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.leader-title {
  min-width: 0;
}

.leader-title small {
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--gold);
}

.leader-name-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 3px;
}

.leader-name-row b {
  font-size: 20px;
  letter-spacing: 0.02em;
}

.leader-name-row span {
  font-size: 11.5px;
  color: var(--muted);
}

.leader-name-row span:nth-child(2) {
  color: var(--gold);
  border: 1px solid var(--gold-line);
  border-radius: 5px;
  padding: 1px 5px;
}

.leader-prob {
  flex-shrink: 0;
  text-align: right;
}

.leader-prob b {
  font-family: var(--mono);
  font-size: 25px;
  color: var(--gold);
  line-height: 1;
}

.leader-prob b small {
  font-size: 11px;
  margin-left: 1px;
}

.leader-prob span {
  display: block;
  margin-top: 3px;
  font-size: 10.5px;
  color: var(--dim);
}

.leader-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 10px;
}

.leader-meta span {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-soft);
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 2px 6px;
  background: rgba(255, 255, 255, 0.03);
}

.leader-thesis {
  margin: 10px 0 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--gold);
}

.leader-why {
  list-style: none;
  margin: 7px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.leader-why li {
  position: relative;
  padding-left: 11px;
  font-size: 11.5px;
  line-height: 1.65;
  color: var(--muted);
}

.leader-why li::before {
  content: "›";
  position: absolute;
  left: 0;
  color: var(--gold);
}

.leader-note {
  margin: 8px 0 0;
  padding: 7px 9px;
  border-radius: 8px;
  background: rgba(243, 199, 119, 0.07);
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--text-soft);
}

.leader-risk {
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 1.65;
  color: #ffb0b5;
}

.leader-risk span {
  margin-right: 6px;
  color: var(--up);
}

.promo-panel,
.cal-panel,
.oneword-panel,
.height-panel,
.reject-panel {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: linear-gradient(158deg, rgba(18, 24, 36, 0.9), rgba(9, 12, 19, 0.96));
  overflow: hidden;
}

.promo-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 11px 14px;
  border-bottom: 1px solid var(--line);
}

.promo-head span:first-child {
  font-size: 13px;
  font-weight: 650;
  letter-spacing: 0.04em;
  color: var(--text-soft);
}

.promo-head span:last-child {
  font-size: 10.5px;
  color: var(--dim);
}

.promo-row {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) 58px;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.promo-row:last-child {
  border-bottom: 0;
}

.promo-row.is-top {
  background: linear-gradient(90deg, rgba(243, 199, 119, 0.08), transparent 70%);
}

.promo-rank {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  border: 1px solid var(--line-strong);
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--muted);
}

.promo-row.is-top .promo-rank {
  color: #151007;
  background: var(--gold);
  border-color: var(--gold);
  font-weight: 700;
}

.promo-main {
  min-width: 0;
}

.promo-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
}

.promo-title b {
  font-size: 15px;
  letter-spacing: 0.02em;
}

.promo-board {
  font-size: 10.5px;
  line-height: 1.2;
  color: var(--gold);
  border: 1px solid var(--gold-line);
  background: var(--gold-soft);
  border-radius: 4px;
  padding: 1px 4px;
}

.promo-sector {
  font-size: 11px;
  color: var(--dim);
}

.promo-node {
  font-size: 10.5px;
  line-height: 1.2;
  color: var(--blue);
  border: 1px solid rgba(102, 169, 255, 0.25);
  border-radius: 4px;
  padding: 1px 4px;
}

.promo-thesis {
  margin: 4px 0 0;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--gold);
}

.promo-why {
  margin: 3px 0 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--muted);
}

.promo-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  margin-top: 5px;
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--dim);
}

.promo-risk {
  margin: 5px 0 0;
  font-size: 10.5px;
  line-height: 1.55;
  color: #ffb0b5;
}

.promo-prob {
  align-self: start;
  padding-top: 1px;
  text-align: right;
}

.promo-prob b {
  font-family: var(--mono);
  font-size: 19px;
  line-height: 1.1;
  color: var(--gold);
}

.promo-prob b small {
  font-size: 9.5px;
}

.promo-prob span {
  display: block;
  margin-top: 2px;
  font-family: var(--mono);
  font-size: 9.5px;
  color: var(--dim);
  white-space: nowrap;
}

.promo-prob em {
  display: block;
  margin-top: 3px;
  font-family: var(--mono);
  font-size: 8.5px;
  font-style: normal;
  line-height: 1.35;
  color: var(--dim);
  white-space: nowrap;
}

.cal-chip {
  padding: 1px 5px;
  border: 1px solid rgba(102, 169, 255, 0.25);
  border-radius: 4px;
  background: rgba(102, 169, 255, 0.07);
  color: var(--blue);
  font-family: var(--mono);
  font-size: 9.5px;
  line-height: 1.5;
  white-space: nowrap;
}

.cal-toggle {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 11px 14px;
  border: 0;
  background: transparent;
  color: var(--text-soft);
  font-size: 12.5px;
  font-weight: 650;
  letter-spacing: 0.03em;
  text-align: left;
}

.cal-toggle span:last-child {
  flex-shrink: 0;
  color: var(--dim);
  font-size: 10.5px;
  font-weight: 400;
  white-space: nowrap;
}

.cal-body {
  padding: 0 14px 12px;
  border-top: 1px dashed rgba(255, 255, 255, 0.06);
}

.cal-metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  margin-top: 10px;
}

.cal-metrics > div {
  padding: 7px 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.02);
}

.cal-metrics small {
  display: block;
  font-size: 9.5px;
  color: var(--dim);
}

.cal-metrics b {
  display: block;
  margin-top: 2px;
  font-family: var(--mono);
  font-size: 15px;
  color: var(--text-soft);
}

.cal-metrics b em {
  font-style: normal;
  font-size: 9.5px;
  color: var(--dim);
}

.cal-line {
  margin: 8px 0 0;
  font-size: 10.5px;
  line-height: 1.65;
  color: var(--muted);
}

.cal-buckets {
  margin-top: 8px;
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
}

.cal-bucket-head,
.cal-bucket-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 42px 56px;
  gap: 6px;
  padding: 5px 8px;
  font-size: 10.5px;
}

.cal-bucket-head {
  color: var(--dim);
  background: rgba(255, 255, 255, 0.025);
}

.cal-bucket-head span:nth-child(2),
.cal-bucket-head span:nth-child(3) {
  text-align: right;
}

.cal-bucket-row {
  border-top: 1px solid rgba(255, 255, 255, 0.04);
  color: var(--muted);
}

.cal-bucket-row span:nth-child(2) {
  text-align: right;
  font-family: var(--mono);
  color: var(--dim);
}

.cal-bucket-row b {
  text-align: right;
  font-family: var(--mono);
  color: var(--gold);
}

.cal-notes {
  margin: 8px 0 0;
  padding-left: 16px;
  font-size: 10.5px;
  line-height: 1.65;
  color: var(--dim);
}

.cal-notes li + li {
  margin-top: 3px;
}

.promo-foot {
  margin: 0;
  padding: 9px 14px 12px;
  border-top: 1px dashed rgba(255, 255, 255, 0.06);
  font-size: 10.5px;
  line-height: 1.65;
  color: var(--dim);
}

.promo-empty {
  padding: 16px 14px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--muted);
}

.height-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding: 11px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  border-left: 2px solid transparent;
}

.height-row:last-of-type {
  border-bottom: 0;
}

.height-row.is-high {
  border-left-color: var(--up);
  background: rgba(255, 84, 96, 0.045);
}

.height-row.is-mid {
  border-left-color: var(--warn);
}

.height-main {
  min-width: 0;
}

.height-main p {
  margin: 4px 0 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--muted);
}

.height-ref {
  flex-shrink: 0;
  text-align: right;
  font-size: 9.5px;
  line-height: 1.4;
  color: var(--dim);
}

.height-ref b {
  display: block;
  font-family: var(--mono);
  font-size: 15px;
  color: var(--warn);
}

.oneword-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding: 11px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.oneword-row:last-of-type {
  border-bottom: 0;
}

.oneword-main {
  min-width: 0;
}

.oneword-meta {
  margin: 4px 0 0;
  font-family: var(--mono);
  font-size: 10.5px;
  line-height: 1.55;
  color: var(--dim);
}

.nuke-chip {
  display: inline-flex;
  align-items: center;
  padding: 1px 5px;
  border-radius: 4px;
  border: 1px solid rgba(255, 84, 96, 0.32);
  background: rgba(255, 84, 96, 0.09);
  color: #ffb0b5;
  font-family: var(--mono);
  font-size: 9.5px;
  line-height: 1.5;
  white-space: nowrap;
}

.nuke-chip.is-mid {
  border-color: rgba(255, 180, 94, 0.3);
  background: rgba(255, 180, 94, 0.08);
  color: var(--warn);
}

.nuclear-panel {
  border-top: 1px solid var(--line);
}

.nuclear-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding: 11px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  border-left: 2px solid var(--warn);
}

.nuclear-row.is-high {
  border-left-color: var(--up);
  background: rgba(255, 84, 96, 0.045);
}

.nuclear-main {
  min-width: 0;
}

.nuclear-main p {
  margin: 4px 0 0;
  font-size: 10.8px;
  line-height: 1.6;
  color: rgba(255, 176, 181, 0.88);
}

.nuclear-next {
  flex-shrink: 0;
  text-align: right;
  font-size: 9.5px;
  line-height: 1.5;
  color: var(--dim);
}

.nuclear-next em {
  display: block;
  font-style: normal;
  font-size: 10.5px;
  color: var(--warn);
}

.nuclear-row.is-high .nuclear-next em {
  color: var(--up);
}

.reject-toggle {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 11px 14px;
  font-size: 12.5px;
  color: var(--muted);
}

.reject-toggle span:first-child {
  font-weight: 600;
  color: var(--text-soft);
}

.reject-list {
  border-top: 1px solid var(--line);
}

.reject-row {
  display: flex;
  gap: 9px;
  padding: 10px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.reject-row:last-child {
  border-bottom: 0;
}

.reject-cat {
  flex-shrink: 0;
  align-self: flex-start;
  font-size: 10px;
  line-height: 1.5;
  color: var(--warn);
  border: 1px solid rgba(255, 180, 94, 0.26);
  background: rgba(255, 180, 94, 0.07);
  border-radius: 4px;
  padding: 1px 5px;
  white-space: nowrap;
}

.reject-main {
  min-width: 0;
}

.reject-main p {
  margin: 4px 0 0;
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--muted);
}

.reject-more {
  margin: 0;
  padding: 9px 14px 11px;
  font-size: 10.5px;
  color: var(--dim);
}

.plan-triggers {
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: rgba(255, 255, 255, 0.02);
}

.plan-triggers h4 {
  margin: 0 0 8px;
  font-size: 13.5px;
  letter-spacing: 0.04em;
  color: var(--text-soft);
}

.plan-triggers ol {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.plan-triggers li {
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--muted);
}

.plan-donot {
  display: flex;
  gap: 9px;
  margin-top: 11px;
  padding-top: 9px;
  border-top: 1px dashed rgba(255, 255, 255, 0.08);
}

.plan-donot > span {
  flex-shrink: 0;
  height: 18px;
  padding: 1px 5px;
  font-size: 10px;
  line-height: 16px;
  color: var(--up);
  border: 1px solid rgba(255, 84, 96, 0.25);
  border-radius: 4px;
}

.plan-donot ul {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.plan-donot li {
  position: relative;
  padding-left: 9px;
  font-size: 11px;
  line-height: 1.55;
  color: var(--muted);
}

.plan-donot li::before {
  content: "·";
  position: absolute;
  left: 0;
  color: var(--up);
}

/* ---------------- 打板客审美 ---------------- */

.hotshot-section {
  gap: 12px;
}

.hotshot-intro p {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.75;
  color: var(--muted);
}

.hotshot-panel {
  border-radius: var(--radius);
  border: 1px solid var(--line);
  background: linear-gradient(160deg, rgba(19, 26, 39, 0.9), rgba(9, 13, 20, 0.94));
  overflow: hidden;
}

.hotshot-hit {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  gap: 8px;
  padding: 12px 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.045);
}

.hotshot-hit:first-child {
  border-top: 0;
}

.hotshot-hit-rank {
  font-family: var(--mono);
  font-size: 13px;
  font-weight: 600;
  color: var(--gold);
  line-height: 1.5;
}

.hotshot-hit-main {
  min-width: 0;
}

.hotshot-score {
  margin-left: auto;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--gold);
  white-space: nowrap;
}

.hotshot-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 5px;
}

.hotshot-tags .chip {
  height: 20px;
  font-size: 10px;
  letter-spacing: 0;
}

.hotshot-line {
  margin: 5px 0 0;
  font-size: 11px;
  line-height: 1.65;
  color: var(--muted);
}

.hotshot-risk {
  margin: 5px 0 0;
  font-size: 10.8px;
  line-height: 1.65;
  color: rgba(255, 154, 162, 0.84);
}

.hotshot-ready {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 13px 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.045);
}

.hotshot-ready:first-child {
  border-top: 0;
}

.hotshot-ready-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px 7px;
}

.hotshot-ready-head .promo-title {
  flex: 1;
}

.hotshot-bucket {
  font-size: 10px;
  line-height: 1.3;
  color: var(--blue);
  border: 1px solid rgba(102, 169, 255, 0.24);
  background: var(--blue-soft);
  border-radius: 4px;
  padding: 1px 5px;
  white-space: nowrap;
}

.hotshot-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 3px 9px;
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--dim);
}

.hotshot-meta .is-dim {
  color: var(--warn);
}

.hotshot-entry {
  display: flex;
  gap: 8px;
  padding: 8px 9px;
  border-radius: 7px;
  border: 1px solid rgba(243, 199, 119, 0.14);
  background: rgba(243, 199, 119, 0.04);
}

.hotshot-entry > span {
  flex-shrink: 0;
  padding-top: 1px;
  font-size: 10.5px;
  font-weight: 650;
  color: var(--gold);
}

.hotshot-entry ul {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.hotshot-entry li {
  font-size: 10.9px;
  line-height: 1.65;
  color: var(--muted);
}

.hotshot-giveup,
.hotshot-position {
  margin: 0;
  font-size: 10.8px;
  line-height: 1.65;
}

.hotshot-giveup {
  color: rgba(255, 154, 162, 0.8);
}

.hotshot-position {
  color: var(--warn);
}

.hotshot-watch {
  padding: 0 14px 4px;
  border-top: 1px solid var(--line);
}

.hotshot-subhead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 0 5px;
  font-size: 11px;
  color: var(--dim);
}

.hotshot-watch-row {
  padding: 8px 0;
  border-top: 1px dashed rgba(255, 255, 255, 0.06);
}

.hotshot-watch-title {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 5px;
  font-size: 10.8px;
  color: var(--muted);
}

.hotshot-watch-title b {
  font-size: 13px;
  color: var(--text-soft);
}

.hotshot-watch-title em {
  margin-left: auto;
  font-family: var(--mono);
  font-size: 10.5px;
  font-style: normal;
  color: var(--gold);
}

.hotshot-watch-row p {
  margin: 4px 0 0;
  font-size: 10.6px;
  line-height: 1.6;
  color: var(--muted);
}

/* ---------- 推荐复盘 ---------- */

.rec-stats {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 1px;
  background: rgba(255, 255, 255, 0.05);
  border-bottom: 1px solid var(--line);
}

.rec-stat {
  grid-column: span 2;
  padding: 11px 12px;
  background: rgba(10, 14, 22, 0.72);
}

.rec-stat:nth-child(n + 4) {
  grid-column: span 3;
}

.rec-stat small {
  display: block;
  font-size: 10px;
  color: var(--dim);
}

.rec-stat b {
  display: block;
  margin-top: 3px;
  font-family: var(--mono);
  font-size: 18px;
  line-height: 1.2;
  color: var(--text);
}

.rec-stat span {
  display: block;
  margin-top: 2px;
  font-size: 9.5px;
  color: var(--dim);
}

.rec-caveat {
  margin: 0;
  padding: 10px 14px 0;
  font-size: 11px;
  line-height: 1.65;
  color: var(--warn);
}

.rec-today,
.rec-watch-line {
  margin: 8px 14px 0;
  padding: 8px 10px;
  border: 1px solid rgba(255, 180, 94, 0.16);
  border-radius: 6px;
  background: rgba(255, 180, 94, 0.045);
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--muted);
}

.rec-watch-line {
  border-color: rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.025);
}

.rec-blockers {
  margin: 6px 0 0;
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--warn);
}

.rec-days {
  margin-top: 10px;
  border-top: 1px solid var(--line);
}

.rec-day {
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.rec-day-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px 7px;
  padding: 9px 14px 7px;
  font-size: 11px;
  color: var(--muted);
}

.rec-day-head > b {
  font-family: var(--mono);
  font-size: 13px;
  color: var(--text-soft);
}

.rec-day-action {
  color: var(--dim);
}

.rec-day-stat {
  margin-left: auto;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--dim);
}

.rec-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  padding: 7px 14px 8px;
  border-top: 1px dashed rgba(255, 255, 255, 0.05);
  font-size: 10.5px;
  color: var(--muted);
}

.rec-row > b {
  font-size: 12.5px;
  color: var(--text-soft);
}

.rec-code {
  font-family: var(--mono);
  font-size: 9.5px;
  color: var(--dim);
}

.rec-trigger {
  color: var(--dim);
}

.rec-trigger.is-hit {
  color: var(--gold);
  font-weight: 600;
}

.rec-toggle,
.rec-retry {
  display: block;
  width: calc(100% - 28px);
  margin: 9px 14px 0;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.025);
  font-size: 11px;
  color: var(--muted);
}

.rec-retry {
  display: inline-block;
  width: auto;
  margin: 6px 0 0;
  color: var(--gold);
}

.rec-empty {
  padding: 14px;
  font-size: 12px;
  line-height: 1.65;
  color: var(--muted);
}

.rec-note {
  margin: 0;
  padding: 10px 14px 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.05);
  font-size: 10px;
  line-height: 1.7;
  color: var(--dim);
}

/* ---------- 隔夜台账 · 学习 ---------- */

.night-ledger-section .section-title {
  color: var(--gold);
}

.night-ledger {
  border-color: rgba(243, 199, 119, 0.16);
}

.on-gate-line {
  margin: 0;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  font-size: 10.6px;
  line-height: 1.65;
  color: var(--muted);
}

.on-cohorts {
  display: grid;
  gap: 4px;
  margin: 8px 14px 0;
  padding: 8px 10px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.022);
  font-size: 10.4px;
  line-height: 1.6;
  color: var(--dim);
}

.on-learning {
  margin-top: 10px;
  padding: 0 14px;
}

.on-learning-head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 8px;
  padding-bottom: 4px;
}

.on-learning-head b {
  font-size: 12px;
  color: var(--text-soft);
}

.on-learning-head span {
  font-size: 9.5px;
  color: var(--dim);
}

.on-note {
  margin: 4px 0 0;
  font-size: 10.4px;
  line-height: 1.65;
  color: var(--muted);
}

.on-bucket-block {
  margin-top: 8px;
}

.on-bucket-title {
  margin-bottom: 5px;
  font-size: 10px;
  letter-spacing: 0.04em;
  color: var(--dim);
}

.on-bucket-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 5px;
}

.on-bucket {
  padding: 7px 9px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.02);
}

.on-bucket span {
  display: block;
  font-size: 10px;
  color: var(--muted);
}

.on-bucket b {
  display: block;
  margin-top: 2px;
  font-family: var(--mono);
  font-size: 14px;
  color: var(--text);
}

.on-bucket small {
  display: block;
  margin-top: 1px;
  font-size: 9px;
  color: var(--dim);
}

.on-days {
  margin-top: 10px;
  border-top: 1px solid var(--line);
}

.on-days-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 9px 14px 0;
}

.on-days-head b {
  font-size: 12px;
  color: var(--text-soft);
}

.on-days-head span {
  font-size: 9.5px;
  color: var(--dim);
}

.on-obs-line {
  margin: 0;
  padding: 7px 14px 9px;
  border-top: 1px dashed rgba(255, 255, 255, 0.05);
  font-size: 10px;
  line-height: 1.6;
  color: var(--dim);
}

.on-share {
  margin: 10px 14px 0;
  border: 1px solid rgba(243, 199, 119, 0.2);
  border-radius: 8px;
  background: rgba(243, 199, 119, 0.035);
}

.on-share-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid rgba(243, 199, 119, 0.12);
}

.on-share-head b {
  font-size: 11px;
  color: var(--gold);
}

.on-share-btn {
  margin-left: auto;
  padding: 5px 10px;
  border: 1px solid rgba(243, 199, 119, 0.28);
  border-radius: 5px;
  background: rgba(243, 199, 119, 0.08);
  font-size: 10px;
  color: var(--gold);
}

.on-share pre {
  margin: 0;
  padding: 9px 10px 11px;
  font-family: var(--mono);
  font-size: 9.6px;
  line-height: 1.7;
  color: var(--muted);
  white-space: pre-wrap;
  word-break: break-word;
}

/* ---------- 隔夜三强 ---------- */

.night-head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 12px 14px 0;
}

.night-head p {
  margin: 0;
  font-size: 10.8px;
  line-height: 1.6;
  color: var(--muted);
}

.night-list {
  margin-top: 10px;
  border-top: 1px solid var(--line);
}

.night-row {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  gap: 8px;
  padding: 11px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.night-rank {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  border: 1px solid rgba(243, 199, 119, 0.3);
  background: rgba(243, 199, 119, 0.1);
  color: #ffe2a9;
  font-family: var(--mono);
  font-size: 11px;
}

.night-body {
  min-width: 0;
}

.night-name {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 7px;
}

.night-name b {
  font-size: 14px;
  line-height: 1.3;
  color: var(--text);
}

.night-name .mono {
  font-size: 9.5px;
  color: var(--dim);
}

.night-sector {
  font-size: 10.5px;
  color: var(--muted);
}

.night-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 3px 9px;
  margin-top: 4px;
  font-size: 10.5px;
  color: var(--muted);
}

.night-meta b {
  font-family: var(--mono);
  color: var(--text-soft);
}

.night-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 5px;
}

.night-why {
  margin: 5px 0 0;
  font-size: 10.5px;
  line-height: 1.55;
  color: var(--text-soft);
}

.night-risk {
  margin: 3px 0 0;
  font-size: 10.2px;
  line-height: 1.55;
  color: rgba(255, 154, 162, 0.8);
}

.night-empty {
  padding: 14px;
  font-size: 11px;
  line-height: 1.65;
  color: var(--muted);
}

.night-empty b {
  display: block;
  margin-bottom: 4px;
  font-size: 13px;
  color: var(--text-soft);
}

.night-empty p {
  margin: 0 0 4px;
}

.night-note {
  margin: 0;
  padding: 10px 14px 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.05);
  font-size: 10px;
  line-height: 1.7;
  color: var(--dim);
}

/* ---------- 尾盘超预期 ---------- */

.tail-review-section .section-title {
  color: var(--gold);
}

.tail-review-panel {
  border-color: rgba(243, 199, 119, 0.18);
  background:
    radial-gradient(110% 120% at 100% 0%, rgba(243, 199, 119, 0.06), transparent 60%),
    rgba(255, 255, 255, 0.02);
}

.tail-review-plan {
  margin: 4px 0 0;
  font-size: 10.5px;
  line-height: 1.55;
  color: var(--gold);
}

.tail-review-note {
  color: rgba(243, 199, 119, 0.55);
}

@media (max-width: 370px) {
  .promo-row {
    grid-template-columns: 20px minmax(0, 1fr) 52px;
    gap: 6px;
    padding: 11px 12px;
  }

  .promo-prob b {
    font-size: 17px;
  }

  .plan-stance {
    font-size: 16.5px;
  }
}
</style>