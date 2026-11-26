import { reactive, computed } from 'vue'
import { catalystType, getCatalyst, isCatalystValid } from './catalysts'
import { getAlertDiagnostics } from './api'

const SETTINGS_KEY = 'longmai.alerts.settings.v1'
const HISTORY_KEY = 'longmai.alerts.history.v1'
const SEEN_KEY = 'longmai.alerts.seen.v1'
const RECS_KEY = 'longmai.alerts.recs.v1'
const MAX_HISTORY = 80
const MAX_SEEN = 400
const MAX_RECS = 60

const DEFAULTS = {
  enabled: true,
  includePending: true,
  desktop: false,
  sound: true
}

function readSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')
    return { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  } catch (e) {
    return { ...DEFAULTS }
  }
}

function readHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
    if (!Array.isArray(raw)) return []
    return raw
      .filter((x) => x && x.id && x.code)
      .slice(0, MAX_HISTORY)
      .map((x) => ({ ...x, read: !!x.read }))
  } catch (e) {
    return []
  }
}

function readSeen() {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')
    return Array.isArray(raw)
      ? raw.filter((x) => typeof x === 'string').slice(-MAX_SEEN)
      : []
  } catch (e) {
    return []
  }
}

/* 推荐记录独立于弹窗历史：刷新页面、重新打开都能看到当天的推荐与首次时间 */
function readRecommendationStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECS_KEY) || '{}')
    const items = Array.isArray(raw) ? raw : raw && Array.isArray(raw.items) ? raw.items : []
    const clean = items
      .filter((x) => x && x.key && x.code)
      .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
      .slice(0, MAX_RECS)
    return {
      items: clean,
      date:
        raw && !Array.isArray(raw) && raw.date
          ? raw.date
          : clean[0]
            ? clean[0].tradeDate || ''
            : '',
      dateLabel:
        raw && !Array.isArray(raw) && raw.dateLabel
          ? raw.dateLabel
          : clean[0]
            ? clean[0].tradeDateLabel || shortDate(clean[0].tradeDate)
            : ''
    }
  } catch (e) {
    return { items: [], date: '', dateLabel: '' }
  }
}

/* 去重键与展示记录分开保存：用户清空记录后，同一只票当天仍不会再次弹窗 */
const seenKeys = readSeen()
const recStore = readRecommendationStore()

export const alertState = reactive({
  ...readSettings(),
  history: readHistory(),
  recommendations: recStore.items,
  recommendationDate: recStore.date,
  recommendationDateLabel: recStore.dateLabel,
  current: null,
  queue: [],
  centerOpen: false,
  windowOpen: false,
  windowKey: '',
  funnel: null,
  tail: null,
  diagnostics: null,
  diagnosticsTail: null,
  diagnosticsAt: 0,
  lastCheckAt: 0,
  lastError: '',
  seeded: false
})

for (const item of alertState.history) {
  if (item && item.key && !item.test && !seenKeys.includes(item.key)) seenKeys.push(item.key)
}
try {
  if (seenKeys.length) localStorage.setItem(SEEN_KEY, JSON.stringify(seenKeys))
} catch (e) {
  /* 仅保留本次会话 */
}

export const unreadAlerts = computed(
  () => alertState.history.filter((x) => !x.read && !x.test).length
)

/* 当前仍在预警榜里的推荐：严格按预警分从强到弱，显示名次即排序 */
export const currentRecommendations = computed(() =>
  (alertState.recommendations || [])
    .filter(
      (x) =>
        x &&
        x.active &&
        (!alertState.recommendationDate || x.tradeDate === alertState.recommendationDate)
    )
    .slice()
    .sort(
      (a, b) =>
        (Number(b.alertScore) || 0) - (Number(a.alertScore) || 0) ||
        String(a.recommendAt || '').localeCompare(String(b.recommendAt || ''))
    )
)

/* 已移出榜单的当日记录：只做时间留档，不再冒充当前推荐 */
export const pastRecommendations = computed(() =>
  (alertState.recommendations || [])
    .filter(
      (x) =>
        x &&
        !x.active &&
        (!alertState.recommendationDate || x.tradeDate === alertState.recommendationDate)
    )
    .slice()
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
)

export const recommendationUpdatedAt = computed(() => {
  const list = alertState.recommendations || []
  if (!list.length) return ''
  const latest = list.reduce((max, x) => Math.max(max, Number(x.updatedAt) || 0), 0)
  return latest ? stampOf(latest) : ''
})

const timeFmt = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
})

function stampOf(at) {
  try {
    return timeFmt.format(new Date(at))
  } catch (e) {
    return '--:--:--'
  }
}

function shortDate(date) {
  const d = String(date || '')
  return d.length === 8 ? `${d.slice(4, 6)}-${d.slice(6, 8)}` : d
}

function persistSettings() {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        enabled: alertState.enabled,
        includePending: alertState.includePending,
        desktop: alertState.desktop,
        sound: alertState.sound
      })
    )
  } catch (e) {
    /* 仅保留本次会话 */
  }
}

function persistHistory() {
  try {
    const clean = alertState.history.filter((x) => !x.test).slice(0, MAX_HISTORY)
    localStorage.setItem(HISTORY_KEY, JSON.stringify(clean))
  } catch (e) {
    /* 仅保留本次会话 */
  }
}

let recPersistAt = 0

/* 推荐记录写入做 5 秒节流；新增 / 移出榜单时强制落盘，刷新不丢 */
function persistRecommendations(force = false) {
  const now = Date.now()
  if (!force && now - recPersistAt < 5000) return
  recPersistAt = now
  try {
    localStorage.setItem(
      RECS_KEY,
      JSON.stringify({
        date: alertState.recommendationDate || '',
        dateLabel: alertState.recommendationDateLabel || '',
        items: (alertState.recommendations || []).slice(0, MAX_RECS)
      })
    )
  } catch (e) {
    /* 仅保留本次会话 */
  }
}

function markSeen(key) {
  if (!key || seenKeys.includes(key)) return
  seenKeys.push(key)
  if (seenKeys.length > MAX_SEEN) seenKeys.splice(0, seenKeys.length - MAX_SEEN)
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seenKeys))
  } catch (e) {
    /* 仅保留本次会话 */
  }
}

/* ------------------------------------------------------------------ *
 * 预警推荐：当前榜单 + 当日历史，刷新不清空
 * ------------------------------------------------------------------ */

export function ingestRecommendations(board, meta = {}) {
  const list = Array.isArray(board) ? board.filter((x) => x && x.code) : []
  const tradeDate = meta.tradeDate || (list[0] && list[0].tradeDate) || ''
  if (!tradeDate) return

  const now = Date.now()
  const nowIso = new Date(now).toISOString()
  const nowTime = stampOf(now)
  const seen = new Set()
  let dirty = false

  if (alertState.recommendationDate !== tradeDate) {
    alertState.recommendationDate = tradeDate
    dirty = true
  }
  if (meta.tradeDateLabel && alertState.recommendationDateLabel !== meta.tradeDateLabel) {
    alertState.recommendationDateLabel = meta.tradeDateLabel
    dirty = true
  }

  for (const x of list) {
    const key = `${tradeDate}:${x.code}`
    if (seen.has(key)) continue
    seen.add(key)
    let rec = alertState.recommendations.find((r) => r.key === key)
    if (!rec) {
      rec = {
        id: key,
        key,
        code: x.code,
        name: x.name || x.code,
        tradeDate,
        tradeDateLabel: meta.tradeDateLabel || x.tradeDateLabel || shortDate(tradeDate),
        recommendAt: x.recommendAt || nowIso,
        recommendTime: x.recommendTime || nowTime,
        active: true,
        updatedAt: now,
        read: true
      }
      alertState.recommendations.push(rec)
      dirty = true
    }
    if (!rec.active) {
      rec.active = true
      rec.inactiveLabel = ''
      dirty = true
    }
    Object.assign(rec, {
      name: x.name || rec.name,
      sector: x.sector || rec.sector || '未分类',
      sectorKey: x.sectorKey || rec.sectorKey || '',
      sectorHeat: x.sectorHeat != null ? x.sectorHeat : rec.sectorHeat,
      sectorTodayCount: x.sectorTodayCount != null ? x.sectorTodayCount : rec.sectorTodayCount,
      sectorReady: !!x.sectorReady,
      lbc: x.lbc != null ? x.lbc : rec.lbc,
      fromPool: !!x.fromPool,
      price: x.price != null ? x.price : rec.price,
      pct: x.pct != null ? x.pct : rec.pct,
      limitUp: x.limitUp != null ? x.limitUp : rec.limitUp,
      gapToLimit: x.gapToLimit != null ? x.gapToLimit : rec.gapToLimit,
      sealed: false,
      buyable: true,
      sealRatio: x.sealRatio != null ? x.sealRatio : rec.sealRatio,
      sealFund: x.sealFund == null ? rec.sealFund : x.sealFund,
      firstSealLabel: x.firstSealLabel || rec.firstSealLabel,
      nuclearLevel: x.nuclearLevel || rec.nuclearLevel || 'low',
      nuclearScore: x.nuclearScore != null ? x.nuclearScore : rec.nuclearScore,
      nuclearShort: x.nuclearShort || rec.nuclearShort || '',
      blowCount: x.blowCount != null ? x.blowCount : rec.blowCount,
      turnover: x.turnover != null ? x.turnover : rec.turnover,
      amount: x.amount != null ? x.amount : rec.amount,
      amountRatio: x.amountRatio != null ? x.amountRatio : rec.amountRatio,
      volRatio: x.volRatio != null ? x.volRatio : rec.volRatio,
      score: x.score != null ? x.score : rec.score,
      alertScore: x.alertScore != null ? x.alertScore : rec.alertScore,
      confidence: x.confidence || rec.confidence || 'standard',
      geneScore: x.geneScore != null ? x.geneScore : rec.geneScore,
      nodeLabel: x.nodeLabel || rec.nodeLabel,
      statusLabel: x.statusLabel || rec.statusLabel || '盘中推荐 · 未封板',
      stageKey: x.stageKey || (meta.stage && meta.stage.key) || rec.stageKey || '',
      alertMode: x.alertMode || (meta.intraday ? 'intraday' : rec.alertMode || 'auction'),
      tags: Array.isArray(x.tags) ? x.tags.slice(0, 4) : rec.tags || [],
      reasons: Array.isArray(x.reasons) ? x.reasons.slice(0, 4) : rec.reasons || [],
      risks: Array.isArray(x.risks) ? x.risks.slice(0, 3) : rec.risks || [],
      active: true,
      lastSeenAt: nowIso,
      lastSeenTime: nowTime,
      updatedAt: now,
      read: true
    })
  }

  /* 跨交易日：旧记录保留为历史，不再显示在“当前在榜” */
  for (const rec of alertState.recommendations) {
    if (rec.tradeDate !== tradeDate && rec.active) {
      rec.active = false
      rec.updatedAt = now
      rec.inactiveLabel = '上一交易日记录'
      dirty = true
    }
  }

  /* 只有榜单可信时才把未出现的旧推荐移出，避免午间冻结 / 数据抖动误伤 */
  if (meta.pruneActive !== false) {
    for (const rec of alertState.recommendations) {
      if (rec.tradeDate === tradeDate && rec.active && !seen.has(rec.key)) {
        rec.active = false
        rec.updatedAt = now
        rec.inactiveLabel = '已移出当前推荐榜（封板 / 走弱 / 不再达标）'
        dirty = true
      }
    }
  }

  const keepDates = Array.from(
    new Set(alertState.recommendations.map((r) => r.tradeDate).filter(Boolean))
  )
    .sort()
    .slice(-2)
  const next = alertState.recommendations
    .filter((r) => keepDates.includes(r.tradeDate))
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
    .slice(0, MAX_RECS)
  if (next.length !== alertState.recommendations.length) dirty = true
  alertState.recommendations = next

  persistRecommendations(dirty)
}

export function catalystStateFor(sectorKey) {
  const entry = getCatalyst(sectorKey)
  if (entry && entry.type === 'rumor') {
    return { state: 'rumor', label: '纯传闻' }
  }
  if (isCatalystValid(entry)) {
    const meta = catalystType(entry.type)
    return { state: 'valid', label: `催化·${meta ? meta.short : '有效'}` }
  }
  return {
    state: 'pending',
    label: entry && entry.type === 'none' ? '暂无催化' : '催化未核验'
  }
}

/* ------------------------------------------------------------------ *
 * 提示音与桌面通知
 * ------------------------------------------------------------------ */

let audioCtx = null

function beep() {
  if (!alertState.sound) return
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext
    if (!Ctor) return
    if (!audioCtx) audioCtx = new Ctor()
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {})
    const t0 = audioCtx.currentTime + 0.02
    for (const [freq, offset] of [
      [880, 0],
      [1320, 0.16]
    ]) {
      const osc = audioCtx.createOscillator()
      const gain = audioCtx.createGain()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, t0 + offset)
      gain.gain.setValueAtTime(0.0001, t0 + offset)
      gain.gain.exponentialRampToValueAtTime(0.09, t0 + offset + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + 0.18)
      osc.connect(gain)
      gain.connect(audioCtx.destination)
      osc.start(t0 + offset)
      osc.stop(t0 + offset + 0.2)
    }
  } catch (e) {
    /* 浏览器不允许自动播放时静默降级 */
  }
}

export function desktopSupported() {
  return typeof window !== 'undefined' && 'Notification' in window
}

export function desktopPermission() {
  return desktopSupported() ? Notification.permission : 'unsupported'
}

export async function requestDesktopPermission() {
  if (!desktopSupported()) return 'unsupported'
  try {
    const result = await Notification.requestPermission()
    alertState.desktop = result === 'granted'
    persistSettings()
    return result
  } catch (e) {
    return 'error'
  }
}

function notifyDesktop(alert) {
  if (!alertState.desktop || !desktopSupported() || Notification.permission !== 'granted') {
    return
  }
  try {
    const n = new Notification(
      alert.tailSummary
        ? `尾盘预期 · 明日观察 · ${alert.names.length} 只`
        : `${alert.intraday ? '盘中预警' : '竞价预警'} · ${alert.actionable ? '可执行' : '观察'} · ${alert.name}`,
      {
        body: alert.tailSummary
          ? `${alert.names.join('、')}\n只作明日观察，不是隔夜三强，也不是买入指令。`
          : `${alert.sector} · ${alert.statusLabel} · 预警分 ${alert.score}\n${
              alert.reasons[0] || ''
            }`,
        tag: alert.key,
        silent: true
      }
    )
    n.onclick = () => {
      try {
        window.focus()
      } catch (e) {
        /* ignore */
      }
      openAlertCenter()
      n.close()
    }
  } catch (e) {
    /* 权限或系统限制时静默 */
  }
}

/* ------------------------------------------------------------------ *
 * 预警对象与去重
 * ------------------------------------------------------------------ */

function makeAlert(x, payload, key, cat) {
  const at = Date.now()
  const win = payload.window || null
  const alertScore = x.alertScore != null ? Number(x.alertScore) : Number(x.score)
  const intraday = !!payload.intraday || x.alertMode === 'intraday'
  return {
    id: `${key}:${at}`,
    key,
    at,
    time: stampOf(at),
    recommendAt: x.recommendAt || new Date(at).toISOString(),
    recommendTime: x.recommendTime || stampOf(at),
    lastSeenTime: x.lastSeenTime || stampOf(at),
    date: payload.tradeDate || '',
    dateLabel: shortDate(payload.tradeDate),
    code: x.code,
    name: x.name,
    sector: x.sector || '未分类',
    sectorKey: x.sectorKey || '',
    sectorHeat: x.sectorHeat,
    sectorTodayCount: x.sectorTodayCount,
    sectorReady: !!x.sectorReady,
    fromPool: !!x.fromPool,
    lbc: x.lbc,
    price: x.price,
    pct: x.pct,
    limitUp: x.limitUp,
    gapToLimit: x.gapToLimit,
    sealed: !!x.sealed,
    buyable: x.buyable !== false && !x.sealed,
    sealRatio: x.sealRatio,
    sealFund: x.sealFund == null ? null : x.sealFund,
    firstSealLabel: x.firstSealLabel,
    nuclearLevel: x.nuclearLevel || 'low',
    nuclearScore: x.nuclearScore || 0,
    nuclearShort: x.nuclearShort || '',
    blowCount: x.blowCount,
    turnover: x.turnover,
    amount: x.amount,
    amountRatio: x.amountRatio,
    volRatio: x.volRatio,
    score: Number.isFinite(alertScore) ? alertScore : x.score,
    alertScore: x.alertScore != null ? alertScore : null,
    auctionScore: x.score,
    scoreLabel: '预警分',
    geneScore: x.geneScore,
    nodeLabel: x.nodeLabel,
    statusLabel:
      x.statusLabel || (intraday ? '盘中推荐 · 未封板' : '竞价预警 · 未涨停'),
    stageKey: payload.stage ? payload.stage.key : '',
    stageLabel: win && win.open ? win.label : payload.stage ? payload.stage.label : '',
    windowKey: win ? win.key : '',
    windowLabel: win ? win.label : '',
    alertMode: x.alertMode || (intraday ? 'intraday' : 'auction'),
    intraday,
    tradeDateLabel: payload.tradeDateLabel || '',
    tags: Array.isArray(x.tags) ? x.tags.slice(0, 4) : [],
    reasons: Array.isArray(x.reasons) ? x.reasons.slice(0, 4) : [],
    risks: Array.isArray(x.risks) ? x.risks.slice(0, 3) : [],
    catalyst: cat,
    /* 催化有效只是必要条件；板块三关未过仍是观察，不静默放宽 */
    actionable: cat.state === 'valid' && !!x.sectorReady,
    read: false
  }
}

function buildSummary(alerts, payload) {
  const at = Date.now()
  return {
    id: `summary:${at}`,
    summary: true,
    at,
    time: stampOf(at),
    date: payload.tradeDate || '',
    dateLabel: shortDate(payload.tradeDate),
    stageKey: payload.stage ? payload.stage.key : '',
    stageLabel: payload.stage ? payload.stage.label : '',
    intraday: !!payload.intraday,
    statusLabel: payload.intraday ? '盘中快照' : '竞价快照',
    names: alerts.map((x) => `${x.name} ${x.score}`),
    actionableCount: alerts.filter((x) => x.actionable).length,
    pendingCount: alerts.filter((x) => !x.actionable).length,
    read: false
  }
}

function addToHistory(alert, { silent = false } = {}) {
  if (!alert.test) markSeen(alert.key)
  if (alertState.centerOpen) alert.read = true
  alertState.history.unshift(alert)
  if (alertState.history.length > MAX_HISTORY) {
    alertState.history.length = MAX_HISTORY
  }
  persistHistory()
  if (silent || alertState.centerOpen) return
  if (alertState.current) {
    alertState.queue.push(alert)
  } else {
    alertState.current = alert
    beep()
  }
  notifyDesktop(alert)
}

function refreshCatalystStates() {
  let changed = false
  for (const item of alertState.history) {
    if (!item || item.test || !item.sectorKey) continue
    const next = catalystStateFor(item.sectorKey)
    const actionable = next.state === 'valid'
    if (
      item.catalyst &&
      item.catalyst.state === next.state &&
      item.catalyst.label === next.label &&
      item.actionable === actionable
    ) {
      continue
    }
    item.catalyst = next
    item.actionable = actionable
    changed = true
  }
  if (changed) persistHistory()
}

/* 只读服务端留痕：午间冻结 / 页面没开 / 收盘后复盘也能看到最近一轮漏斗 */
let diagPromise = null
export function refreshAlertDiagnostics() {
  if (diagPromise) return diagPromise
  diagPromise = (async () => {
    try {
      const data = await getAlertDiagnostics()
      if (data && data.diagnostics) {
        alertState.diagnostics = {
          ...data.diagnostics,
          polls: data.polls || null,
          fetchedAt: Date.now()
        }
      } else {
        alertState.diagnostics = null
      }
      alertState.diagnosticsTail = (data && data.tail) || null
      alertState.diagnosticsAt = Date.now()
    } catch (e) {
      /* 留痕读取失败不影响实时预警 */
    } finally {
      diagPromise = null
    }
  })()
  return diagPromise
}

/* 尾盘预期不是个股买入预警：每天最多弹一次 3 只汇总，只作明日观察 */
function tailSummaryOf(tail, payload) {
  const at = Date.now()
  const items = (tail.items || []).filter((x) => x && x.code).slice(0, 3)
  return {
    id: `tail:${at}`,
    key: `tail:${payload.tradeDate || 'live'}`,
    summary: true,
    tailSummary: true,
    at,
    time: stampOf(at),
    date: payload.tradeDate || '',
    dateLabel: shortDate(payload.tradeDate),
    stageKey: 'tail',
    stageLabel: '尾盘 14:30–15:00',
    intraday: true,
    statusLabel: '尾盘预期 · 明日观察',
    names: items.map((x) => `${x.name} ${x.score}`),
    actionableCount: 0,
    pendingCount: items.length,
    read: false
  }
}

function maybeTailAlert(payload) {
  const tail = payload && payload.tail
  if (!tail || !tail.active || tail.status !== 'ready') return
  if (!Array.isArray(tail.items) || !tail.items.length) return
  const key = `tail:${payload.tradeDate || 'live'}`
  if (seenKeys.includes(key)) return
  if (alertState.centerOpen) return
  markSeen(key)
  const summary = tailSummaryOf(tail, payload)
  if (alertState.current) {
    alertState.queue.push(summary)
  } else {
    alertState.current = summary
    beep()
    notifyDesktop(summary)
  }
}

export function evaluateAlerts(payload) {
  if (!payload || payload.ok === false) return
  alertState.lastCheckAt = Date.now()
  alertState.lastError = ''
  refreshCatalystStates()
  alertState.windowOpen = !!(payload.active && payload.window && payload.window.open)
  alertState.windowKey = payload.window ? payload.window.key || '' : ''
  alertState.funnel = payload.funnel || null
  alertState.tail = payload.tail || null
  if (!payload.active) return

  /* 推荐榜与弹窗分开：即使弹窗关闭，当天推荐记录也能继续保留 */
  if (Array.isArray(payload.board)) {
    ingestRecommendations(payload.board, {
      tradeDate: payload.tradeDate,
      tradeDateLabel: payload.tradeDateLabel,
      stage: payload.stage,
      intraday: payload.intraday,
      pruneActive: payload.boardReady !== false
    })
  }

  if (!alertState.enabled) return

  /* 阈值与未封板过滤由后端统一执行，前端不再二次改口径 */
  const items = (payload.items || []).filter((x) => x && x.code)
  const fresh = []
  for (const x of items) {
    const dateKey = payload.tradeDate || 'live'
    const key = `${dateKey}:${x.code}`
    if (seenKeys.includes(key)) continue
    if (alertState.history.some((h) => h.key === key && !h.test)) continue
    const cat = catalystStateFor(x.sectorKey)
    if (cat.state === 'rumor') continue
    if (!alertState.includePending && cat.state !== 'valid') continue
    fresh.push(makeAlert(x, payload, key, cat))
  }

  if (!alertState.seeded) {
    alertState.seeded = true
    if (fresh.length) {
      fresh.forEach((item) => addToHistory(item, { silent: true }))
      const summary = buildSummary(fresh, payload)
      if (alertState.centerOpen) return
      if (alertState.current) alertState.queue.push(summary)
      else alertState.current = summary
      return
    }
    maybeTailAlert(payload)
    return
  }

  fresh.forEach((item) => addToHistory(item))
  maybeTailAlert(payload)
}

export function dismissAlert() {
  if (alertState.queue.length) alertState.current = alertState.queue.shift()
  else alertState.current = null
}

export function openAlertCenter() {
  alertState.centerOpen = true
  alertState.current = null
  alertState.queue = []
  markAllRead()
}

export function closeAlertCenter() {
  alertState.centerOpen = false
}

export function markAllRead() {
  let changed = false
  for (const item of alertState.history) {
    if (!item.read) {
      item.read = true
      changed = true
    }
  }
  if (changed) persistHistory()
}

export function updateAlertSettings(patch) {
  if (!patch || typeof patch !== 'object') return
  Object.assign(alertState, patch)
  persistSettings()
  if (alertState.enabled === false) {
    alertState.current = null
    alertState.queue = []
  }
}

export function setAlertError(message) {
  alertState.lastError = message || ''
}

export function clearAlertHistory() {
  alertState.history = []
  alertState.recommendations = []
  alertState.recommendationDate = ''
  alertState.recommendationDateLabel = ''
  alertState.current = null
  alertState.queue = []
  persistHistory()
  persistRecommendations(true)
}

export function testAlert() {
  const at = Date.now()
  const sample = {
    id: `test:${at}`,
    key: `test:${at}`,
    test: true,
    at,
    time: stampOf(at),
    date: '',
    dateLabel: '自检',
    code: '000000',
    name: '预警自检',
    sector: '本地测试',
    sectorKey: '',
    fromPool: true,
    lbc: 2,
    price: null,
    pct: 5.6,
    limitUp: null,
    gapToLimit: 4.4,
    sealed: false,
    buyable: true,
    sealRatio: null,
    firstSealLabel: '09:35',
    blowCount: 0,
    turnover: 6.2,
    amount: 68000000,
    amountRatio: 6.2,
    score: 86,
    alertScore: 86,
    auctionScore: 78,
    scoreLabel: '预警分',
    geneScore: 72,
    nodeLabel: '测试节点',
    statusLabel: '竞价锁定 · 未涨停',
    stageKey: 'locked',
    stageLabel: '9:20–9:25 不可撤单',
    windowKey: 'locked',
    windowLabel: '9:20–9:25 不可撤单',
    intraday: false,
    tags: ['弹窗测试', '不对应真实个股'],
    reasons: ['竞价 +5.60% · 距涨停 4.4 个点，未涨停仍可挂单。'],
    risks: ['自检数据，不对应任何真实股票，不构成买入信号。'],
    catalyst: { state: 'pending', label: '测试数据' },
    actionable: false,
    read: false
  }
  alertState.history.unshift(sample)
  alertState.current = sample
  alertState.centerOpen = false
  beep()
}

export const alertStatusText = computed(() => {
  if (!alertState.enabled) return '预警已关闭'
  if (alertState.lastError) return `检查失败：${alertState.lastError}`
  if (!alertState.lastCheckAt) return '等待交易时段'
  return `最近检查 ${stampOf(alertState.lastCheckAt)}`
})