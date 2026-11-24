import { reactive, computed } from 'vue'
import { catalystType, getCatalyst, isCatalystValid } from './catalysts'

const SETTINGS_KEY = 'longmai.alerts.settings.v1'
const HISTORY_KEY = 'longmai.alerts.history.v1'
const SEEN_KEY = 'longmai.alerts.seen.v1'
const MAX_HISTORY = 80
const MAX_SEEN = 400
const ALERT_SCORE = 72

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

/* 去重键与展示记录分开保存：用户清空记录后，同一只票当天仍不会再次弹窗 */
const seenKeys = readSeen()

export const alertState = reactive({
  ...readSettings(),
  history: readHistory(),
  current: null,
  queue: [],
  centerOpen: false,
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
      `${alert.actionable ? '可执行预警' : '观察预警'} · ${alert.name}`,
      {
        body: `${alert.sector} · ${alert.statusLabel} · ${alert.score} 分\n${
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
  return {
    id: `${key}:${at}`,
    key,
    at,
    time: stampOf(at),
    date: payload.tradeDate || '',
    dateLabel: shortDate(payload.tradeDate),
    code: x.code,
    name: x.name,
    sector: x.sector || '未分类',
    sectorKey: x.sectorKey || '',
    sectorHeat: x.sectorHeat,
    sectorTodayCount: x.sectorTodayCount,
    sectorReady: !!x.sectorReady,
    lbc: x.lbc,
    price: x.price,
    pct: x.pct,
    limitUp: x.limitUp,
    gapToLimit: x.gapToLimit,
    sealed: !!x.sealed,
    sealRatio: x.sealRatio,
    sealFund: x.sealFund == null ? null : x.sealFund,
    firstSealLabel: x.firstSealLabel,
    blowCount: x.blowCount,
    turnover: x.turnover,
    amount: x.amount,
    amountRatio: x.amountRatio,
    score: x.score,
    geneScore: x.geneScore,
    nodeLabel: x.nodeLabel,
    statusLabel: x.statusLabel || (payload.intraday ? '封板确认' : '竞价确认'),
    stageKey: payload.stage ? payload.stage.key : '',
    stageLabel: payload.stage ? payload.stage.label : '',
    intraday: !!payload.intraday,
    tradeDateLabel: payload.tradeDateLabel || '',
    tags: Array.isArray(x.tags) ? x.tags.slice(0, 4) : [],
    reasons: Array.isArray(x.reasons) ? x.reasons.slice(0, 4) : [],
    risks: Array.isArray(x.risks) ? x.risks.slice(0, 3) : [],
    catalyst: cat,
    actionable: cat.state === 'valid',
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
    statusLabel: '当前快照',
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

export function evaluateAlerts(payload) {
  if (!payload || payload.ok === false) return
  alertState.lastCheckAt = Date.now()
  alertState.lastError = ''
  refreshCatalystStates()
  if (!alertState.enabled || !payload.active) return

  const items = (payload.items || []).filter(
    (x) => x && x.code && Number(x.score) >= ALERT_SCORE
  )
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
    if (!fresh.length) return
    fresh.forEach((item) => addToHistory(item, { silent: true }))
    const summary = buildSummary(fresh, payload)
    if (alertState.centerOpen) return
    if (alertState.current) alertState.queue.push(summary)
    else alertState.current = summary
    return
  }

  fresh.forEach((item) => addToHistory(item))
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
  alertState.current = null
  alertState.queue = []
  persistHistory()
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
    lbc: 2,
    price: null,
    pct: 6.8,
    limitUp: null,
    sealed: true,
    sealRatio: 1.8,
    firstSealLabel: '09:35',
    blowCount: 0,
    turnover: 6.2,
    score: 88,
    geneScore: 72,
    nodeLabel: '测试节点',
    statusLabel: '弹窗测试',
    stageKey: 'test',
    stageLabel: '本地自检',
    intraday: true,
    tags: ['弹窗测试', '不对应真实个股'],
    reasons: ['如果你看到这张卡片，说明实时预警弹窗工作正常。'],
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