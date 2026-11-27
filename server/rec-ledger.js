'use strict'

/*
 * 推荐跟踪台账
 * - 复盘来源：明日连板晋级榜 + 明日打板待选（可执行清单）
 * - 隔夜来源：盘后定稿的隔夜三强（严格推荐）+ 准备池 / 观察池（对照，不是推荐）
 * - 同日同票合并，保留来源与最好名次；一字 / 秒板不进入待选，来源里也不会出现
 * - 次日用腾讯日线做结果核对：竞价缺口、开盘→收盘、是否晋级、是否触板
 * - 台账只描述事实，不倒推模型、不补造缺失样本
 */

const fs = require('fs')
const path = require('path')

const { beijingNow, dateStamp, marketStatus, round, num } = require('./util')
const { tencentKline } = require('./eastmoney')
const { limitRatioFor } = require('./gene')

const LEDGER_FILE =
  process.env.REC_LEDGER_FILE || path.join(__dirname, '..', '.cache', 'rec-ledger.json')
const MAX_DAYS = 40
const KLINE_LIMIT = 40
const FETCH_CONCURRENCY = 4
const MIN_BUCKET = 5

let ledgerMemory = null
let lastSignature = ''
let auditCache = null
let auditCacheAt = 0
let auditCacheDays = 0
const AUDIT_TTL = 1000 * 60 * 5

const ACTIONABLE_CAN_ACT = new Set(['conditional', 'small'])

const OVERNIGHT_COHORTS = [
  { key: 'strict', field: 'items', label: '严格三强', actionable: true },
  { key: 'standby', field: 'standby', label: '候选未执行', actionable: false },
  { key: 'prep', field: 'prep', label: '准备池', actionable: false },
  { key: 'watch', field: 'watch', label: '观察池', actionable: false }
]

const GAP_LABELS = {
  lowOpen: '低开 <-2%',
  flatOpen: '平开 -2~1%',
  trigger: '触发 1–4%',
  highChase: '高开 4–6%',
  abandonGap: '放弃 >6%',
  unknown: '待核对'
}

function emptyStore() {
  return { version: 1, updatedAt: null, days: {} }
}

function loadStore() {
  if (ledgerMemory) return ledgerMemory
  try {
    const raw = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'))
    if (raw && raw.days && typeof raw.days === 'object') {
      ledgerMemory = {
        version: raw.version || 1,
        updatedAt: raw.updatedAt || null,
        days: raw.days
      }
      return ledgerMemory
    }
  } catch (err) {
    /* 首次运行或文件损坏：从空台账开始，不猜测历史 */
  }
  ledgerMemory = emptyStore()
  return ledgerMemory
}

function saveStore(store) {
  try {
    fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true })
    const tmp = `${LEDGER_FILE}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(store), 'utf8')
    fs.renameSync(tmp, LEDGER_FILE)
  } catch (err) {
    /* 台账写入是尽力而为，失败不能影响行情主流程 */
  }
}

function secidOf(code) {
  return `${/^6/.test(String(code || '')) ? 1 : 0}.${code}`
}

function itemFromPlan(item, source, rank) {
  const code = String((item && item.code) || '')
  if (!/^\d{6}$/.test(code)) return null
  return {
    code,
    name: String((item && item.name) || ''),
    sector: (item && item.sector) || null,
    lbc: num(item && item.lbc, 0),
    close: num(item && item.close, null),
    promoProb: num(item && item.promoProb, null),
    hotScore: num(item && item.score, null),
    tradableBoard: !(item && item.tradableBoard === false),
    sources: [source],
    sourceRanks: { [source]: rank }
  }
}

function mergeItem(map, item, source, rank) {
  const next = itemFromPlan(item, source, rank)
  if (!next) return
  const existed = map.get(next.code)
  if (!existed) {
    map.set(next.code, next)
    return
  }
  if (!existed.sources.includes(source)) existed.sources.push(source)
  existed.sourceRanks[source] = Math.min(
    num(existed.sourceRanks[source], rank),
    rank
  )
  existed.lbc = Math.max(num(existed.lbc, 0), next.lbc)
  existed.close = existed.close == null ? next.close : existed.close
  existed.promoProb =
    existed.promoProb == null
      ? next.promoProb
      : next.promoProb == null
        ? existed.promoProb
        : Math.max(existed.promoProb, next.promoProb)
  existed.hotScore =
    existed.hotScore == null
      ? next.hotScore
      : next.hotScore == null
        ? existed.hotScore
        : Math.max(existed.hotScore, next.hotScore)
  existed.tradableBoard = existed.tradableBoard && next.tradableBoard
}

/* ------------------------------------------------------------------ *
 * 隔夜台账：严格三强 + 准备池 / 观察池对照
 * 只在盘后定稿（mode=final）记录，盘中预演不写入，避免计划还没定就留下样本
 * ------------------------------------------------------------------ */

function normalizeOvernightItem(item, cohort, rank) {
  const code = String((item && item.code) || '')
  if (!/^\d{6}$/.test(code)) return null
  return {
    code,
    name: String((item && item.name) || ''),
    sector: (item && item.sector) || null,
    cohort,
    rank,
    lbc: num(item && item.lbc, 0),
    close: num(item && item.close, null),
    score: num(item && item.score, null),
    prepScore: num(item && item.prepScore, null),
    geneScore: num(item && item.geneScore, null),
    nodeScore: num(item && item.nodeScore, null),
    sectorHeat: num(item && item.sectorHeat, null),
    tradableBoard: !(item && item.tradableBoard === false),
    tags: Array.isArray(item && item.tags) ? item.tags.slice(0, 4) : []
  }
}

function buildOvernightRecord(dashboard) {
  const brief = dashboard && dashboard.overnightBrief
  if (!brief || !brief.mode || brief.mode.key !== 'final') return null
  const date = String(dashboard.tradeDate || '')
  const today = dateStamp(beijingNow())
  const marketKey = dashboard.market && dashboard.market.key
  if (!(date < today || marketKey === 'closed')) return null

  /* 只有 status=ready（三关 + 情绪修复/主升）才算严格推荐；
   * 降频观察 / 等情绪确认时页面仍会展示候选，但台账只记为“候选未执行”，不计入推荐胜率 */
  const executable = brief.status === 'ready'
  const candidates = []
  const seen = new Set()
  ;(brief.recommendations || []).forEach((item, i) => {
    const next = normalizeOvernightItem(item, executable ? 'strict' : 'standby', i + 1)
    if (!next || seen.has(next.code)) return
    seen.add(next.code)
    candidates.push(next)
  })
  const prep = []
  ;(brief.preparation || []).forEach((item, i) => {
    const next = normalizeOvernightItem(item, 'prep', i + 1)
    if (!next || seen.has(next.code)) return
    seen.add(next.code)
    prep.push(next)
  })
  const watch = []
  ;(brief.watchlist || []).forEach((item, i) => {
    const next = normalizeOvernightItem(item, 'watch', i + 1)
    if (!next || seen.has(next.code)) return
    seen.add(next.code)
    watch.push(next)
  })

  return {
    final: true,
    mode: brief.mode.key,
    asOf: dashboard.serverTime || null,
    generatedAt: new Date().toISOString(),
    status: brief.status || '',
    statusLabel: brief.statusLabel || '',
    reason: brief.reason || '',
    dataReady: num(brief.dataReady, 0),
    plan: {
      triggerLow: 1,
      triggerHigh: 4,
      cancelAbove: 6,
      abandonBelow: -2
    },
    items: executable ? candidates : [],
    standby: executable ? [] : candidates,
    prep,
    watch
  }
}

function gateRecord(dashboard) {
  const gate = dashboard && dashboard.gate
  if (!gate) return null
  const counts = (dashboard.sectors && dashboard.sectors.counts) || {}
  const sectors = (dashboard.sectors && dashboard.sectors.all) || []
  const best = sectors
    .slice()
    .sort(
      (a, b) =>
        num(b.gatesPassed, 0) - num(a.gatesPassed, 0) ||
        num(b.heat, 0) - num(a.heat, 0)
    )[0]
  return {
    key: gate.key || '',
    label: gate.label || '',
    detail: gate.detail || '',
    dataReady: num(counts.dataReady, 0),
    candidateCount: num(counts.mainCandidates, 0),
    totalSectors: num(counts.sectors, 0),
    best: best
      ? {
          name: best.name,
          heat: num(best.heat, null),
          gatesPassed: num(best.gatesPassed, 0),
          gatesTotal: Array.isArray(best.checks) ? best.checks.length : 3,
          missing: Array.isArray(best.missing) ? best.missing.slice(0, 3) : []
        }
      : null
  }
}

function hasContent(day) {
  if (!day) return false
  if (Array.isArray(day.items) && day.items.length) return true
  const ov = day.overnight
  if (!ov) return false
  return OVERNIGHT_COHORTS.some((c) => Array.isArray(ov[c.field]) && ov[c.field].length)
}

function daySignature(day) {
  return JSON.stringify({
    final: day.final,
    actionable: day.actionable,
    action: day.action,
    gate: day.gate
      ? {
          key: day.gate.key,
          dataReady: day.gate.dataReady,
          candidateCount: day.gate.candidateCount,
          bestName: day.gate.best && day.gate.best.name,
          gatesPassed: day.gate.best && day.gate.best.gatesPassed
        }
      : null,
    items: (day.items || []).map((x) => ({
      code: x.code,
      lbc: x.lbc,
      close: x.close,
      promoProb: x.promoProb,
      hotScore: x.hotScore,
      sources: x.sources,
      sourceRanks: x.sourceRanks
    }))
  })
}

/* 看板每次重建都会调用；只有清单真的变化或首次定稿才写盘 */
function recordRecommendations(dashboard) {
  if (!dashboard || !dashboard.tradeDate) return null
  const plan = dashboard.review && dashboard.review.plan
  const today = dateStamp(beijingNow())
  const date = String(dashboard.tradeDate)
  const marketKey = dashboard.market && dashboard.market.key
  const final = date < today || marketKey === 'closed'
  const action = (plan && plan.action) || {}
  const overnight = buildOvernightRecord(dashboard)
  const gate = gateRecord(dashboard)
  const itemsMap = new Map()

  const promo = plan && Array.isArray(plan.promotionRank) ? plan.promotionRank : []
  promo.forEach((item, i) => mergeItem(itemsMap, item, 'promotion', i + 1))

  const ready =
    plan &&
    plan.hotshot &&
    plan.hotshot.tomorrow &&
    Array.isArray(plan.hotshot.tomorrow.ready)
      ? plan.hotshot.tomorrow.ready
      : []
  ready.forEach((item, i) => mergeItem(itemsMap, item, 'hotshot', i + 1))

  /* 只记录可成交来源；一字 / 秒板单列在 oneWordWatch，不混进跟踪样本 */
  const items = Array.from(itemsMap.values())
    .filter((x) => x.tradableBoard)
    .sort(
      (a, b) =>
        Math.min(...Object.values(a.sourceRanks)) -
          Math.min(...Object.values(b.sourceRanks)) ||
        b.lbc - a.lbc ||
        num(b.hotScore, 0) - num(a.hotScore, 0)
    )
  const store = loadStore()
  const existed = store.days[date]
  /* 定稿后不再改写，避免之后行情重建把已经记录的建议换掉；
   * 但隔夜台账 / 闸门记录若在复盘定稿之后才生成，允许补挂一次 */
  if (existed && existed.final) {
    let dirty = false
    if (overnight && !existed.overnight) {
      existed.overnight = overnight
      dirty = true
    }
    if (gate && !existed.gate) {
      existed.gate = gate
      dirty = true
    }
    /* 只补“为什么”的归因，不改定稿结论与推荐清单 */
    if (action && Array.isArray(action.blockers) && action.blockers.length) {
      const nextBlockers = action.blockers.slice(0, 5)
      const prevBlockers =
        existed.action && Array.isArray(existed.action.blockers)
          ? existed.action.blockers
          : []
      if (JSON.stringify(prevBlockers) !== JSON.stringify(nextBlockers)) {
        existed.action = { ...(existed.action || {}), blockers: nextBlockers }
        dirty = true
      }
    }
    if (dirty) {
      store.updatedAt = new Date().toISOString()
      saveStore(store)
      auditCache = null
    }
    return existed
  }

  /* 收盘重建时复盘计划可能因板块数据缺失变成空清单。
   * 这时保留盘中最后一份推荐并定稿，不能把当天样本丢掉。 */
  if (!items.length) {
    if (!final) return existed || null
    const existedItems = existed && Array.isArray(existed.items) ? existed.items : []
    if (!existedItems.length && !overnight) return existed || null
    const closedDay = {
      ...(existed || {}),
      date,
      asOf: dashboard.serverTime || (existed && existed.asOf) || null,
      generatedAt: (existed && existed.generatedAt) || new Date().toISOString(),
      final: true,
      finalizedAt: new Date().toISOString(),
      actionable: existed ? !!existed.actionable : false,
      action: existed ? existed.action : null,
      items: existedItems,
      overnight: overnight || (existed && existed.overnight) || null,
      gate: gate || (existed && existed.gate) || null
    }
    store.days[date] = closedDay
    store.updatedAt = new Date().toISOString()
    lastSignature = daySignature(closedDay)
    saveStore(store)
    auditCache = null
    return closedDay
  }

  const day = {
    date,
    asOf: dashboard.serverTime || null,
    generatedAt: new Date().toISOString(),
    final,
    finalizedAt: final ? new Date().toISOString() : null,
    actionable: ACTIONABLE_CAN_ACT.has(action.canAct),
    action: {
      canAct: action.canAct || null,
      label: action.label || '',
      position: action.position || '',
      tone: action.tone || '',
      blockers: Array.isArray(action.blockers) ? action.blockers.slice(0, 5) : []
    },
    items,
    overnight: overnight || (existed && existed.overnight) || null,
    gate: gate || (existed && existed.gate) || null
  }
  const signature = daySignature(day)
  if (existed && signature === lastSignature) return existed
  store.days[date] = day
  store.updatedAt = new Date().toISOString()
  const dates = Object.keys(store.days).sort()
  while (dates.length > MAX_DAYS) {
    delete store.days[dates.shift()]
  }
  lastSignature = signature
  saveStore(store)
  auditCache = null
  return day
}

function mapLimit(list, limit, fn) {
  return new Promise((resolve) => {
    const results = new Array(list.length)
    let cursor = 0
    let running = 0
    let done = 0
    if (!list.length) {
      resolve(results)
      return
    }
    const launch = () => {
      while (running < limit && cursor < list.length) {
        const index = cursor++
        running++
        Promise.resolve()
          .then(() => fn(list[index], index))
          .then(
            (value) => {
              results[index] = value
            },
            (err) => {
              results[index] = { error: err && err.message ? err.message : String(err) }
            }
          )
          .then(() => {
            running--
            done++
            if (done === list.length) resolve(results)
            else launch()
          })
      }
    }
    launch()
  })
}

function avgOf(values) {
  const list = values.filter((x) => Number.isFinite(x))
  if (!list.length) return null
  return list.reduce((a, b) => a + b, 0) / list.length
}

function summarize(rows) {
  const evaluated = rows.filter((x) => x.status === 'evaluated')
  const triggered = evaluated.filter((x) => x.trigger === 'trigger')
  const wins = triggered.filter((x) => x.dayRet > 0)
  const promoted = evaluated.filter((x) => x.promoted)
  const touched = evaluated.filter((x) => x.touchedLimit)
  return {
    samples: rows.length,
    evaluated: evaluated.length,
    pending: rows.filter((x) => x.status !== 'evaluated').length,
    triggered: triggered.length,
    wins: wins.length,
    winRate: triggered.length ? round((wins.length / triggered.length) * 100, 1) : null,
    avgRet: triggered.length
      ? round(avgOf(triggered.map((x) => x.dayRet)), 2)
      : null,
    avgGap: evaluated.length ? round(avgOf(evaluated.map((x) => x.gap)), 2) : null,
    promoted: promoted.length,
    promoRate: evaluated.length
      ? round((promoted.length / evaluated.length) * 100, 1)
      : null,
    touched: touched.length,
    noEntry: evaluated.length - triggered.length
  }
}

function triggerOf(gap, lbc) {
  if (!Number.isFinite(gap)) return 'unknown'
  const high = num(lbc, 1) === 1 ? 4 : 3
  const abandon = num(lbc, 1) === 1 ? 6 : 5
  if (gap < -2) return 'lowOpen'
  if (gap < 1) return 'flatOpen'
  if (gap <= high) return 'trigger'
  if (gap <= abandon) return 'highChase'
  return 'abandonGap'
}

/* 隔夜计划的执行口径固定为高开 1%–4%，>6% 放弃，<-2% 放弃 */
function overnightTriggerOf(gap) {
  if (!Number.isFinite(gap)) return 'unknown'
  if (gap < -2) return 'lowOpen'
  if (gap < 1) return 'flatOpen'
  if (gap <= 4) return 'trigger'
  if (gap <= 6) return 'highChase'
  return 'abandonGap'
}

function nextBarAfter(bars, day) {
  if (!Array.isArray(bars) || !bars.length) return null
  const sorted = bars.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)))
  const idx = sorted.findIndex((bar) => String(bar.date) === day)
  if (idx < 0 || idx + 1 >= sorted.length) return null
  return { base: sorted[idx], next: sorted[idx + 1] }
}

function evaluateRowBase(day, item, klines, today, marketClosed) {
  const row = {
    date: day.date,
    code: item.code,
    name: item.name,
    lbc: item.lbc,
    sector: item.sector,
    status: 'pending',
    nextDate: null,
    gap: null,
    dayRet: null,
    closeRet: null,
    trigger: 'unknown',
    promoted: false,
    touchedLimit: false
  }
  const bars = klines.get(item.code)
  if (!Array.isArray(bars) || !bars.length) {
    row.status = 'noKline'
    return row
  }
  const pair = nextBarAfter(bars, day.date)
  if (!pair) return row
  const { base, next } = pair
  /* 次日就是今天且还没收盘：不能用半天的 K 线算结果 */
  if (String(next.date) === today && !marketClosed) return row
  const prevClose = num(base.close, null)
  const open = num(next.open, null)
  const close = num(next.close, null)
  if (![prevClose, open, close].every((v) => Number.isFinite(v) && v > 0)) {
    row.status = 'badBar'
    return row
  }
  const limitPct = limitRatioFor(item.code) * 100
  const gap = (open / prevClose - 1) * 100
  const dayRet = (close / open - 1) * 100
  const closeRet = (close / prevClose - 1) * 100
  const highRet = (num(next.high, close) / prevClose - 1) * 100
  row.status = 'evaluated'
  row.nextDate = next.date
  row.gap = round(gap, 2)
  row.dayRet = round(dayRet, 2)
  row.closeRet = round(closeRet, 2)
  row.promoted = closeRet >= limitPct - 0.35
  row.touchedLimit = highRet >= limitPct - 0.3
  return row
}

async function evaluateDay(day, klines, today, marketClosed) {
  const rows = []
  for (const item of day.items || []) {
    const row = evaluateRowBase(day, item, klines, today, marketClosed)
    row.sources = item.sources
    row.sourceRanks = item.sourceRanks
    row.promoProb = item.promoProb
    row.hotScore = item.hotScore
    row.actionable = !!day.actionable
    row.actionLabel = day.action && day.action.label
    row.trigger =
      row.status === 'evaluated' ? triggerOf(row.gap, item.lbc) : 'unknown'
    rows.push(row)
  }
  return {
    date: day.date,
    asOf: day.asOf,
    actionable: !!day.actionable,
    action: day.action,
    rows
  }
}

function evaluateOvernightDay(day, klines, today, marketClosed) {
  const ov = day.overnight
  if (!ov) return null
  const rows = []
  for (const cohort of OVERNIGHT_COHORTS) {
    for (const item of ov[cohort.field] || []) {
      const row = evaluateRowBase(day, item, klines, today, marketClosed)
      row.cohort = cohort.key
      row.cohortLabel = cohort.label
      row.actionable = cohort.actionable
      row.score = item.score
      row.prepScore = item.prepScore
      row.geneScore = item.geneScore
      row.nodeScore = item.nodeScore
      row.sectorHeat = item.sectorHeat
      row.rank = item.rank
      row.tags = item.tags
      row.tradableBoard = item.tradableBoard
      row.trigger =
        row.status === 'evaluated' ? overnightTriggerOf(row.gap) : 'unknown'
      rows.push(row)
    }
  }
  return {
    date: day.date,
    asOf: ov.asOf || day.asOf,
    status: ov.status || '',
    statusLabel: ov.statusLabel || '',
    reason: ov.reason || '',
    dataReady: ov.dataReady || 0,
    rows
  }
}

function cohortRows(rows, key) {
  return rows.filter((x) => x.cohort === key)
}

/* ------------------------------------------------------------------ *
 * 分桶学习：只做描述性统计，样本 <5 不排序、不自动改权重
 * ------------------------------------------------------------------ */

const SCORE_BUCKETS = [
  { key: 'lt60', label: '<60', test: (v) => v != null && v < 60 },
  { key: '60-64', label: '60–64', test: (v) => v != null && v >= 60 && v < 65 },
  { key: '65-69', label: '65–69', test: (v) => v != null && v >= 65 && v < 70 },
  { key: '70-74', label: '70–74', test: (v) => v != null && v >= 70 && v < 75 },
  { key: 'gte75', label: '75+', test: (v) => v != null && v >= 75 }
]

const LBC_BUCKETS = [
  { key: '2', label: '2 板', test: (v) => v != null && v === 2 },
  { key: '3', label: '3 板', test: (v) => v != null && v === 3 },
  { key: '4+', label: '4 板+', test: (v) => v != null && v >= 4 }
]

const HEAT_BUCKETS = [
  { key: 'lt50', label: '热度 <50', test: (v) => v != null && v < 50 },
  { key: '50-64', label: '热度 50–64', test: (v) => v != null && v >= 50 && v < 65 },
  { key: 'gte65', label: '热度 65+', test: (v) => v != null && v >= 65 }
]

function bucketStats(label, rows) {
  const evaluated = rows.filter((x) => x.status === 'evaluated')
  const triggered = evaluated.filter((x) => x.trigger === 'trigger')
  const wins = triggered.filter((x) => x.dayRet > 0)
  const promoted = evaluated.filter((x) => x.promoted)
  return {
    label,
    samples: rows.length,
    evaluated: evaluated.length,
    triggered: triggered.length,
    wins: wins.length,
    winRate: triggered.length ? round((wins.length / triggered.length) * 100, 1) : null,
    avgRet: triggered.length ? round(avgOf(triggered.map((x) => x.dayRet)), 2) : null,
    promoRate: evaluated.length
      ? round((promoted.length / evaluated.length) * 100, 1)
      : null,
    enough: triggered.length >= MIN_BUCKET
  }
}

function buildBuckets(rows, field, defs) {
  return defs.map((def) =>
    bucketStats(
      def.label,
      rows.filter((x) => def.test(x[field]))
    )
  )
}

function buildLearning(rows) {
  const evaluated = rows.filter((x) => x.status === 'evaluated')
  const triggered = evaluated.filter((x) => x.trigger === 'trigger')
  const strict = rows.filter((x) => x.cohort === 'strict')
  const standby = rows.filter((x) => x.cohort === 'standby')
  const prep = rows.filter((x) => x.cohort === 'prep')
  const watch = rows.filter((x) => x.cohort === 'watch')

  const gapBuckets = ['lowOpen', 'flatOpen', 'trigger', 'highChase', 'abandonGap'].map(
    (key) => bucketStats(GAP_LABELS[key], rows.filter((x) => x.trigger === key))
  )
  const buckets = {
    score: buildBuckets(rows, 'score', SCORE_BUCKETS),
    lbc: buildBuckets(rows, 'lbc', LBC_BUCKETS),
    gap: gapBuckets,
    heat: buildBuckets(rows, 'sectorHeat', HEAT_BUCKETS),
    cohort: [strict, standby, prep, watch].map((list, i) =>
      bucketStats(['严格三强', '候选未执行', '准备池', '观察池'][i], list)
    )
  }

  const notes = []
  if (!evaluated.length) {
    notes.push('还没有可核对的隔夜样本；下一次盘后定稿后开始记录，不补造历史。')
  } else if (evaluated.length < MIN_BUCKET) {
    notes.push(
      `已核对 ${evaluated.length} 只隔夜样本，少于 ${MIN_BUCKET} 只：只展示方向，不据此调权重。`
    )
  } else {
    const bestGap = gapBuckets
      .filter((b) => b.enough)
      .slice()
      .sort((a, b) => (b.avgRet || 0) - (a.avgRet || 0))[0]
    if (bestGap) {
      notes.push(
        `缺口分桶里「${bestGap.label}」已有 ${bestGap.triggered} 个触发样本，平均开→收 ${
          bestGap.avgRet == null ? '--' : `${bestGap.avgRet > 0 ? '+' : ''}${bestGap.avgRet}%`
        }。`
      )
    } else {
      notes.push(`各缺口分桶的触发样本都还不到 ${MIN_BUCKET} 只，执行区间暂不排序。`)
    }
    const high = buckets.score.filter(
      (b) => b.label === '70–74' || b.label === '75+'
    )
    const highTrig = high.reduce((n, b) => n + b.triggered, 0)
    if (highTrig >= MIN_BUCKET) {
      const highStats = bucketStats(
        '70+',
        rows.filter((x) => x.score != null && x.score >= 70)
      )
      notes.push(
        `隔夜分 70+ 的触发胜率 ${highStats.winRate == null ? '--' : `${highStats.winRate}%`}（${highStats.wins}/${highStats.triggered}），可与低分桶继续对照。`
      )
    }
    const strictTrig = strict.filter(
      (x) => x.status === 'evaluated' && x.trigger === 'trigger'
    )
    const prepTrig = prep.filter(
      (x) => x.status === 'evaluated' && x.trigger === 'trigger'
    )
    if (strictTrig.length >= MIN_BUCKET && prepTrig.length >= MIN_BUCKET) {
      const strictWins = strictTrig.filter((x) => x.dayRet > 0).length
      const prepWins = prepTrig.filter((x) => x.dayRet > 0).length
      const sw = round((strictWins / strictTrig.length) * 100, 1)
      const pw = round((prepWins / prepTrig.length) * 100, 1)
      notes.push(
        `同窗口严格三强触发胜率 ${sw}%（${strictWins}/${strictTrig.length}），准备池对照 ${pw}%（${prepWins}/${prepTrig.length}）；${
          sw >= pw ? '严格闸门暂未跑输对照。' : '对照跑赢严格层，需复核闸门是否漏掉有效样本。'
        }`
      )
    }
    notes.push('分桶只描述历史，不预测下一只；达到样本阈值前不自动调整权重。')
  }

  return { minSamples: MIN_BUCKET, evaluated: evaluated.length, triggered: triggered.length, notes, buckets }
}

function signedPct(v) {
  if (v == null) return '--'
  return `${v > 0 ? '+' : ''}${v}%`
}

function buildOvernightShare({ window, strict, standby, prep, watch, learning, days }) {
  const lines = [`龙脉隔夜台账 · 近 ${window.days} 个定稿日`]
  lines.push(
    `严格三强：记录 ${strict.samples} · 已核对 ${strict.evaluated} · 触发 ${strict.triggered} · 胜率 ${
      strict.winRate == null ? '--' : `${strict.winRate}%`
    } · 开→收 ${signedPct(strict.avgRet)} · 晋级率 ${
      strict.promoRate == null ? '--' : `${strict.promoRate}%`
    }`
  )
  if (standby.samples) {
    lines.push(
      `候选未执行（情绪未确认）：已核对 ${standby.evaluated} · 触发 ${standby.triggered} · 胜率 ${
        standby.winRate == null ? '--' : `${standby.winRate}%`
      } · 开→收 ${signedPct(standby.avgRet)}`
    )
  }
  if (prep.samples) {
    lines.push(
      `准备池对照（不推荐）：已核对 ${prep.evaluated} · 触发 ${prep.triggered} · 胜率 ${
        prep.winRate == null ? '--' : `${prep.winRate}%`
      } · 开→收 ${signedPct(prep.avgRet)}`
    )
  }
  if (watch.samples) {
    lines.push(
      `观察池对照（不推荐）：已核对 ${watch.evaluated} · 触发 ${watch.triggered} · 胜率 ${
        watch.winRate == null ? '--' : `${watch.winRate}%`
      } · 开→收 ${signedPct(watch.avgRet)}`
    )
  }
  const latest = days && days.length ? days[0] : null
  if (latest) {
    const strictNames = latest.strictNames.length
      ? latest.strictNames.join('、')
      : '0 只（闸门未开）'
    lines.push(`最近定稿 ${latest.date}：严格 ${strictNames}`)
    if (latest.standbyNames && latest.standbyNames.length) {
      lines.push(`候选未执行（情绪未确认）：${latest.standbyNames.join('、')}`)
    }
    if (latest.prepNames.length) {
      lines.push(`准备池观察：${latest.prepNames.join('、')}（只观察，不挂单）`)
    }
  }
  if (learning.notes.length) lines.push(`学习：${learning.notes[0]}`)
  lines.push('次日真实日线核对 · 样本不足只作方向 · 不补造历史')
  return { title: '龙脉隔夜台账', text: lines.join('\n') }
}

function summarizeGates(days) {
  const list = days.map((d) => d.gate).filter(Boolean)
  if (!list.length) return null
  const passDays = list.filter((g) => num(g.dataReady, 0) > 0).length
  const missing = {}
  for (const g of list) {
    for (const label of (g.best && g.best.missing) || []) {
      missing[label] = (missing[label] || 0) + 1
    }
  }
  const topMissing = Object.entries(missing)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([label, count]) => ({ label, count }))
  return {
    days: list.length,
    passDays,
    topMissing,
    avgCandidates: round(avgOf(list.map((g) => g.candidateCount)), 1),
    avgDataReady: round(avgOf(list.map((g) => g.dataReady)), 1)
  }
}

async function buildRecAudit({ days = 10 } = {}) {
  const store = loadStore()
  const now = beijingNow()
  const today = dateStamp(now)
  const marketClosed = marketStatus(now).key === 'closed'
  const all = Object.values(store.days).sort((a, b) =>
    String(b.date).localeCompare(String(a.date))
  )
  const finalDays = all.filter((d) => d && hasContent(d) && d.final)
  const provisional = all.filter(
    (d) =>
      d &&
      hasContent(d) &&
      !d.final &&
      d.date !== today
  )
  const selected = finalDays.slice(0, days)
  const codes = new Set()
  for (const d of selected) {
    for (const x of d.items || []) codes.add(x.code)
    const ov = d.overnight
    if (ov) {
      for (const cohort of OVERNIGHT_COHORTS) {
        for (const x of ov[cohort.field] || []) codes.add(x.code)
      }
    }
  }
  const klines = new Map()
  await mapLimit(Array.from(codes), FETCH_CONCURRENCY, async (code) => {
    try {
      const bars = await tencentKline(secidOf(code), KLINE_LIMIT)
      klines.set(code, bars)
    } catch (err) {
      klines.set(code, [])
    }
  })

  const dayResults = []
  const overnightDayResults = []
  for (const day of selected) {
    dayResults.push(await evaluateDay(day, klines, today, marketClosed))
    const ovDay = evaluateOvernightDay(day, klines, today, marketClosed)
    if (ovDay) overnightDayResults.push(ovDay)
  }
  const rows = dayResults.flatMap((d) => d.rows)
  const actionableRows = rows.filter((x) => x.actionable)
  const watchRows = rows.filter((x) => !x.actionable)

  const triggers = rows.reduce((acc, x) => {
    if (x.status !== 'evaluated') return acc
    acc[x.trigger] = (acc[x.trigger] || 0) + 1
    return acc
  }, {})

  const overnightRows = overnightDayResults.flatMap((d) => d.rows)
  const strict = summarize(overnightRows.filter((x) => x.cohort === 'strict'))
  const standby = summarize(overnightRows.filter((x) => x.cohort === 'standby'))
  const prep = summarize(overnightRows.filter((x) => x.cohort === 'prep'))
  const watch = summarize(overnightRows.filter((x) => x.cohort === 'watch'))
  const learning = buildLearning(overnightRows)
  const overnightDays = overnightDayResults.map((d) => {
    const strictRows = cohortRows(d.rows, 'strict')
    const standbyRows = cohortRows(d.rows, 'standby')
    const prepRows = cohortRows(d.rows, 'prep')
    const watchRows2 = cohortRows(d.rows, 'watch')
    return {
      date: d.date,
      status: d.status,
      statusLabel: d.statusLabel,
      reason: d.reason,
      dataReady: d.dataReady,
      strictNames: strictRows.map((x) => x.name),
      standbyNames: standbyRows.map((x) => x.name),
      prepNames: prepRows.map((x) => x.name),
      watchNames: watchRows2.map((x) => x.name),
      stats: {
        strict: summarize(strictRows),
        standby: summarize(standbyRows),
        prep: summarize(prepRows),
        watch: summarize(watchRows2)
      },
      rows: d.rows
    }
  })
  const overnightWindow = {
    days: overnightDayResults.length,
    from: overnightDayResults.length
      ? overnightDayResults[overnightDayResults.length - 1].date
      : null,
    to: overnightDayResults.length ? overnightDayResults[0].date : null
  }
  const overnight = {
    window: overnightWindow,
    strict,
    standby,
    prep,
    watch,
    learning,
    gates: summarizeGates(selected),
    days: overnightDays,
    share: buildOvernightShare({
      window: overnightWindow,
      strict,
      standby,
      prep,
      watch,
      learning,
      days: overnightDays
    }),
    notes: [
      '隔夜台账只记录盘后定稿（15:00 后）的隔夜候选；盘中预演不写入，避免计划未定就留样本。',
      '只有三关 + 情绪修复/主升（status=ready）的候选才算严格三强；情绪未确认时页面仍会展示候选，但台账单列“候选未执行”，不计入推荐胜率。',
      '严格三强是唯一按“推荐”统计的样本；候选未执行、准备池与观察池只作对照，不挂单、不计入推荐胜率。',
      '执行口径固定：竞价高开 1%–4% 触发，>6% 放弃，<-2% 放弃；开→收按次日开盘价近似竞价成交。',
      '一字 / 秒板不进严格三强；准备池、观察池保留“今日一字 / 秒板”标记，只用于对照。',
      '样本少于 5 只只展示方向，不自动调权重；台账从功能上线开始积累，不补造历史。'
    ]
  }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    window: {
      days: selected.length,
      from: selected.length ? selected[selected.length - 1].date : null,
      to: selected.length ? selected[0].date : null,
      requested: days
    },
    ledger: {
      days: Object.keys(store.days).length,
      finalDays: finalDays.length,
      provisionalDays: provisional.length,
      updatedAt: store.updatedAt
    },
    actionable: summarize(actionableRows),
    watch: summarize(watchRows),
    triggers,
    gates: summarizeGates(selected),
    overnight,
    days: dayResults.map((d) => ({
      date: d.date,
      asOf: d.asOf,
      actionable: d.actionable,
      action: d.action,
      stats: summarize(d.rows),
      rows: d.rows
    })),
    today: (() => {
      const day = store.days[today]
      if (!day || !hasContent(day)) return null
      const ov = day.overnight
      return {
        date: day.date,
        asOf: day.asOf,
        final: !!day.final,
        actionable: !!day.actionable,
        action: day.action,
        items: Array.isArray(day.items) ? day.items.length : 0,
        overnight: ov
          ? {
              status: ov.status,
              strict: (ov.items || []).length,
              standby: (ov.standby || []).length,
              prep: (ov.prep || []).length,
              watch: (ov.watch || []).length
            }
          : null
      }
    })(),
    provisional: provisional.slice(0, 5).map((d) => ({
      date: d.date,
      asOf: d.asOf,
      action: d.action,
      items: Array.isArray(d.items) ? d.items.length : 0
    })),
    notes: [
      '样本只包含复盘里明确给出的“明日连板晋级榜 / 明日打板待选”，以及盘后定稿的隔夜三强；首页观察池、准备池与预警不计入可执行胜率。',
      '结果按次日真实日线核对：竞价缺口 +1%–3%（首板 +1%–4%）为触发买点，开盘→收盘为当日收益；缺口 >5%/6% 或 < -2% 视为未触发，不马后炮按最优价成交。',
      '胜率只在“触发买点”的样本里统计；样本少于 5 只时只能看方向，不能当稳定胜率。',
      '盘中快照未在收盘后定稿的日子不进入统计；台账从功能上线开始积累，不补造历史。'
    ]
  }
}

async function getRecAudit({ days = 10, force = false } = {}) {
  const now = Date.now()
  if (!force && auditCache && auditCacheDays === days && now - auditCacheAt < AUDIT_TTL) {
    return auditCache
  }
  const data = await buildRecAudit({ days })
  auditCache = data
  auditCacheAt = now
  auditCacheDays = days
  return data
}

function peekRecAuditCache() {
  return auditCache
}

module.exports = {
  recordRecommendations,
  buildRecAudit,
  getRecAudit,
  peekRecAuditCache
}