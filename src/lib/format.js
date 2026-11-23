export function fmtMoney(v, { sign = true, digits = 2 } = {}) {
  if (v == null || !Number.isFinite(Number(v))) return '--'
  const n = Number(v)
  const abs = Math.abs(n)
  let text
  if (abs >= 1e8) text = `${(abs / 1e8).toFixed(digits)}亿`
  else if (abs >= 1e4) text = `${(abs / 1e4).toFixed(0)}万`
  else text = `${abs.toFixed(0)}`
  if (!sign) return n < 0 ? `-${text}` : text
  return `${n > 0 ? '+' : n < 0 ? '-' : ''}${text}`
}

export function fmtNum(v, digits = 0) {
  if (v == null || !Number.isFinite(Number(v))) return '--'
  return Number(v).toFixed(digits)
}

export function fmtPct(v, { digits = 2, sign = true } = {}) {
  if (v == null || !Number.isFinite(Number(v))) return '--'
  const n = Number(v)
  return `${sign && n > 0 ? '+' : ''}${n.toFixed(digits)}%`
}

export function fmtPrice(v) {
  if (v == null || !Number.isFinite(Number(v))) return '--'
  return Number(v).toFixed(2)
}

export function fmtCap(v) {
  if (v == null || !Number.isFinite(Number(v))) return '--'
  if (v >= 1e12) return `${(v / 1e12).toFixed(2)}万亿`
  return `${(v / 1e8).toFixed(0)}亿`
}

export function fmtClock(seconds) {
  if (seconds == null) return '--'
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  return `${(seconds / 3600).toFixed(1)}h`
}

export function upDown(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n === 0) return 'flat'
  return n > 0 ? 'up' : 'down'
}

export function pctTone(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return ''
  return n > 0 ? 'is-up' : n < 0 ? 'is-down' : ''
}

export function roleClass(role) {
  return `role-${role || 'vanguard'}`
}

export function heatTone(heat) {
  if (heat >= 80) return 'hot'
  if (heat >= 60) return 'warm'
  if (heat >= 40) return 'mild'
  return 'cold'
}

export function timeLabel(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function shortDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function sealTag(seconds) {
  if (!seconds) return ''
  const s = String(seconds).padStart(6, '0')
  return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`
}