'use strict'

/*
 * 推荐跟踪台账
 * - 只记录复盘里明确给出的“可执行清单”：明日连板晋级榜 + 明日打板待选
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

let ledgerMemory = null
let lastSignature = ''
let auditCache = null
let auditCacheAt = 0
let auditCacheDays = 0
const AUDIT_TTL = 1000 * 60 * 5

const ACTIONABLE_CAN_ACT = new Set(['conditional', 'small'])

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

function daySignature(day) {
  return JSON.stringify({
    final: day.final,
    actionable: day.actionable,
    action: day.action,
    items: day.items.map((x) => ({
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
  if (!plan) return null
  const today = dateStamp(beijingNow())
  const date = String(dashboard.tradeDate)
  const marketKey = dashboard.market && dashboard.market.key
  const final = date < today || marketKey === 'closed'
  const action = plan.action || {}
  const itemsMap = new Map()

  const promo = Array.isArray(plan.promotionRank) ? plan.promotionRank : []
  promo.forEach((item, i) => mergeItem(itemsMap, item, 'promotion', i + 1))

  const ready =
    plan.hotshot && plan.hotshot.tomorrow && Array.isArray(plan.hotshot.tomorrow.ready)
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
  /* 定稿后不再改写，避免之后行情重建把已经记录的建议换掉 */
  if (existed && existed.final) return existed

  /* 收盘重建时复盘计划可能因板块数据缺失变成空清单。
   * 这时保留盘中最后一份推荐并定稿，不能把当天样本丢掉。 */
  if (!items.length) {
    if (!final || !existed || !Array.isArray(existed.items) || !existed.items.length) {
      return existed || null
    }
    const closedDay = {
      ...existed,
      final: true,
      finalizedAt: new Date().toISOString()
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
      tone: action.tone || ''
    },
    items
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

async function evaluateDay(day, klines, today, marketClosed) {
  const rows = []
  for (const item of day.items) {
    const bars = klines.get(item.code)
    const row = {
      date: day.date,
      code: item.code,
      name: item.name,
      lbc: item.lbc,
      sector: item.sector,
      sources: item.sources,
      sourceRanks: item.sourceRanks,
      promoProb: item.promoProb,
      hotScore: item.hotScore,
      actionable: !!day.actionable,
      actionLabel: day.action && day.action.label,
      status: 'pending',
      nextDate: null,
      gap: null,
      dayRet: null,
      closeRet: null,
      trigger: 'unknown',
      promoted: false,
      touchedLimit: false
    }
    if (!Array.isArray(bars) || !bars.length) {
      row.status = 'noKline'
      rows.push(row)
      continue
    }
    const sorted = bars.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)))
    const idx = sorted.findIndex((bar) => String(bar.date) === day.date)
    if (idx < 0 || idx + 1 >= sorted.length) {
      row.status = 'pending'
      rows.push(row)
      continue
    }
    const base = sorted[idx]
    const next = sorted[idx + 1]
    /* 次日就是今天且还没收盘：不能用半天的 K 线算结果 */
    if (String(next.date) === today && !marketClosed) {
      row.status = 'pending'
      rows.push(row)
      continue
    }
    const prevClose = num(base.close, null)
    const open = num(next.open, null)
    const close = num(next.close, null)
    if (![prevClose, open, close].every((v) => Number.isFinite(v) && v > 0)) {
      row.status = 'badBar'
      rows.push(row)
      continue
    }
    const limitPct = limitRatioFor(item.code) * 100
    const gap = (open / prevClose - 1) * 100
    const dayRet = (close / open - 1) * 100
    const closeRet = (close / prevClose - 1) * 100
    const highRet = ((num(next.high, close) / prevClose) - 1) * 100
    row.status = 'evaluated'
    row.nextDate = next.date
    row.gap = round(gap, 2)
    row.dayRet = round(dayRet, 2)
    row.closeRet = round(closeRet, 2)
    row.trigger = triggerOf(gap, item.lbc)
    row.promoted = closeRet >= limitPct - 0.35
    row.touchedLimit = highRet >= limitPct - 0.3
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

async function buildRecAudit({ days = 10 } = {}) {
  const store = loadStore()
  const now = beijingNow()
  const today = dateStamp(now)
  const marketClosed = marketStatus(now).key === 'closed'
  const all = Object.values(store.days).sort((a, b) => String(b.date).localeCompare(String(a.date)))
  const finalDays = all.filter(
    (d) => d && Array.isArray(d.items) && d.items.length && d.final
  )
  const provisional = all.filter(
    (d) => d && Array.isArray(d.items) && d.items.length && !d.final && d.date !== today
  )
  const selected = finalDays.slice(0, days)
  const codes = Array.from(
    new Set(selected.flatMap((d) => d.items.map((x) => x.code)))
  )
  const klines = new Map()
  await mapLimit(codes, FETCH_CONCURRENCY, async (code) => {
    try {
      const bars = await tencentKline(secidOf(code), KLINE_LIMIT)
      klines.set(code, bars)
    } catch (err) {
      klines.set(code, [])
    }
  })

  const dayResults = []
  for (const day of selected) {
    dayResults.push(await evaluateDay(day, klines, today, marketClosed))
  }
  const rows = dayResults.flatMap((d) => d.rows)
  const actionableRows = rows.filter((x) => x.actionable)
  const watchRows = rows.filter((x) => !x.actionable)

  const triggers = rows.reduce((acc, x) => {
    if (x.status !== 'evaluated') return acc
    acc[x.trigger] = (acc[x.trigger] || 0) + 1
    return acc
  }, {})

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
      if (!day || !Array.isArray(day.items) || !day.items.length) return null
      return {
        date: day.date,
        asOf: day.asOf,
        final: !!day.final,
        actionable: !!day.actionable,
        action: day.action,
        items: day.items.length
      }
    })(),
    provisional: provisional.slice(0, 5).map((d) => ({
      date: d.date,
      asOf: d.asOf,
      action: d.action,
      items: d.items.length
    })),
    notes: [
      '样本只包含复盘里明确给出的“明日连板晋级榜 / 明日打板待选”，且已剔除一字 / 秒板；首页观察池、准备池与预警不计入。',
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