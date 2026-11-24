<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ScoreRing from '../components/ScoreRing.vue'
import { getAuction, getDragonProfile, getOvernight } from '../lib/api'
import { catalystType, isCatalystValid, useCatalysts } from '../lib/catalysts'
import { openCatalyst, toast, ui } from '../lib/ui'
import { fmtCap, fmtMoney, fmtNum, fmtPct, fmtPrice, pctTone, timeLabel } from '../lib/format'

const props = defineProps({
  dashboard: { type: Object, required: true }
})

const { items } = useCatalysts()

const segment = ref('auction')
const segments = [
  { key: 'auction', label: '竞价 / 盘中', sub: '9:15–15:00' },
  { key: 'overnight', label: '隔夜计划', sub: '15:00 后定稿' },
  { key: 'profile', label: '老龙画像', sub: '历史样本' }
]
const flowSteps = ['收盘复盘', '三关筛选', '催化核验', '画像匹配', '竞价 / 盘中']

const auction = ref(null)
const overnight = ref(null)
const profile = ref(null)
const auctionLoading = ref(false)
const overnightLoading = ref(false)
const profileLoading = ref(false)
const auctionError = ref('')
const overnightError = ref('')
const profileError = ref('')
const expanded = ref('')
const showAllAuction = ref(false)

let auctionTimer = null
let overnightTimer = null
let profileTimer = null
let auctionBusy = false
let overnightBusy = false
let profileBusy = false
let destroyed = false
let profileTries = 0

const marketKey = computed(() => (props.dashboard.market && props.dashboard.market.key) || 'closed')
const phase = computed(() => props.dashboard.sentiment && props.dashboard.sentiment.phase ? props.dashboard.sentiment.phase : {})
const sentimentScore = computed(() =>
  props.dashboard.sentiment && props.dashboard.sentiment.score != null
    ? props.dashboard.sentiment.score
    : null
)
const readySectors = computed(() =>
  props.dashboard.sectors && props.dashboard.sectors.counts
    ? props.dashboard.sectors.counts.dataReady || 0
    : 0
)
const gate = computed(() => props.dashboard.gate || {})

const segTitle = computed(
  () =>
    ({
      auction: auction.value && auction.value.intraday ? '盘中实时抓板' : '盘前竞价抓强',
      overnight: '盘后隔夜计划',
      profile: '老龙头画像'
    })[segment.value]
)
const segDesc = computed(
  () =>
    ({
      auction:
        '竞价 9:15–9:30 与盘中 9:30–15:00 都实时计算：盘中按封板确认、近板强度、量比、板块共振与弱转强排序，只列最强 5 只；没有三关与催化，再强也只观察。',
      overnight:
        '收盘后把三关、情绪、弱转强与老龙画像合成条件单。只在三关通过且情绪修复 / 主升时制定，冰点与退潮不挂。',
      profile:
        '回溯板块内 3 板以上领涨股，统计次日延续率与隔夜跳空。样本统计不是准确率，只用于剔除明显不符合龙头特征的标的。'
    })[segment.value]
)

const phaseChipClass = computed(() => {
  const tone = phase.value.tone
  if (tone === 'hot') return 'chip--red'
  if (tone === 'warm') return 'chip--gold'
  if (tone === 'cold') return 'chip--green'
  return 'chip--dim'
})

function catFor(sectorKey) {
  const entry = items[sectorKey]
  if (!entry) return { type: 'none', label: '待催化', valid: false, rumor: false, has: false }
  if (entry.type === 'rumor') {
    return { type: 'rumor', label: '传闻排除', valid: false, rumor: true, has: true }
  }
  if (isCatalystValid(entry)) {
    const meta = catalystType(entry.type)
    return {
      type: entry.type,
      label: `催化·${meta ? meta.short : '有效'}`,
      valid: true,
      rumor: false,
      has: true
    }
  }
  return {
    type: entry.type,
    label: entry.type === 'none' ? '暂无催化' : '待催化',
    valid: false,
    rumor: false,
    has: true
  }
}

function catChipClass(cat) {
  if (cat.rumor) return 'chip--red'
  if (cat.valid) return 'chip--gold'
  return 'chip--warn'
}

/* ---------------- auction ---------------- */

const auctionRaw = computed(() => {
  const a = auction.value
  if (!a) return []
  return (a.active ? a.candidates : a.preview) || []
})

const auctionRumorCount = computed(
  () => auctionRaw.value.filter((x) => catFor(x.sectorKey).rumor).length
)

const auctionCards = computed(() =>
  auctionRaw.value
    .filter((x) => !catFor(x.sectorKey).rumor)
    .map((x) => {
      const cat = catFor(x.sectorKey)
      const active = !!(auction.value && auction.value.active)
      let displayLabel = '竞价前准备'
      if (active) {
        if (x.status === 'confirm' && cat.valid) displayLabel = '可执行候选'
        else if (x.status === 'confirm') displayLabel = '待催化'
        else if (x.status === 'watch') displayLabel = '观察'
        else displayLabel = '剔除'
      }
      return {
        ...x,
        cat,
        displayLabel,
        actionable: active && x.status === 'confirm' && cat.valid
      }
    })
)

const visibleAuction = computed(() =>
  showAllAuction.value ? auctionCards.value : auctionCards.value.slice(0, 6)
)
const auctionActionable = computed(() => auctionCards.value.filter((x) => x.actionable).length)
const auctionWatch = computed(
  () => auctionCards.value.filter((x) => !x.actionable && x.status !== 'drop').length
)

const auctionStage = computed(() => (auction.value && auction.value.stage) || null)
const auctionActive = computed(() => !!(auction.value && auction.value.active))
const auctionIsIntraday = computed(() => !!(auction.value && auction.value.intraday))
const auctionSteps = [
  { key: 'trial', time: '9:15', label: '试撮' },
  { key: 'locked', time: '9:20', label: '锁单' },
  { key: 'final', time: '9:25', label: '定稿' },
  { key: 'open', time: '9:30', label: '承接' }
]
const auctionStepsView = computed(() =>
  auctionSteps.map((s, i) =>
    i === 3 && auctionIsIntraday.value ? { ...s, label: '盘中' } : s
  )
)
const auctionConfirmLabel = computed(() => {
  if (!auctionActive.value) return '竞价前准备'
  return auctionIsIntraday.value ? '封板确认' : '可执行候选'
})
const auctionListLabel = computed(() => {
  const n = auctionCards.value.length
  const base = n ? `最强 ${n} 只` : '暂无合格核心'
  if (!auctionActive.value) return `${base} · 下一场准备`
  return auctionIsIntraday.value ? `${base} · 1.5 秒实时` : `${base} · 1.5 秒轮询`
})
const auctionRingLabel = computed(() => {
  if (!auctionActive.value) return '准备分'
  return auctionIsIntraday.value ? '实时分' : '竞价分'
})

const currentStep = computed(() => {
  const key = auctionStage.value ? auctionStage.value.key : null
  if (key === 'trial') return 0
  if (key === 'locked') return 1
  if (key === 'final') return 2
  if (['morning', 'lunch', 'afternoon', 'closed'].includes(marketKey.value)) return 3
  return -1
})

const stageClass = computed(() => `stage--${(auctionStage.value && auctionStage.value.key) || 'off'}`)

const countdownText = computed(() => {
  const a = auction.value
  if (!a || !a.market) return ''
  const m = a.market
  if (m.key === 'auction') {
    const target = m.mins < 560 ? 560 : 565
    const left = target - m.mins
    if (left <= 0) return ''
    return `距 ${target === 560 ? '9:20 锁单' : '9:25 定稿'}约 ${left} 分钟`
  }
  if (m.key === 'waiting') return '竞价已定稿 · 9:30 看承接'
  if (m.key === 'preopen') return '9:15 开始集合竞价'
  return ''
})

const auctionStageLabel = computed(() => {
  const a = auction.value
  if (!a) return '--'
  return a.active ? a.stage.label : '非竞价时段'
})

/* ---------------- overnight ---------------- */

function decorateOvernight(c, recommended) {
  const cat = catFor(c.sectorKey)
  const status = overnight.value ? overnight.value.status : ''
  const mode = overnight.value && overnight.value.mode ? overnight.value.mode.key : ''
  let displayLabel = recommended ? '数据候选' : '观察'
  if (cat.rumor) displayLabel = '传闻排除'
  else if (recommended) {
    if (status === 'ready' && mode === 'final') displayLabel = cat.valid ? '可挂条件单' : '待催化核验'
    else if (status === 'preview') displayLabel = '预演草稿'
    else if (mode === 'locked') displayLabel = '盘前不追加'
  }
  return {
    ...c,
    cat,
    displayLabel,
    canExecute: recommended && c.acceptable && status === 'ready' && mode === 'final' && cat.valid
  }
}

const overnightRecs = computed(() =>
  ((overnight.value && overnight.value.recommendations) || [])
    .filter((c) => !catFor(c.sectorKey).rumor)
    .map((c) => decorateOvernight(c, true))
)
const overnightPrep = computed(() =>
  ((overnight.value && overnight.value.preparation) || [])
    .filter((c) => !catFor(c.sectorKey).rumor)
    .map((c) => decorateOvernight(c, !!c.acceptable))
)
const overnightPrepShown = computed(() => {
  if (!overnightRecs.value.length) return overnightPrep.value
  const recCodes = new Set(overnightRecs.value.map((c) => c.code))
  return overnightPrep.value.filter((c) => !recCodes.has(c.code))
})
const overnightWatch = computed(() => {
  const prepCodes = new Set(overnightPrep.value.map((c) => c.code))
  return ((overnight.value && overnight.value.watchlist) || [])
    .filter((c) => !catFor(c.sectorKey).rumor && !prepCodes.has(c.code))
    .map((c) => decorateOvernight(c, false))
})
const overnightRumorCount = computed(() =>
  ((overnight.value && overnight.value.recommendations) || []).filter(
    (c) => catFor(c.sectorKey).rumor
  ).length
)
const overnightExecutable = computed(() => overnightRecs.value.filter((c) => c.canExecute).length)

function modeClass(status) {
  if (status === 'empty' || status === 'defend') return 'mode--cold'
  if (status === 'wait' || status === 'locked') return 'mode--warn'
  if (status === 'preview') return 'mode--preview'
  return 'mode--ready'
}

function statusChipClass(c) {
  if (c.cat && c.cat.rumor) return 'chip--red'
  if (c.actionable || c.canExecute) return 'chip--gold'
  if (c.displayLabel === '待催化' || c.displayLabel === '待催化核验') return 'chip--warn'
  if (c.displayLabel === '预演草稿') return 'chip--blue'
  return 'chip--dim'
}

/* ---------------- profile ---------------- */

const profileReady = computed(
  () => !!(profile.value && profile.value.samples != null && profile.value.buckets)
)
const profileBuilding = computed(
  () =>
    profileLoading.value ||
    !!(profile.value && (profile.value.building || profile.value.pending))
)
const profileStats = computed(() => (profile.value && profile.value.stats) || {})
const bucketDefs = [
  { key: 'height', title: '连板高度', hint: '3–5 板是主战场，5 板以上只观察' },
  { key: 'sealTime', title: '首封时间', hint: '越早封板，主动性越强' },
  { key: 'sealRatio', title: '封单 / 流通', hint: '≥ 1% 才算强，< 0.5% 偏薄' },
  { key: 'turnover', title: '换手率', hint: '3%–20% 为良性区间' },
  { key: 'floatCap', title: '流通市值', hint: '50–300 亿更适配短线' },
  { key: 'sectorCount', title: '板块涨停家数', hint: '≥ 3 家才有梯队' }
]

const bucketGroups = computed(() => {
  const buckets = (profile.value && profile.value.buckets) || {}
  return bucketDefs
    .map((def) => {
      const rows = buckets[def.key] || []
      return {
        ...def,
        rows,
        totalSamples: rows.reduce((sum, b) => sum + (b.samples || 0), 0),
        totalContinued: rows.reduce((sum, b) => sum + (b.continued || 0), 0)
      }
    })
    .filter((g) => g.rows.length)
})

const recentSamples = computed(() => (profile.value && profile.value.recentSamples) || [])
const profileRules = computed(
  () => (profile.value && profile.value.rules && profile.value.rules.items) || []
)

function barWidth(rate) {
  if (rate == null) return '0%'
  return `${Math.max(0, Math.min(100, rate))}%`
}

function fmtStamp(stamp) {
  if (!stamp || stamp.length !== 8) return '--'
  return `${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`
}

function clockOf(iso) {
  if (!iso) return '--'
  try {
    return timeLabel(new Date(iso))
  } catch (e) {
    return '--'
  }
}

/* ---------------- actions ---------------- */

function toggleExpand(key) {
  expanded.value = expanded.value === key ? '' : key
}

function sectorOf(key, extra = {}) {
  const found = ((props.dashboard.sectors && props.dashboard.sectors.all) || []).find(
    (s) => s.key === key || s.name === key
  )
  if (found) return found
  return {
    key,
    name: extra.sector || key,
    heat: extra.sectorHeat != null ? extra.sectorHeat : '--',
    todayCount: extra.sectorTodayCount != null ? extra.sectorTodayCount : '--'
  }
}

function editCatalyst(key, extra) {
  if (!key) return
  openCatalyst(sectorOf(key, extra))
}

async function focusAlertStock(code) {
  if (!code) return
  segment.value = 'auction'
  for (let i = 0; i < 3 && !auction.value; i++) {
    await loadAuction()
    if (!auction.value) await new Promise((resolve) => setTimeout(resolve, 900))
  }
  const idx = auctionCards.value.findIndex((x) => x.code === code)
  if (idx < 0) {
    toast('预警票不在当前候选清单，可能已转入观察或剔除')
    ui.alertFocus = ''
    return
  }
  if (idx >= 6) showAllAuction.value = true
  await nextTick()
  const el = document.querySelector(`[data-alert-code="${code}"]`)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('is-alert-flash')
    setTimeout(() => el.classList.remove('is-alert-flash'), 2800)
  }
  ui.alertFocus = ''
}

watch(
  () => ui.alertFocus,
  (code) => {
    if (code) focusAlertStock(code)
  },
  { immediate: true }
)

async function copyPlan(c) {
  const catText = c.cat.valid ? `已核验（${c.cat.label}）` : '未核验（禁止挂单）'
  const text = [
    `【隔夜条件单草稿】${c.name} ${c.code} · ${c.sector}`,
    `收盘 ${fmtPrice(c.close)} · 涨停价 ${fmtPrice(c.limitUp)} · ${c.boardRule}`,
    `触发：竞价高开 +${c.plan.gapLow}% ~ +${c.plan.gapHigh}%，9:20 后不回落，同板块至少 1 只核心共振`,
    `放弃：高开 > +${c.plan.cancelAbove}%，或低开 < ${c.plan.abandonBelow}%，或 9:25 前跌回平盘`,
    ...c.plan.trigger.map((x) => `条件：${x}`),
    ...c.plan.invalid.map((x) => `失效：${x}`),
    `止损：${c.plan.stop}`,
    `仓位：${c.plan.position}`,
    `催化：${catText}`,
    `声明：条件单不是收益承诺，跳空、滑点、停牌都可能让计划失效。`
  ].join('\n')
  try {
    await navigator.clipboard.writeText(text)
    toast('条件单已复制，请自行复核催化与仓位', 'success')
  } catch (e) {
    toast('复制失败，请手动记录条件', 'warn')
  }
}

/* ---------------- loading ---------------- */

async function loadAuction({ silent = false } = {}) {
  if (auctionBusy) return
  auctionBusy = true
  if (!silent) auctionLoading.value = true
  try {
    const data = await getAuction()
    auction.value = data
    auctionError.value = ''
  } catch (err) {
    auctionError.value = err.message || '竞价数据读取失败'
  } finally {
    auctionLoading.value = false
    auctionBusy = false
  }
}

async function loadOvernight({ silent = false } = {}) {
  if (overnightBusy) return
  overnightBusy = true
  if (!silent) overnightLoading.value = true
  try {
    const data = await getOvernight()
    overnight.value = data
    overnightError.value = ''
  } catch (err) {
    overnightError.value = err.message || '隔夜计划读取失败'
  } finally {
    overnightLoading.value = false
    overnightBusy = false
  }
}

async function loadProfile({ force = false, silent = false } = {}) {
  if (profileBusy) return
  profileBusy = true
  if (!silent) profileLoading.value = true
  try {
    const data = await getDragonProfile({ force })
    profile.value = data
    profileError.value = ''
    if (data && (data.building || data.pending)) {
      scheduleProfileRetry()
    } else {
      profileTries = 0
      clearTimeout(profileTimer)
    }
  } catch (err) {
    profileError.value = err.message || '老龙头画像读取失败'
  } finally {
    profileLoading.value = false
    profileBusy = false
  }
}

function scheduleAuction() {
  clearTimeout(auctionTimer)
  if (destroyed || document.hidden || segment.value !== 'auction') return
  let delay = null
  if (auctionActive.value) delay = 1500
  else if (['auction', 'waiting'].includes(marketKey.value)) delay = 1500
  else if (marketKey.value === 'preopen') delay = 10000
  if (!delay) return
  auctionTimer = setTimeout(() => {
    loadAuction({ silent: true })
    scheduleAuction()
  }, delay)
}

function scheduleOvernight() {
  clearTimeout(overnightTimer)
  if (destroyed || document.hidden || segment.value !== 'overnight') return
  if (['closed'].includes(marketKey.value)) return
  if (!['preopen', 'auction', 'waiting', 'morning', 'lunch', 'afternoon'].includes(marketKey.value)) {
    return
  }
  overnightTimer = setTimeout(() => {
    loadOvernight({ silent: true })
    scheduleOvernight()
  }, 30000)
}

function scheduleProfileRetry() {
  clearTimeout(profileTimer)
  if (destroyed || profileTries >= 15) return
  profileTimer = setTimeout(async () => {
    if (document.hidden) return
    profileTries++
    await loadProfile({ silent: true })
  }, 3000)
}

function handleVisibility() {
  if (document.hidden) {
    clearTimeout(auctionTimer)
    clearTimeout(overnightTimer)
    return
  }
  if (segment.value === 'auction') {
    loadAuction({ silent: true })
    scheduleAuction()
  }
  if (segment.value === 'overnight') {
    loadOvernight({ silent: true })
    scheduleOvernight()
  }
}

function rebuildProfile() {
  profileTries = 0
  loadProfile({ force: true })
}

watch(segment, (value) => {
  clearTimeout(auctionTimer)
  clearTimeout(overnightTimer)
  if (value === 'auction') {
    if (!auction.value) loadAuction()
    scheduleAuction()
  } else if (value === 'overnight') {
    if (!overnight.value) loadOvernight()
    scheduleOvernight()
  } else if (!profile.value) {
    loadProfile()
  }
})

watch(marketKey, (key, old) => {
  if (key === old) return
  if (['preopen', 'auction', 'waiting'].includes(key)) loadAuction({ silent: true })
  if (key === 'closed') loadOvernight({ silent: true })
  if (segment.value === 'auction') scheduleAuction()
  if (segment.value === 'overnight') scheduleOvernight()
})

onMounted(() => {
  document.addEventListener('visibilitychange', handleVisibility)
  loadAuction().then(() => scheduleAuction())
  loadOvernight()
  loadProfile()
})

onBeforeUnmount(() => {
  destroyed = true
  clearTimeout(auctionTimer)
  clearTimeout(overnightTimer)
  clearTimeout(profileTimer)
  document.removeEventListener('visibilitychange', handleVisibility)
})
</script>

<template>
  <div class="view edge-view">
    <section class="edge-head">
      <div class="eyebrow">临盘决策 · AUCTION / OVERNIGHT</div>
      <div class="edge-title-row">
        <h2>{{ segTitle }}</h2>
        <span class="chip chip--dim">{{ dashboard.tradeDateLabel }}</span>
      </div>
      <p class="edge-desc">{{ segDesc }}</p>

      <div class="seg">
        <button
          v-for="item in segments"
          :key="item.key"
          class="seg-btn"
          :class="{ 'is-active': segment === item.key }"
          @click="segment = item.key"
        >
          <b>{{ item.label }}</b>
          <small>{{ item.sub }}</small>
        </button>
      </div>

      <div class="flow">
        <div v-for="(step, idx) in flowSteps" :key="step" class="flow-step">
          <span>{{ idx + 1 }}</span>
          <b>{{ step }}</b>
        </div>
      </div>

      <div class="edge-meta">
        <span class="chip" :class="phaseChipClass">{{ phase.label || '--' }}</span>
        <span>情绪 <b class="mono">{{ sentimentScore == null ? '--' : sentimentScore }}</b></span>
        <i class="meta-sep"></i>
        <span>三关 <b class="mono">{{ readySectors }}</b></span>
        <i class="meta-sep"></i>
        <span>{{ gate.label || '--' }}</span>
      </div>
      <div v-if="gate.detail" class="gate-line" :class="{ 'is-empty': gate.key === 'empty' }">
        <span class="chip" :class="gate.key === 'empty' ? 'chip--red' : gate.key === 'defend' ? 'chip--warn' : 'chip--gold'">
          {{ gate.label }}
        </span>
        <span>{{ gate.detail }}</span>
      </div>
    </section>

    <!-- ================= auction ================= -->
    <template v-if="segment === 'auction'">
      <div v-if="auctionError" class="error-strip">
        <span>竞价接口异常</span>
        <p>{{ auctionError }}</p>
        <button class="link-btn" @click="loadAuction()">重试</button>
      </div>

      <section v-if="auction" class="stage-card" :class="stageClass">
        <div class="stage-head">
          <span class="dot" :class="auction.active ? 'dot--live' : 'dot--gold'"></span>
          <b>{{ auction.stage.label }}</b>
          <span class="chip" :class="auction.active ? 'chip--red' : 'chip--dim'">
            {{ auction.active ? '实时评分' : '只做预览' }}
          </span>
          <span class="mono stage-clock">{{ auction.market.now }}</span>
        </div>
        <p class="stage-note">{{ auction.stage.note }}</p>
        <div class="timeline">
          <div
            v-for="(step, idx) in auctionStepsView"
            :key="step.key"
            class="tl-step"
            :class="{ 'is-on': idx === currentStep, 'is-past': idx < currentStep }"
          >
            <span class="tl-dot"></span>
            <b class="mono">{{ step.time }}</b>
            <small>{{ step.label }}</small>
          </div>
        </div>
        <div class="stage-foot">
          <span v-if="countdownText">{{ countdownText }}</span>
          <span>覆盖 {{ auction.universe }} 只</span>
          <span>阶段 {{ auctionStageLabel }}</span>
        </div>
      </section>

      <div v-else-if="auctionLoading" class="panel panel-pad loading-box">
        <span class="spinner"></span>
        <p>正在读取竞价覆盖池与昨日封板质量…</p>
      </div>

      <template v-if="auction">
        <div v-if="auction.nodeBoard" class="node-strip">
          <div class="ns-top">
            <span class="chip chip--red">{{ auction.nodeBoard.maxBoard }} 板空间</span>
            <span class="chip chip--gold">情绪适配 {{ auction.nodeBoard.sentimentFit }}</span>
            <span class="chip chip--dim">3 板+ {{ auction.nodeBoard.high || 0 }} 家</span>
            <span class="chip chip--dim">2 板 {{ auction.nodeBoard.mid || 0 }} 家</span>
          </div>
          <p>{{ auction.nodeBoard.hint }}</p>
          <small>
            情绪 {{ auction.nodeBoard.phaseLabel || '--' }}
            · 晋级 {{ auction.nodeBoard.promote == null ? '--' : auction.nodeBoard.promote + '%' }}
            · 溢价 {{ auction.nodeBoard.premium == null ? '--' : auction.nodeBoard.premium + '%' }}
            · 炸板率 {{ auction.nodeBoard.blowRate == null ? '--' : auction.nodeBoard.blowRate + '%' }}
          </small>
        </div>

        <div class="mini-stats">
          <div class="mini-stat">
            <b class="is-up">{{ auctionActive ? auctionActionable : auctionCards.length }}</b>
            <small>{{ auctionActive ? (auctionIsIntraday ? '封板确认' : '可执行候选') : '竞价前准备' }}</small>
          </div>
          <div class="mini-stat">
            <b>{{ auctionActive ? auctionWatch : overnightExecutable }}</b>
            <small>{{ auctionActive ? '观察' : '隔夜可挂' }}</small>
          </div>
          <div class="mini-stat">
            <b>{{ readySectors }}</b>
            <small>三关板块</small>
          </div>
          <div class="mini-stat">
            <b>{{ profileReady ? profileStats.continuedRate + '%' : '构建中' }}</b>
            <small>样本次日延续</small>
          </div>
        </div>

        <div v-if="auction.stage.key === 'trial'" class="warn-strip">
          <span class="chip chip--red">试撮可撤单</span>
          <p>9:15–9:20 的挂单可以撤，价格与匹配量随时变化。当前只记录，不把“确认”当真。</p>
        </div>
        <div v-if="auctionRumorCount" class="warn-strip">
          <span class="chip chip--red">传闻排除</span>
          <p>{{ auctionRumorCount }} 只属于已标记为纯传闻的方向，已从竞价清单剔除。</p>
        </div>
        <div v-if="!auction.active && profileBuilding" class="info-strip">
          <span class="chip chip--warn">画像构建中</span>
          <p>老龙头画像还在回溯历史样本，当前画像匹配只使用基础规则。</p>
        </div>

        <header class="section-head">
          <span class="section-title">{{ auction.active ? (auction.intraday ? '盘中强势候选' : '竞价强势候选') : '下一场竞价的准备池' }}</span>
          <span class="section-count">{{ auctionListLabel }}</span>
          <button class="section-link" @click="loadAuction()">刷新</button>
        </header>

        <article
          v-for="(c, idx) in visibleAuction"
          :key="c.code"
          class="ac-card"
          :class="{ 'is-actionable': c.actionable, 'is-preview': !auction.active }"
          :data-alert-code="c.code"
        >
          <div class="ac-top">
            <span class="ac-rank">{{ idx + 1 }}</span>
            <div class="ac-id">
              <div class="ac-name">
                <b>{{ c.name }}</b>
                <span class="mono">{{ c.code }}</span>
              </div>
              <div class="ac-sub">
                <span>{{ c.sector }}</span>
                <i v-if="c.lbc">· 昨 {{ c.lbc }} 板</i>
                <i v-if="c.source">· {{ c.source }}</i>
                <i v-if="c.sectorHeat != null">· 热度 {{ c.sectorHeat }}</i>
              </div>
            </div>
            <div class="ac-ring">
              <ScoreRing
                :value="auctionActive ? c.score : (c.prepScore != null ? c.prepScore : c.fit.score)"
                :size="52"
                :stroke="4"
              />
              <small>{{ auctionRingLabel }}</small>
            </div>
          </div>

          <div class="chip-row">
            <span class="chip" :class="statusChipClass(c)">{{ c.displayLabel }}</span>
            <span class="chip" :class="catChipClass(c.cat)">{{ c.cat.label }}</span>
            <span v-for="tag in c.tags" :key="tag" class="tag">{{ tag }}</span>
            <span
              v-if="auctionActive && c.nodeLabel && !c.tags.includes(c.nodeLabel)"
              class="tag"
            >{{ c.nodeLabel }} {{ c.nodeScore }}</span>
          </div>

          <div class="metric-grid">
            <template v-if="auctionActive">
              <div class="metric">
                <small>{{ auctionIsIntraday ? '实时涨幅' : '竞价涨幅' }}</small>
                <b :class="pctTone(c.pct)">{{ fmtPct(c.pct) }}</b>
              </div>
              <div class="metric">
                <small>{{ auctionIsIntraday ? '成交额' : '竞价额' }}</small>
                <b class="mono">{{ fmtMoney(c.amount, { sign: false }) }}</b>
                <span v-if="c.amountRatio != null">占昨量 {{ fmtNum(c.amountRatio, 1) }}%</span>
                <span v-else-if="c.volRatio != null">量比 {{ fmtNum(c.volRatio, 2) }}</span>
              </div>
              <div class="metric">
                <small>{{ auctionIsIntraday ? '封板 / 封单' : '首封 / 封单' }}</small>
                <b class="mono">{{ c.firstSealLabel }}</b>
                <span>{{ c.sealed ? '已封板' : '未封板' }} · {{ fmtNum(c.sealRatio, 2) }}%</span>
              </div>
              <div class="metric">
                <small>基因 / 画像</small>
                <b>{{ c.geneScore }}</b>
                <span>画像 {{ c.fit.score }} · {{ c.fit.sampleEvidence.length }} 条样本</span>
              </div>
            </template>
            <template v-else>
              <div class="metric">
                <small>准备分</small>
                <b>{{ c.prepScore != null ? c.prepScore : c.score }}</b>
                <span>基因 {{ c.geneScore }} · {{ c.observation ? '观察池' : '三关候选' }}</span>
              </div>
              <div class="metric">
                <small>涨停价参考</small>
                <b class="mono is-up">{{ c.limitUp == null ? '--' : fmtPrice(c.limitUp) }}</b>
                <span>{{ c.boardRule }}</span>
              </div>
              <div class="metric">
                <small>首封 / 封单</small>
                <b class="mono">{{ c.firstSealLabel }}</b>
                <span>{{ fmtNum(c.sealRatio, 2) }}% 流通</span>
              </div>
              <div class="metric">
                <small>流通 / 热度</small>
                <b>{{ fmtCap(c.floatCap) }}</b>
                <span>板块 {{ c.heat == null ? '--' : c.heat }}</span>
              </div>
            </template>
          </div>

          <div class="ac-lines">
            <p v-for="line in (auctionActive ? c.reasons : c.why).slice(0, 5)" :key="line">
              <span>·</span>{{ line }}
            </p>
          </div>
          <div v-if="c.risks && c.risks.length" class="ac-risks" :class="{ 'is-soft': !auctionActive }">
            <p v-for="line in c.risks.slice(0, 4)" :key="line">! {{ line }}</p>
          </div>

          <div v-if="!auctionActive" class="prep-box">
            <b>竞价四条件</b>
            <p v-for="line in c.plan" :key="line">{{ line }}</p>
          </div>

          <div
            v-if="expanded === `a-${c.code}`"
            class="evidence"
          >
            <div class="gene-grid">
              <div v-for="f in c.factors" :key="f.key" class="gene-item">
                <div class="gene-head">
                  <span>{{ f.label }}</span>
                  <b>{{ f.value }}</b>
                </div>
                <div class="gene-track">
                  <i :style="{ width: `${Math.max(0, Math.min(100, f.value))}%` }"></i>
                </div>
                <small>{{ f.weight }}% · {{ f.text }}</small>
              </div>
            </div>
            <div v-for="e in c.fit.sampleEvidence" :key="e.dimension" class="ev-row">
              <div class="ev-main">
                <b>{{ e.dimension }}</b>
                <span>{{ e.value }}</span>
                <small>{{ e.bucket }} · {{ e.samples }} 样本 · 延续 {{ e.rate }}%</small>
              </div>
              <em v-if="e.avgGap != null" :class="pctTone(e.avgGap)">
                跳空 {{ fmtPct(e.avgGap) }}
              </em>
            </div>
            <p v-if="!c.fit.sampleEvidence.length" class="dim evidence-empty">
              样本桶不足 3 条，暂不参与画像加权；当前只按基础规则评分。
            </p>
          </div>

          <div class="ac-foot">
            <button class="link-btn" @click="toggleExpand(`a-${c.code}`)">
              评分依据 · {{ expanded === `a-${c.code}` ? '收起' : '展开' }}
            </button>
            <button class="link-btn" @click="editCatalyst(c.sectorKey, c)">核验催化</button>
          </div>

          <div v-if="auctionActive" class="verdict-line" :class="{ 'is-ok': c.actionable }">
            <template v-if="c.actionable">
              {{
                auctionIsIntraday
                  ? '封板确认且催化已核验：只做计划内的板；开板不回封、封单快速变薄立即撤出。'
                  : '催化已核验：仍要等 9:20 后不回落、同板块共振、9:30 有承接，才按计划执行。'
              }}
            </template>
            <template v-else>
              {{
                c.cat.valid
                  ? auctionIsIntraday
                    ? '盘口条件未完全达标：只观察，不追高、不接飞刀。'
                    : '竞价条件未完全达标：只观察，不为了“看起来强”破坏纪律。'
                  : '催化未核验：即使盘口确认，也只按观察处理，不进入执行清单。'
              }}
            </template>
          </div>
        </article>

        <button
          v-if="auctionCards.length > 6"
          class="btn btn--ghost btn--block"
          @click="showAllAuction = !showAllAuction"
        >
          {{ showAllAuction ? '收起候选' : `查看全部 ${auctionCards.length} 只` }}
        </button>

        <section class="panel rule-panel">
          <h4>{{ auctionIsIntraday ? '盘中抓板纪律' : '竞价纪律' }}</h4>
          <template v-if="auctionIsIntraday">
            <div class="rule-line"><span>01</span><p>封板确认只认最新价与买一都贴在涨停价；未封板一律按观察处理，不把“快涨停”当已经涨停。</p></div>
            <div class="rule-line"><span>02</span><p>排序：封板确认 → 近板强度 → 量比 / 成交 → 板块共振 → 弱转强 → 封板质量与历史画像；只列最强 5 只。</p></div>
            <div class="rule-line"><span>03</span><p>只做主线核心，不追没有板块支撑的孤立脉冲；非涨停池成员缺少昨日封板质量，分数自动降级。</p></div>
            <div class="rule-line"><span>04</span><p>炸板不回封、封单快速变薄、跌破分时均线，按失效处理；不补仓、不摊低成本。</p></div>
            <div class="rule-line"><span>05</span><p>板块三关未过或催化未核验，盘中再强也只是观察，不进入执行清单。</p></div>
          </template>
          <template v-else>
            <div class="rule-line"><span>01</span><p>9:15–9:20 可撤单，只看不追；虚假挂单不计入判断。</p></div>
            <div class="rule-line"><span>02</span><p>9:20–9:25 不可撤单，是竞价参考价值最高的 5 分钟。</p></div>
            <div class="rule-line"><span>03</span><p>高开 +2% ~ +8%，竞价额 ≥ 2000 万且 ≥ 昨日成交 2%，才进入强势观察。</p></div>
            <div class="rule-line"><span>04</span><p>高开 > 8% 不追，低开翻绿剔除；9:30 承接失败按失效处理。</p></div>
            <div class="rule-line"><span>05</span><p>板块三关未过或催化未核验，竞价再强也只是观察，不执行。</p></div>
          </template>
        </section>

        <section v-if="auction.notes && auction.notes.length" class="panel note-panel">
          <h4>数据说明</h4>
          <p v-for="line in auction.notes" :key="line">{{ line }}</p>
          <p class="dim">{{ auction.source }}</p>
        </section>
      </template>
    </template>

    <!-- ================= overnight ================= -->
    <template v-else-if="segment === 'overnight'">
      <div v-if="overnightError" class="error-strip">
        <span>隔夜接口异常</span>
        <p>{{ overnightError }}</p>
        <button class="link-btn" @click="loadOvernight()">重试</button>
      </div>

      <div v-if="!overnight && overnightLoading" class="panel panel-pad loading-box">
        <span class="spinner"></span>
        <p>正在核对三关、情绪与画像，生成隔夜条件单…</p>
      </div>

      <template v-if="overnight">
        <section class="mode-card" :class="modeClass(overnight.status)">
          <div class="mode-head">
            <div>
              <span class="eyebrow">隔夜闸门</span>
              <h3>{{ overnight.statusLabel }}</h3>
            </div>
            <span class="chip" :class="overnight.status === 'ready' ? 'chip--gold' : overnight.status === 'empty' || overnight.status === 'defend' ? 'chip--red' : 'chip--warn'">
              {{ overnight.mode.label }}
            </span>
          </div>
          <p class="mode-reason">{{ overnight.reason }}</p>
          <div class="mode-stats">
            <div><b>{{ overnight.dataReady }}</b><small>三关板块</small></div>
            <div><b>{{ overnightRecs.length }}</b><small>严格候选</small></div>
            <div><b class="is-up">{{ overnightExecutable }}</b><small>可挂条件单</small></div>
            <div><b>{{ overnightPrep.length }}</b><small>准备池</small></div>
          </div>
          <div class="mode-foot">
            <p>{{ overnight.mode.note }}</p>
            <button class="link-btn" @click="loadOvernight()">重算</button>
          </div>
        </section>

        <div v-if="overnight.status === 'preview'" class="warn-strip">
          <span class="chip chip--blue">盘中预演</span>
          <p>现在只是预演。收盘前涨停、炸板与资金都会变化，15:00 后重新打开才可作为隔夜计划。</p>
        </div>
        <div v-if="overnight.mode.key === 'locked'" class="warn-strip">
          <span class="chip chip--warn">盘前不追加</span>
          <p>竞价已经开始，隔夜计划应该在前一晚完成。现在只验证，不临时加单。</p>
        </div>
        <div v-if="overnightRumorCount" class="warn-strip">
          <span class="chip chip--red">传闻排除</span>
          <p>{{ overnightRumorCount }} 只属于纯传闻方向，已从隔夜计划剔除。</p>
        </div>
        <div v-if="overnight.profilePending" class="info-strip">
          <span class="chip chip--warn">画像构建中</span>
          <p>老龙头样本还没就绪，本次隔夜分只使用基础规则；画像就绪后重新打开会重新加权。</p>
        </div>

        <div v-if="overnight.profile" class="profile-mini" @click="segment = 'profile'">
          <span class="mini-tag">老龙画像</span>
          <b>{{ overnight.profile.samples }} 样本</b>
          <span>{{ overnight.profile.coverageDays }} 个交易日</span>
          <span>次日延续 {{ overnight.profile.stats.continuedRate }}%</span>
          <i>查看 →</i>
        </div>

        <div v-if="overnightRecs.length">
          <header class="section-head">
            <span class="section-title">隔夜计划候选</span>
            <span class="section-count">{{ overnightRecs.length }} 只 · 按隔夜分</span>
          </header>

          <article
            v-for="c in overnightRecs"
            :key="c.code"
            class="on-card"
            :class="{ 'is-actionable': c.canExecute, 'is-draft': !c.canExecute }"
          >
            <div class="on-head">
              <div class="on-id">
                <div class="on-name">
                  <b>{{ c.name }}</b>
                  <span class="mono">{{ c.code }}</span>
                </div>
                <div class="on-sub">
                  {{ c.sector }} · {{ c.lbc }} 板 · {{ c.boardRule }}
                </div>
              </div>
              <div class="on-ring">
                <ScoreRing :value="c.score" :size="54" :stroke="4" />
                <small>隔夜分</small>
              </div>
            </div>

            <div class="chip-row">
              <span class="chip" :class="statusChipClass(c)">{{ c.displayLabel }}</span>
              <span class="chip" :class="catChipClass(c.cat)">{{ c.cat.label }}</span>
              <span v-for="tag in c.tags" :key="tag" class="tag">{{ tag }}</span>
            </div>

            <div class="price-band">
              <div><small>收盘</small><b class="mono">{{ fmtPrice(c.close) }}</b></div>
              <div><small>涨停价</small><b class="mono is-up">{{ fmtPrice(c.limitUp) }}</b></div>
              <div><small>计划高开</small><b class="mono">+1% ~ +4%</b></div>
              <div><small>画像匹配</small><b>{{ c.fit.score }}</b></div>
            </div>

            <div class="gap-bar">
              <div class="gap-zone gap-zone--abandon">
                <b>-2%</b>
                <small>低开放弃</small>
              </div>
              <div class="gap-zone gap-zone--buy">
                <b>+1% ~ +4%</b>
                <small>执行区间</small>
              </div>
              <div class="gap-zone gap-zone--cancel">
                <b>+6%</b>
                <small>高开放弃</small>
              </div>
            </div>

            <div class="plan-block">
              <h5>触发条件</h5>
              <p v-for="line in c.plan.trigger" :key="line"><span>✓</span>{{ line }}</p>
              <h5>失效条件</h5>
              <p v-for="line in c.plan.invalid" :key="line" class="is-invalid"><span>×</span>{{ line }}</p>
              <div class="plan-stop">
                <b>止损 / 仓位</b>
                <p>{{ c.plan.stop }}</p>
                <p>{{ c.plan.position }}</p>
              </div>
            </div>

            <div v-if="!c.cat.valid" class="cat-warning">
              催化未核验：本条只是计划草稿。请先点「核验催化」，确认政策 / 产业 / 事件证据后再考虑挂单。
            </div>
            <div v-else class="cat-ok">
              催化已核验（{{ c.cat.label }}）。仍需竞价条件与开盘承接同时满足，条件单不是保本工具。
            </div>

            <div class="on-foot">
              <button class="btn btn--sm btn--gold" @click="copyPlan(c)">复制条件单</button>
              <button class="btn btn--sm" @click="editCatalyst(c.sectorKey, c)">核验催化</button>
            </div>

            <details class="on-detail">
              <summary>查看评分与画像依据</summary>
              <p class="dim">
                隔夜分 = 50% 基础分 + 30% 基因分 + 20% 板块热度；准备分 = 30% 基因 + 14% 基础
                + 10% 热度 + 8% 弱转强 + 10% 情绪适配 + 12% 节点 + 10% 连板高度 + 6% 流通市值，再扣核心修正。
                基础 {{ c.baseScore }}，基因 {{ c.geneScore }}，节点 {{ c.nodeLabel }} {{ c.nodeScore }}（情绪
                {{ c.sentimentFit }} / 高度 {{ c.heightFit }} / 市值 {{ c.capFit }}），画像
                {{ c.fit.score }}（静态 {{ c.fit.staticScore }} / 样本
                {{ c.fit.empiricalScore == null ? '--' : c.fit.empiricalScore }}）。
              </p>
              <div v-for="e in c.fit.sampleEvidence" :key="e.dimension" class="ev-row">
                <div class="ev-main">
                  <b>{{ e.dimension }}</b>
                  <span>{{ e.value }}</span>
                  <small>{{ e.bucket }} · {{ e.samples }} 样本 · 延续 {{ e.rate }}%</small>
                </div>
                <em v-if="e.avgGap != null" :class="pctTone(e.avgGap)">
                  跳空 {{ fmtPct(e.avgGap) }}
                </em>
              </div>
              <p v-for="line in c.risks" :key="line" class="risk-line">! {{ line }}</p>
            </details>
          </article>
        </div>

        <div v-else-if="overnight.status !== 'empty'" class="empty-view">
          <div class="glyph">候</div>
          <b>没有通过严格画像的核心</b>
          <p>数据允许制定计划，但个股还没同时满足三关、情绪、画像、连板高度与无炸板门槛。宁缺毋滥；下方准备池只解释“为什么被关注”，不构成挂单依据。</p>
        </div>

        <div v-else class="empty-view">
          <div class="glyph">空</div>
          <b>今天不挂隔夜单</b>
          <p>{{ overnight.reason }}</p>
        </div>

        <section v-if="overnightPrepShown.length" class="section">
          <header class="section-head">
            <span class="section-title">
              {{ overnightRecs.length ? '准备池其余观察' : '准备池 · 2 板以上连板核心' }}
            </span>
            <span class="section-count">按准备分排序 · 只解释不挂单</span>
          </header>
          <p class="section-note">
            准备池 = 基因 30% + 基础 14% + 板块热度 10% + 弱转强 8% + 情绪适配 10%
            + 节点 12% + 连板高度 10% + 流通市值 6%，再扣核心修正：炸板每次 -4、换手 >20% 每点 -0.6、
            容量中军 -4、5 板以上 -6、封单 <1% -6。节点看空间板 / 卡位 / 转势 / 补涨，高度相对市场空间板，
            市值 50–120 亿最适配短线；只收 2 板以上，不足 5 只不硬凑；板块最高板龙头即使被罚分挤出准备池，
            也会留在下方观察并明示原因。
          </p>

          <article
            v-for="(c, idx) in overnightPrepShown"
            :key="c.code"
            class="prep-card"
            :class="{ 'is-ready': c.acceptable }"
          >
            <div class="prep-head">
              <span class="prep-rank">{{ idx + 1 }}</span>
              <div class="prep-id">
                <div class="prep-name">
                  <b>{{ c.name }}</b>
                  <span class="mono">{{ c.code }}</span>
                </div>
                <div class="prep-sub">
                  {{ c.sector }} · {{ c.lbc }} 板 · {{ c.boardRule }}
                  <template v-if="c.weakLabel"> · {{ c.weakLabel }}</template>
                </div>
              </div>
              <div class="prep-score">
                <b>{{ c.prepScore }}</b>
                <small>准备分</small>
              </div>
            </div>

            <div v-if="c.nodeLabel" class="prep-node" :class="`node-tone--${c.nodeTone || 'ok'}`">
              <div class="pn-main">
                <b>{{ c.nodeLabel }}</b>
                <span class="mono">{{ c.nodeScore }}</span>
                <small>{{ (c.nodeWhy && c.nodeWhy[0]) || '节点中性' }}</small>
              </div>
              <div class="pn-fits">
                <span>情绪 {{ c.sentimentFit }}</span>
                <span>高度 {{ c.heightFit }}</span>
                <span>市值 {{ c.capFit }}</span>
              </div>
            </div>

            <div class="chip-row">
              <span class="chip" :class="statusChipClass(c)">{{ c.displayLabel }}</span>
              <span class="chip" :class="catChipClass(c.cat)">{{ c.cat.label }}</span>
              <span v-for="tag in c.tags" :key="tag" class="tag">{{ tag }}</span>
            </div>

            <div class="prep-metrics">
              <div><small>收盘</small><b class="mono">{{ fmtPrice(c.close) }}</b></div>
              <div><small>涨停价</small><b class="mono is-up">{{ fmtPrice(c.limitUp) }}</b></div>
              <div><small>基因分</small><b>{{ c.geneScore }}</b></div>
              <div><small>隔夜分</small><b>{{ c.score }}</b></div>
            </div>

            <div class="prep-lines">
              <p v-for="line in (c.why || []).slice(0, 3)" :key="line"><span>·</span>{{ line }}</p>
            </div>
            <div v-if="c.risks && c.risks.length" class="prep-risks">
              <p v-for="line in c.risks.slice(0, 3)" :key="line">! {{ line }}</p>
            </div>

            <div class="prep-foot">
              <button class="link-btn" @click="editCatalyst(c.sectorKey, c)">
                {{ c.cat.valid ? '催化已核验' : '核验催化' }}
              </button>
              <span class="dim">严格候选需同时满足三关、情绪、画像、2–5 板与无炸板</span>
            </div>
          </article>
        </section>

        <section v-if="overnightWatch.length" class="section">
          <header class="section-head">
            <span class="section-title">其余观察</span>
            <span class="section-count">{{ overnightWatch.length }} 只</span>
          </header>
          <div class="panel watch-panel">
            <div v-for="c in overnightWatch" :key="c.code" class="watch-row">
              <div class="watch-main">
                <b>{{ c.name }}</b>
                <small>{{ c.sector }} · {{ c.lbc }} 板 · {{ c.boardRule }}</small>
                <small v-if="c.nodeLabel" class="watch-node">
                  节点 {{ c.nodeLabel }} {{ c.nodeScore }} · 情绪 {{ c.sentimentFit }} / 高度 {{ c.heightFit }} / 市值 {{ c.capFit }}
                </small>
                <small v-if="c.coreWhy" class="watch-core">{{ c.coreWhy }}</small>
              </div>
              <div class="watch-score">
                <b class="mono">{{ c.prepScore != null ? c.prepScore : c.score }}</b>
                <small>准备分</small>
              </div>
              <span class="chip" :class="statusChipClass(c)">{{ c.displayLabel }}</span>
            </div>
          </div>
        </section>

        <section v-if="overnight.watchSectors && overnight.watchSectors.length" class="section">
          <header class="section-head">
            <span class="section-title">未过三关的板块</span>
            <span class="section-count">按热度</span>
          </header>
          <div class="panel watch-panel">
            <div v-for="s in overnight.watchSectors" :key="s.name" class="watch-row sector-row">
              <div class="watch-main">
                <b>{{ s.name }}</b>
                <small>昨日 {{ s.todayCount }} 家 · 前日 {{ s.prevCount }} 家 · 热度 {{ s.heat }}</small>
              </div>
              <span class="missing-text">{{ (s.missing || []).join(' / ') }}</span>
            </div>
          </div>
        </section>

        <section class="panel rule-panel">
          <h4>隔夜纪律</h4>
          <div v-for="(line, idx) in overnight.rules" :key="line" class="rule-line">
            <span>{{ String(idx + 1).padStart(2, '0') }}</span>
            <p>{{ line }}</p>
          </div>
        </section>

        <section class="panel note-panel">
          <h4>必须知道的风险</h4>
          <p v-for="line in overnight.notes" :key="line">{{ line }}</p>
          <p class="dim">{{ overnight.source }}</p>
        </section>
      </template>
    </template>

    <!-- ================= profile ================= -->
    <template v-else>
      <section class="profile-hero">
        <div class="eyebrow">历史样本 · DRAGON DNA</div>
        <h2>老龙头画像</h2>
        <p>
          统计“板块内 3 板以上领涨股”的次日表现：延续率、隔夜跳空与各维度分层。
          它回答的是“历史上这类票后来怎样”，不是“这只票明天一定涨”。
        </p>
        <div class="hero-actions">
          <button class="btn btn--sm btn--gold" :disabled="profileLoading" @click="rebuildProfile">
            {{ profileLoading ? '构建中…' : '重建样本' }}
          </button>
          <span class="dim" v-if="profile && profile.builtAt">构建于 {{ clockOf(profile.builtAt) }}</span>
        </div>
      </section>

      <div v-if="profileError" class="error-strip">
        <span>画像接口异常</span>
        <p>{{ profileError }}</p>
        <button class="link-btn" @click="loadProfile()">重试</button>
      </div>

      <div v-if="profileBuilding" class="building-strip">
        <span class="spinner"></span>
        <p>正在回溯涨停池、封板质量与次日跳空；首次约需 10–40 秒，完成后会自动刷新。</p>
      </div>

      <template v-if="profileReady">
        <div class="stat-grid">
          <div class="stat-cell">
            <b>{{ profile.coverageDays }}</b>
            <small>样本覆盖交易日</small>
          </div>
          <div class="stat-cell">
            <b>{{ profile.samples }}</b>
            <small>龙头样本条目</small>
          </div>
          <div class="stat-cell">
            <b>{{ profile.sampleStocks }}</b>
            <small>独立个股</small>
          </div>
          <div class="stat-cell">
            <b class="is-up">{{ profileStats.continuedRate }}%</b>
            <small>次日继续涨停</small>
          </div>
          <div class="stat-cell">
            <b>{{ profileStats.gapWinRate }}%</b>
            <small>次日高开比例</small>
          </div>
          <div class="stat-cell">
            <b :class="pctTone(profileStats.avgGap)">{{ fmtPct(profileStats.avgGap) }}</b>
            <small>平均跳空 · 中位 {{ fmtPct(profileStats.medianGap) }}</small>
          </div>
        </div>

        <div class="sample-note">
          <span class="chip chip--dim">{{ profile.fromDate ? fmtStamp(profile.fromDate) : '--' }} → {{ profile.toDate ? fmtStamp(profile.toDate) : '--' }}</span>
          <span>本次回溯 {{ profile.days }} 个交易日，本地累计 {{ profile.carriedSamples }} 条旧样本。</span>
        </div>

        <section class="panel rule-panel">
          <h4>{{ (profile.rules && profile.rules.title) || '高位龙头严格画像' }}</h4>
          <div v-for="r in profileRules" :key="r.key" class="profile-rule">
            <div class="pr-top">
              <b>{{ r.label }}</b>
              <span>{{ r.ideal }}</span>
            </div>
            <small>{{ r.note }}</small>
          </div>
        </section>

        <section class="section">
          <header class="section-head">
            <span class="section-title">维度分层</span>
            <span class="section-count">样本 bar = 次日延续率</span>
          </header>
          <div v-for="g in bucketGroups" :key="g.key" class="panel bucket-panel">
            <header class="bucket-head">
              <div>
                <b>{{ g.title }}</b>
                <small>{{ g.hint }}</small>
              </div>
              <span class="mono">{{ g.totalContinued }}/{{ g.totalSamples }}</span>
            </header>
            <div v-for="b in g.rows" :key="b.key" class="bucket-row" :class="{ 'is-thin': b.samples < 3 }">
              <div class="bucket-name">
                {{ b.label }}
                <small>{{ b.samples }} 样本</small>
              </div>
              <div class="bucket-track">
                <i :style="{ width: barWidth(b.rate) }"></i>
              </div>
              <div class="bucket-rate">
                <b>{{ b.rate == null ? '--' : b.rate + '%' }}</b>
                <small>{{ b.continued }}/{{ b.samples }}</small>
              </div>
            </div>
            <div class="bucket-foot">
              <span v-if="g.rows.some((x) => x.samples < 3)">样本 < 3 的桶只展示，不参与画像加权</span>
              <span>跳空均值：
                <template v-for="b in g.rows" :key="b.key">
                  <em v-if="b.avgGap != null" :class="pctTone(b.avgGap)">{{ b.label }} {{ fmtPct(b.avgGap) }}</em>
                </template>
              </span>
            </div>
          </div>
        </section>

        <section v-if="recentSamples.length" class="section">
          <header class="section-head">
            <span class="section-title">最近样本</span>
            <span class="section-count">样本日 → 次日</span>
          </header>
          <div class="panel recent-panel">
            <div class="recent-head">
              <span>日期</span>
              <span>龙头</span>
              <span>高度</span>
              <span>次日</span>
              <span>跳空</span>
            </div>
            <div v-for="s in recentSamples" :key="`${s.code}-${s.date}`" class="recent-row">
              <span class="mono date">{{ fmtStamp(s.date) }}</span>
              <div class="who">
                <b>{{ s.name }}</b>
                <small>{{ s.sector }}</small>
              </div>
              <span class="chip chip--dim">{{ s.lbc }}板</span>
              <span class="res" :class="s.nextLimitUp ? 'is-up' : 'is-down'">
                {{ s.nextLimitUp ? '继续涨停' : '断板' }}
              </span>
              <span class="mono gap" :class="pctTone(s.gap)">{{ s.gap == null ? '--' : fmtPct(s.gap) }}</span>
            </div>
          </div>
        </section>

        <section class="panel note-panel">
          <h4>样本口径与边界</h4>
          <p v-for="line in (profile.notes || [])" :key="line">{{ line }}</p>
        </section>
      </template>

      <div v-else-if="!profileBuilding && !profileError" class="empty-view">
        <div class="glyph">样</div>
        <b>画像尚未建立</b>
        <p>点击「重建样本」回溯最近交易日；上游涨停池大约只保留 15 个交易日。</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.edge-view {
  gap: 14px;
}

/* ---------- head ---------- */

.edge-head {
  padding: 15px;
  border-radius: 20px;
  border: 1px solid var(--line);
  background:
    radial-gradient(130% 130% at 100% -10%, rgba(243, 199, 119, 0.11), transparent 55%),
    linear-gradient(150deg, rgba(20, 27, 40, 0.95), rgba(9, 12, 19, 0.97));
}

.edge-title-row {
  display: flex;
  align-items: baseline;
  gap: 9px;
  margin-top: 4px;
}

.edge-title-row h2 {
  margin: 0;
  font-size: 22px;
  font-weight: 720;
  letter-spacing: 0.04em;
}

.edge-desc {
  margin: 7px 0 0;
  font-size: 12px;
  line-height: 1.75;
  color: var(--muted);
}

.seg {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 5px;
  margin-top: 12px;
  padding: 4px;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: rgba(0, 0, 0, 0.22);
}

.seg-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  padding: 7px 4px 6px;
  border-radius: 9px;
  border: 1px solid transparent;
  color: var(--muted);
  transition: 0.2s ease;
}

.seg-btn b {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.seg-btn small {
  font-size: 10px;
  letter-spacing: 0.06em;
  color: var(--dim);
}

.seg-btn.is-active {
  border-color: rgba(243, 199, 119, 0.26);
  background: linear-gradient(150deg, rgba(243, 199, 119, 0.16), rgba(243, 199, 119, 0.05));
  color: var(--gold);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

.seg-btn.is-active small {
  color: rgba(243, 199, 119, 0.62);
}

.flow {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 3px;
  margin-top: 11px;
  padding-top: 10px;
  border-top: 1px dashed rgba(255, 255, 255, 0.07);
}

.flow-step {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  text-align: center;
}

.flow-step span {
  width: 17px;
  height: 17px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 1px solid rgba(243, 199, 119, 0.24);
  background: rgba(243, 199, 119, 0.06);
  color: var(--gold);
  font-family: var(--mono);
  font-size: 10px;
}

.flow-step b {
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0.02em;
  color: var(--muted);
  white-space: nowrap;
}

.edge-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 11px;
  font-size: 11.5px;
  color: var(--dim);
}

.edge-meta b {
  color: var(--text-soft);
  font-weight: 600;
}

.meta-sep {
  width: 1px;
  height: 9px;
  background: var(--line-strong);
}

.gate-line {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  margin-top: 9px;
  padding: 8px 9px;
  border-radius: 9px;
  border: 1px dashed rgba(243, 199, 119, 0.2);
  background: rgba(243, 199, 119, 0.045);
  font-size: 11.5px;
  line-height: 1.6;
  color: #d6bd92;
}

.gate-line.is-empty {
  border-color: rgba(255, 84, 96, 0.24);
  background: rgba(255, 84, 96, 0.05);
  color: #d99ea2;
}

.gate-line .chip {
  flex: 0 0 auto;
  margin-top: 1px;
}

/* ---------- stage ---------- */

.stage-card {
  position: relative;
  overflow: hidden;
  padding: 14px;
  border-radius: 18px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: linear-gradient(155deg, rgba(19, 26, 39, 0.94), rgba(9, 12, 19, 0.96));
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.24);
}

.stage-card::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(120% 100% at 100% 0%, rgba(255, 84, 96, 0.08), transparent 55%);
}

.stage--trial {
  border-color: rgba(255, 180, 94, 0.26);
}

.stage--locked,
.stage--final {
  border-color: rgba(255, 84, 96, 0.3);
}

.stage--preopen,
.stage--off {
  border-color: rgba(243, 199, 119, 0.18);
}

.stage-head {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 14.5px;
}

.stage-head b {
  font-size: 16px;
  font-weight: 650;
  letter-spacing: 0.04em;
}

.stage-clock {
  margin-left: auto;
  font-size: 12px;
  color: var(--muted);
}

.stage-note {
  position: relative;
  z-index: 1;
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--muted);
}

.timeline {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 2px;
  margin-top: 13px;
}

.tl-step {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding-top: 9px;
  color: var(--dim);
}

.tl-step::before {
  content: "";
  position: absolute;
  top: 3px;
  left: 0;
  right: 0;
  height: 1px;
  background: rgba(255, 255, 255, 0.07);
}

.tl-dot {
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 7px;
  height: 7px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: var(--panel-solid);
  z-index: 1;
}

.tl-step b {
  font-size: 11.5px;
  font-weight: 500;
}

.tl-step small {
  font-size: 10.5px;
  letter-spacing: 0.06em;
}

.tl-step.is-past {
  color: var(--muted);
}

.tl-step.is-past .tl-dot {
  border-color: rgba(243, 199, 119, 0.4);
  background: rgba(243, 199, 119, 0.5);
}

.tl-step.is-on {
  color: var(--gold);
}

.tl-step.is-on .tl-dot {
  border-color: var(--gold);
  background: var(--gold);
  box-shadow: 0 0 10px rgba(243, 199, 119, 0.65);
}

.tl-step.is-on::before {
  background: linear-gradient(90deg, rgba(243, 199, 119, 0.35), rgba(243, 199, 119, 0.08));
}

.stage-foot {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 10px;
  padding-top: 9px;
  border-top: 1px dashed rgba(255, 255, 255, 0.07);
  font-size: 11px;
  color: var(--dim);
}

.stage-foot span:first-child {
  color: rgba(243, 199, 119, 0.8);
}

/* ---------- shared strips / stats ---------- */

.mini-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1px;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--line);
  background: var(--line);
}

.mini-stat {
  padding: 9px 6px 8px;
  text-align: center;
  background: rgba(9, 13, 20, 0.9);
}

.mini-stat b {
  display: block;
  font-family: var(--mono);
  font-size: 16.5px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--text-soft);
}

.mini-stat small {
  display: block;
  margin-top: 2px;
  font-size: 10.5px;
  letter-spacing: 0.03em;
  color: var(--dim);
}

.node-strip {
  padding: 10px 12px;
  border: 1px solid rgba(243, 199, 119, 0.22);
  border-radius: 12px;
  background: linear-gradient(135deg, rgba(243, 199, 119, 0.08), rgba(9, 13, 20, 0.4));
}

.ns-top {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.node-strip p {
  margin: 7px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-soft);
}

.node-strip small {
  display: block;
  margin-top: 3px;
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--dim);
}

.warn-strip,
.info-strip,
.error-strip,
.building-strip {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 10px;
  border-radius: 10px;
  font-size: 11.5px;
  line-height: 1.65;
}

.warn-strip {
  border: 1px solid rgba(255, 180, 94, 0.24);
  background: rgba(255, 180, 94, 0.055);
  color: #d9b98e;
}

.info-strip {
  border: 1px solid rgba(102, 169, 255, 0.22);
  background: rgba(102, 169, 255, 0.05);
  color: #a9c2e2;
}

.error-strip {
  border: 1px solid rgba(255, 84, 96, 0.3);
  background: rgba(255, 84, 96, 0.06);
  color: #e3a3a8;
  flex-wrap: wrap;
}

.building-strip {
  border: 1px solid rgba(243, 199, 119, 0.24);
  background: rgba(243, 199, 119, 0.06);
  color: #d9c294;
}

.warn-strip .chip,
.info-strip .chip,
.building-strip .chip {
  flex: 0 0 auto;
  margin-top: 1px;
}

.warn-strip p,
.info-strip p,
.error-strip p,
.building-strip p {
  margin: 0;
  flex: 1;
  min-width: 0;
}

.error-strip > span {
  font-weight: 600;
}

.loading-box {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--muted);
}

.loading-box p {
  margin: 0;
}

.spinner {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  border-radius: 50%;
  border: 2px solid rgba(243, 199, 119, 0.2);
  border-top-color: var(--gold);
  animation: edgeSpin 0.8s linear infinite;
}

@keyframes edgeSpin {
  to {
    transform: rotate(360deg);
  }
}

/* ---------- auction cards ---------- */

.ac-card {
  position: relative;
  overflow: hidden;
  padding: 13px;
  border-radius: 16px;
  border: 1px solid var(--line);
  background: linear-gradient(158deg, rgba(19, 26, 39, 0.94), rgba(9, 13, 20, 0.95));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04), 0 10px 24px rgba(0, 0, 0, 0.2);
}

.ac-card.is-actionable {
  border-color: rgba(243, 199, 119, 0.36);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 0 28px rgba(243, 199, 119, 0.07);
}

.ac-card.is-alert-flash {
  border-color: rgba(255, 84, 96, 0.7);
  animation: alertFlash 1.2s ease 2;
}

@keyframes alertFlash {
  0%,
  100% {
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04), 0 0 0 rgba(255, 84, 96, 0);
  }
  50% {
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 0 32px rgba(255, 84, 96, 0.38);
  }
}

.ac-card.is-preview {
  background: linear-gradient(158deg, rgba(17, 23, 35, 0.9), rgba(9, 12, 19, 0.95));
}

.ac-top {
  display: flex;
  align-items: flex-start;
  gap: 9px;
}

.ac-rank {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  margin-top: 2px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.03);
  font-family: var(--mono);
  font-size: 11px;
  color: var(--dim);
}

.ac-id {
  min-width: 0;
  flex: 1;
}

.ac-name {
  display: flex;
  align-items: baseline;
  gap: 7px;
}

.ac-name b {
  font-size: 16.5px;
  font-weight: 650;
  letter-spacing: 0.02em;
}

.ac-name span {
  font-size: 11px;
  color: var(--dim);
  letter-spacing: 0.06em;
}

.ac-sub {
  margin-top: 2px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--muted);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.ac-sub i {
  font-style: normal;
  color: rgba(255, 255, 255, 0.26);
}

.ac-ring {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
}

.ac-ring small {
  font-size: 9.5px;
  letter-spacing: 0.08em;
  color: var(--dim);
}

.ac-card .chip-row {
  margin-top: 9px;
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1px;
  margin-top: 10px;
  border-radius: 9px;
  overflow: hidden;
  border: 1px solid var(--line);
  background: var(--line);
}

.metric {
  min-width: 0;
  padding: 7px 6px 6px;
  background: rgba(8, 12, 19, 0.86);
}

.metric small {
  display: block;
  font-size: 10px;
  letter-spacing: 0.03em;
  color: var(--dim);
}

.metric b {
  display: block;
  margin-top: 1px;
  font-family: var(--mono);
  font-size: 13.5px;
  font-weight: 600;
  line-height: 1.25;
  color: var(--text-soft);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.metric > span {
  display: block;
  margin-top: 1px;
  font-size: 9.5px;
  color: var(--dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ac-lines {
  margin-top: 9px;
}

.ac-lines p {
  display: flex;
  gap: 5px;
  margin: 0 0 3px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-soft);
}

.ac-lines p span {
  color: rgba(243, 199, 119, 0.6);
}

.ac-risks {
  margin-top: 7px;
  padding: 7px 8px;
  border-radius: 8px;
  border: 1px solid rgba(255, 84, 96, 0.16);
  background: rgba(255, 84, 96, 0.045);
}

.ac-risks.is-soft {
  border-color: rgba(255, 180, 94, 0.15);
  background: rgba(255, 180, 94, 0.04);
}

.ac-risks p {
  margin: 0 0 2px;
  font-size: 11px;
  line-height: 1.55;
  color: #d7a3a7;
}

.ac-risks.is-soft p {
  color: #d2b28d;
}

.prep-box {
  margin-top: 9px;
  padding: 8px 9px;
  border-radius: 9px;
  border: 1px dashed rgba(243, 199, 119, 0.2);
  background: rgba(243, 199, 119, 0.04);
}

.prep-box b {
  display: block;
  margin-bottom: 4px;
  font-size: 11px;
  letter-spacing: 0.06em;
  color: var(--gold);
}

.prep-box p {
  margin: 0 0 2px;
  font-size: 11px;
  line-height: 1.55;
  color: #c9b48e;
}

.gene-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 9px;
}

.gene-item {
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.045);
  background: rgba(255, 255, 255, 0.018);
}

.gene-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
  font-size: 10.5px;
  color: var(--muted);
}

.gene-head b {
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--gold);
}

.gene-track {
  height: 4px;
  margin-top: 4px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.05);
  overflow: hidden;
}

.gene-track i {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: linear-gradient(90deg, rgba(243, 199, 119, 0.55), var(--gold));
}

.gene-item small {
  display: block;
  margin-top: 3px;
  font-size: 9.5px;
  line-height: 1.5;
  color: var(--dim);
}

.evidence {
  margin-top: 9px;
  padding-top: 8px;
  border-top: 1px dashed rgba(255, 255, 255, 0.07);
}

.ev-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.ev-row:last-child {
  border-bottom: 0;
}

.ev-main {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 5px;
}

.ev-main b {
  font-size: 11px;
  color: var(--text-soft);
}

.ev-main span {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--gold);
}

.ev-main small {
  width: 100%;
  font-size: 10px;
  color: var(--dim);
}

.ev-row em {
  flex: 0 0 auto;
  font-style: normal;
  font-family: var(--mono);
  font-size: 10.5px;
}

.evidence-empty {
  margin: 4px 0 0;
  font-size: 10.5px;
  line-height: 1.6;
}

.ac-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 9px;
}

.link-btn {
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--gold);
  border-bottom: 1px dashed rgba(243, 199, 119, 0.28);
  padding-bottom: 1px;
}

.link-btn:hover {
  color: #ffe2a9;
}

.verdict-line {
  margin-top: 8px;
  padding: 7px 8px;
  border-radius: 8px;
  border: 1px solid rgba(255, 180, 94, 0.16);
  background: rgba(255, 180, 94, 0.045);
  font-size: 11px;
  line-height: 1.6;
  color: #d4b28c;
}

.verdict-line.is-ok {
  border-color: rgba(243, 199, 119, 0.24);
  background: rgba(243, 199, 119, 0.05);
  color: #dcc49b;
}

/* ---------- overnight ---------- */

.mode-card {
  padding: 15px;
  border-radius: 18px;
  border: 1px solid var(--line);
  background: linear-gradient(155deg, rgba(20, 27, 40, 0.95), rgba(9, 12, 19, 0.96));
}

.mode-card.mode--cold {
  border-color: rgba(255, 84, 96, 0.28);
  background:
    radial-gradient(120% 120% at 100% 0%, rgba(255, 84, 96, 0.12), transparent 55%),
    linear-gradient(155deg, rgba(28, 19, 24, 0.95), rgba(9, 12, 19, 0.96));
}

.mode-card.mode--warn {
  border-color: rgba(255, 180, 94, 0.26);
  background:
    radial-gradient(120% 120% at 100% 0%, rgba(255, 180, 94, 0.1), transparent 55%),
    linear-gradient(155deg, rgba(26, 23, 17, 0.95), rgba(9, 12, 19, 0.96));
}

.mode-card.mode--preview {
  border-color: rgba(102, 169, 255, 0.24);
}

.mode-card.mode--ready {
  border-color: rgba(243, 199, 119, 0.32);
  background:
    radial-gradient(120% 120% at 100% 0%, rgba(243, 199, 119, 0.13), transparent 55%),
    linear-gradient(155deg, rgba(28, 25, 18, 0.95), rgba(9, 12, 19, 0.96));
}

.mode-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.mode-head h3 {
  margin: 3px 0 0;
  font-size: 20px;
  font-weight: 720;
  letter-spacing: 0.03em;
}

.mode-head .chip {
  margin-left: auto;
  flex: 0 0 auto;
  margin-top: 2px;
}

.mode-reason {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--muted);
}

.mode-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1px;
  margin-top: 11px;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid var(--line);
  background: var(--line);
}

.mode-stats > div {
  padding: 7px 5px;
  text-align: center;
  background: rgba(8, 12, 19, 0.85);
}

.mode-stats b {
  display: block;
  font-family: var(--mono);
  font-size: 15.5px;
  font-weight: 600;
  color: var(--text-soft);
}

.mode-stats small {
  display: block;
  margin-top: 1px;
  font-size: 10px;
  color: var(--dim);
}

.mode-foot {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 9px;
  padding-top: 8px;
  border-top: 1px dashed rgba(255, 255, 255, 0.07);
}

.mode-foot p {
  margin: 0;
  flex: 1;
  font-size: 11px;
  line-height: 1.6;
  color: var(--dim);
}

.profile-mini {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 9px 10px;
  border-radius: 10px;
  border: 1px solid rgba(243, 199, 119, 0.16);
  background: rgba(243, 199, 119, 0.04);
  font-size: 11px;
  color: var(--muted);
  cursor: pointer;
}

.profile-mini .mini-tag {
  padding: 1px 5px;
  border-radius: 4px;
  border: 1px solid var(--gold-line);
  color: var(--gold);
  font-size: 10px;
  letter-spacing: 0.08em;
}

.profile-mini b {
  font-family: var(--mono);
  color: var(--text-soft);
  font-weight: 600;
}

.profile-mini i {
  margin-left: auto;
  font-style: normal;
  color: var(--gold);
}

.on-card {
  position: relative;
  overflow: hidden;
  margin-top: 9px;
  padding: 13px;
  border-radius: 16px;
  border: 1px solid var(--line);
  background: linear-gradient(158deg, rgba(19, 26, 39, 0.94), rgba(9, 13, 20, 0.96));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04), 0 10px 24px rgba(0, 0, 0, 0.2);
}

.on-card.is-actionable {
  border-color: rgba(243, 199, 119, 0.38);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 0 30px rgba(243, 199, 119, 0.08);
}

.on-card.is-draft {
  border-color: rgba(255, 255, 255, 0.08);
}

.on-head {
  display: flex;
  align-items: flex-start;
  gap: 9px;
}

.on-id {
  min-width: 0;
  flex: 1;
}

.on-name {
  display: flex;
  align-items: baseline;
  gap: 7px;
}

.on-name b {
  font-size: 17px;
  font-weight: 650;
}

.on-name span {
  font-size: 11px;
  color: var(--dim);
  letter-spacing: 0.05em;
}

.on-sub {
  margin-top: 2px;
  font-size: 11px;
  color: var(--muted);
}

.on-ring {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
}

.on-ring small {
  font-size: 9.5px;
  color: var(--dim);
  letter-spacing: 0.07em;
}

.on-card .chip-row {
  margin-top: 9px;
}

.price-band {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1px;
  margin-top: 10px;
  border-radius: 9px;
  overflow: hidden;
  border: 1px solid var(--line);
  background: var(--line);
}

.price-band > div {
  padding: 7px 6px;
  background: rgba(8, 12, 19, 0.86);
}

.price-band small {
  display: block;
  font-size: 10px;
  color: var(--dim);
}

.price-band b {
  display: block;
  margin-top: 1px;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-soft);
  white-space: nowrap;
}

.gap-bar {
  display: grid;
  grid-template-columns: 0.9fr 1.5fr 0.9fr;
  gap: 4px;
  margin-top: 9px;
}

.gap-zone {
  padding: 6px 5px;
  border-radius: 7px;
  text-align: center;
  border: 1px solid var(--line);
}

.gap-zone b {
  display: block;
  font-family: var(--mono);
  font-size: 11.5px;
  font-weight: 600;
}

.gap-zone small {
  display: block;
  font-size: 9.5px;
  color: var(--dim);
}

.gap-zone--abandon {
  background: rgba(43, 211, 154, 0.05);
  border-color: rgba(43, 211, 154, 0.16);
  color: #7ad8b4;
}

.gap-zone--buy {
  background: rgba(243, 199, 119, 0.1);
  border-color: rgba(243, 199, 119, 0.28);
  color: var(--gold);
}

.gap-zone--cancel {
  background: rgba(255, 84, 96, 0.05);
  border-color: rgba(255, 84, 96, 0.16);
  color: #e59aa0;
}

.plan-block {
  margin-top: 10px;
}

.plan-block h5 {
  margin: 9px 0 4px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--gold);
}

.plan-block p {
  display: flex;
  gap: 5px;
  margin: 0 0 3px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-soft);
}

.plan-block p span {
  color: var(--down);
}

.plan-block p.is-invalid span {
  color: var(--up);
}

.plan-stop {
  margin-top: 8px;
  padding: 7px 8px;
  border-radius: 8px;
  border: 1px dashed rgba(255, 84, 96, 0.18);
  background: rgba(255, 84, 96, 0.035);
}

.plan-stop b {
  display: block;
  margin-bottom: 3px;
  font-size: 10.5px;
  letter-spacing: 0.06em;
  color: #d99aa0;
}

.plan-stop p {
  margin: 0 0 2px;
  color: #c9a3a6;
}

.cat-warning,
.cat-ok {
  margin-top: 9px;
  padding: 7px 8px;
  border-radius: 8px;
  font-size: 11px;
  line-height: 1.6;
}

.cat-warning {
  border: 1px solid rgba(255, 180, 94, 0.26);
  background: rgba(255, 180, 94, 0.06);
  color: #d8b78c;
}

.cat-ok {
  border: 1px solid rgba(243, 199, 119, 0.22);
  background: rgba(243, 199, 119, 0.045);
  color: #d7c099;
}

.on-foot {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 10px;
}

.on-foot .btn {
  flex: 0 0 auto;
}

.on-detail {
  margin-top: 9px;
  padding-top: 8px;
  border-top: 1px dashed rgba(255, 255, 255, 0.07);
}

.on-detail summary {
  font-size: 11px;
  color: var(--muted);
  cursor: pointer;
  outline: none;
}

.on-detail p {
  margin: 6px 0 0;
  font-size: 11px;
  line-height: 1.65;
}

.risk-line {
  color: #c9a3a6;
}

.watch-panel {
  padding: 4px 11px;
}

.watch-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.watch-row:last-child {
  border-bottom: 0;
}

.watch-main {
  min-width: 0;
  flex: 1;
}

.watch-main b {
  display: block;
  font-size: 12.5px;
  font-weight: 600;
}

.watch-main small {
  display: block;
  margin-top: 1px;
  font-size: 10.5px;
  color: var(--dim);
}

.watch-main small.watch-core {
  color: var(--gold);
  line-height: 1.55;
}

.watch-main small.watch-node {
  color: #b9a06e;
  font-size: 10px;
  line-height: 1.5;
}

.watch-score {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  text-align: right;
}

.watch-score b {
  display: block;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-soft);
}

.watch-score small {
  display: block;
  font-size: 9.5px;
  color: var(--dim);
}

.sector-row {
  align-items: flex-start;
}

.missing-text {
  flex: 0 0 46%;
  text-align: right;
  font-size: 10px;
  line-height: 1.5;
  color: #b58e91;
}

.prep-card {
  margin-bottom: 10px;
  padding: 11px 12px 10px;
  border-radius: 12px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.018);
}

.prep-card.is-ready {
  border-color: rgba(243, 199, 119, 0.3);
  background: rgba(243, 199, 119, 0.035);
}

.prep-head {
  display: flex;
  align-items: flex-start;
  gap: 9px;
}

.prep-rank {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.03);
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
}

.prep-id {
  min-width: 0;
  flex: 1;
}

.prep-name {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px;
}

.prep-name b {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.03em;
}

.prep-name .mono {
  font-size: 10.5px;
  color: var(--dim);
}

.prep-sub {
  margin-top: 2px;
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--dim);
}

.prep-score {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  font-family: var(--mono);
}

.prep-score b {
  font-size: 19px;
  font-weight: 600;
  line-height: 1.1;
  color: var(--gold);
}

.prep-score small {
  font-size: 9.5px;
  color: var(--dim);
}

.prep-node {
  margin-top: 7px;
  padding: 7px 9px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.025);
}

.prep-node.node-tone--hot {
  border-color: rgba(255, 84, 96, 0.26);
  background: rgba(255, 84, 96, 0.06);
}

.prep-node.node-tone--risk {
  border-color: rgba(255, 180, 94, 0.3);
  background: rgba(255, 180, 94, 0.06);
}

.prep-node.node-tone--dim {
  opacity: 0.86;
}

.pn-main {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
}

.pn-main b {
  font-size: 12.5px;
  color: var(--gold);
}

.prep-node.node-tone--hot .pn-main b {
  color: #ff8a92;
}

.prep-node.node-tone--risk .pn-main b {
  color: var(--warn);
}

.pn-main .mono {
  font-size: 13px;
  font-weight: 600;
}

.pn-main small {
  flex: 1 1 100%;
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--muted);
}

.pn-fits {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 4px;
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--dim);
}

.prep-metrics {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 5px;
  margin-top: 8px;
  padding: 7px 0;
  border-top: 1px dashed rgba(255, 255, 255, 0.06);
  border-bottom: 1px dashed rgba(255, 255, 255, 0.06);
}

.prep-metrics div {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.prep-metrics small {
  font-size: 9.5px;
  color: var(--dim);
}

.prep-metrics b {
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.prep-lines {
  margin-top: 7px;
}

.prep-lines p {
  display: flex;
  gap: 5px;
  margin: 0 0 3px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-soft);
}

.prep-lines p span {
  color: rgba(243, 199, 119, 0.6);
}

.prep-risks {
  margin-top: 6px;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid rgba(255, 84, 96, 0.14);
  background: rgba(255, 84, 96, 0.04);
}

.prep-risks p {
  margin: 0 0 2px;
  font-size: 10.5px;
  line-height: 1.55;
  color: #d7a3a7;
}

.prep-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
}

.prep-foot .dim {
  font-size: 9.5px;
  line-height: 1.5;
  text-align: right;
}

.rule-panel,
.note-panel {
  padding: 13px;
}

.rule-panel h4,
.note-panel h4 {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--gold);
}

.rule-line {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 5px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.rule-line:last-child {
  border-bottom: 0;
}

.rule-line > span {
  flex: 0 0 auto;
  width: 20px;
  padding-top: 1px;
  font-family: var(--mono);
  font-size: 10px;
  color: rgba(243, 199, 119, 0.65);
}

.rule-line p {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.65;
  color: var(--muted);
}

.note-panel p {
  margin: 0 0 5px;
  font-size: 11px;
  line-height: 1.7;
  color: var(--muted);
}

.note-panel p:last-child {
  margin-bottom: 0;
}

/* ---------- profile ---------- */

.profile-hero {
  padding: 15px;
  border-radius: 18px;
  border: 1px solid var(--line);
  background:
    radial-gradient(130% 130% at 100% -10%, rgba(243, 199, 119, 0.12), transparent 55%),
    linear-gradient(150deg, rgba(20, 27, 40, 0.95), rgba(9, 12, 19, 0.97));
}

.profile-hero h2 {
  margin: 3px 0 0;
  font-size: 22px;
  font-weight: 720;
  letter-spacing: 0.04em;
}

.profile-hero p {
  margin: 7px 0 0;
  font-size: 12px;
  line-height: 1.75;
  color: var(--muted);
}

.hero-actions {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-top: 10px;
}

.hero-actions .dim {
  font-size: 10.5px;
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1px;
  border-radius: 13px;
  overflow: hidden;
  border: 1px solid var(--line);
  background: var(--line);
}

.stat-cell {
  padding: 10px 7px;
  text-align: center;
  background: rgba(9, 13, 20, 0.9);
}

.stat-cell b {
  display: block;
  font-family: var(--mono);
  font-size: 17px;
  font-weight: 650;
  line-height: 1.2;
  color: var(--text-soft);
}

.stat-cell small {
  display: block;
  margin-top: 2px;
  font-size: 10px;
  line-height: 1.4;
  color: var(--dim);
}

.sample-note {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
  font-size: 10.5px;
  color: var(--dim);
}

.profile-rule {
  padding: 6px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.profile-rule:last-child {
  border-bottom: 0;
}

.pr-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.pr-top b {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-soft);
}

.pr-top span {
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--gold);
}

.profile-rule small {
  display: block;
  margin-top: 1px;
  font-size: 10.5px;
  color: var(--dim);
}

.bucket-panel {
  padding: 12px;
  margin-top: 8px;
}

.bucket-head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 8px;
}

.bucket-head > div {
  flex: 1;
}

.bucket-head b {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-soft);
}

.bucket-head small {
  display: block;
  margin-top: 1px;
  font-size: 10.5px;
  color: var(--dim);
}

.bucket-head > span {
  font-size: 11px;
  color: var(--gold);
}

.bucket-row {
  display: grid;
  grid-template-columns: 82px 1fr 50px;
  align-items: center;
  gap: 7px;
  padding: 4px 0;
}

.bucket-name {
  font-size: 10.5px;
  color: var(--muted);
  line-height: 1.3;
}

.bucket-name small {
  display: block;
  font-size: 9.5px;
  color: var(--dim);
}

.bucket-track {
  height: 5px;
  border-radius: 99px;
  background: rgba(255, 255, 255, 0.055);
  overflow: hidden;
}

.bucket-track i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, rgba(243, 199, 119, 0.35), var(--gold));
  transition: width 0.45s ease;
}

.bucket-row.is-thin .bucket-track i {
  background: linear-gradient(90deg, rgba(139, 150, 169, 0.28), rgba(139, 150, 169, 0.55));
}

.bucket-rate {
  text-align: right;
}

.bucket-rate b {
  display: block;
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-soft);
}

.bucket-rate small {
  display: block;
  font-size: 9px;
  color: var(--dim);
}

.bucket-foot {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 4px 9px;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed rgba(255, 255, 255, 0.05);
  font-size: 9.5px;
  line-height: 1.6;
  color: var(--dim);
}

.bucket-foot em {
  font-style: normal;
  font-family: var(--mono);
  margin-left: 4px;
}

.recent-panel {
  padding: 5px 10px;
}

.recent-head,
.recent-row {
  display: grid;
  grid-template-columns: 38px 1fr auto 60px 52px;
  align-items: center;
  gap: 6px;
}

.recent-head {
  padding: 7px 0 5px;
  font-size: 9.5px;
  letter-spacing: 0.05em;
  color: var(--dim);
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.recent-head span:nth-child(3),
.recent-head span:nth-child(4) {
  text-align: right;
}

.recent-row {
  padding: 7px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.recent-row:last-child {
  border-bottom: 0;
}

.recent-row .date {
  font-size: 10px;
  color: var(--dim);
}

.recent-row .who {
  min-width: 0;
}

.recent-row .who b {
  display: block;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.recent-row .who small {
  display: block;
  font-size: 9.5px;
  color: var(--dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.recent-row .chip {
  justify-self: end;
}

.recent-row .res {
  font-size: 10px;
  text-align: right;
  white-space: nowrap;
}

.recent-row .gap {
  font-size: 10.5px;
  text-align: right;
}

@media (max-width: 385px) {
  .edge-head {
    padding: 13px;
  }

  .edge-title-row h2 {
    font-size: 20px;
  }

  .metric-grid,
  .price-band {
    grid-template-columns: repeat(2, 1fr);
  }

  .bucket-row {
    grid-template-columns: 72px 1fr 46px;
  }

  .recent-head,
  .recent-row {
    grid-template-columns: 34px 1fr auto 56px 48px;
    gap: 4px;
  }

  .ac-card,
  .on-card {
    padding: 11px;
  }
}
</style>