'use strict'

const https = require('https')
const http = require('http')
const zlib = require('zlib')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'

function requestRaw(url, { timeout = 12000, referer = 'https://quote.eastmoney.com/' } = {}) {
  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch (err) {
      reject(err)
      return
    }
    const lib = parsed.protocol === 'http:' ? http : https
    const req = lib.request(
      parsed,
      {
        method: 'GET',
        timeout,
        headers: {
          'User-Agent': UA,
          Referer: referer,
          Accept: 'application/json,text/plain,*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Accept-Encoding': 'gzip, deflate',
          Connection: 'keep-alive'
        }
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          requestRaw(res.headers.location, { timeout, referer }).then(resolve, reject)
          return
        }
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`HTTP ${res.statusCode} ${parsed.host}${parsed.pathname}`))
          return
        }
        const chunks = []
        let stream = res
        const enc = String(res.headers['content-encoding'] || '')
        if (enc.includes('gzip')) stream = res.pipe(zlib.createGunzip())
        else if (enc.includes('deflate')) stream = res.pipe(zlib.createInflate())
        stream.on('data', (d) => chunks.push(d))
        stream.on('end', () => resolve(Buffer.concat(chunks)))
        stream.on('error', reject)
      }
    )
    req.on('timeout', () => req.destroy(new Error(`请求超时 ${parsed.host}`)))
    req.on('error', reject)
    req.end()
  })
}

async function fetchText(url, opts = {}) {
  const buf = await requestRaw(url, opts)
  return buf.toString('utf8')
}

async function fetchJson(url, opts = {}) {
  const attempts = (opts.retries == null ? 1 : opts.retries) + 1
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      const buf = await requestRaw(url, opts)
      const text = buf.toString('utf8').trim()
      if (!text) throw new Error('上游返回空响应')
      if (text[0] !== '{' && text[0] !== '[') {
        throw new Error(`上游返回非 JSON：${text.slice(0, 80)}`)
      }
      return JSON.parse(text)
    } catch (err) {
      lastErr = err
      if (i < attempts - 1) await sleep(220 + i * 260)
    }
  }
  throw lastErr
}

const cache = new Map()
const inflight = new Map()

async function cached(key, ttl, loader) {
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && now - hit.at < ttl) return hit.value
  if (inflight.has(key)) return inflight.get(key)
  const task = (async () => {
    try {
      const value = await loader()
      cache.set(key, { at: Date.now(), value })
      return value
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, task)
  return task
}

function primeCache(key, value) {
  cache.set(key, { at: Date.now(), value })
}

function cacheAge(key) {
  const hit = cache.get(key)
  return hit ? Date.now() - hit.at : null
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function beijingNow(ts = Date.now()) {
  const src = new Date(ts)
  const bj = new Date(src.getTime() + (8 * 60 + src.getTimezoneOffset()) * 60000)
  return bj
}

function dateStamp(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

function dateDashed(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function pad(n) {
  return String(n).padStart(2, '0')
}

function addDays(stamp, delta) {
  const y = Number(stamp.slice(0, 4))
  const m = Number(stamp.slice(4, 6))
  const d = Number(stamp.slice(6, 8))
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + delta)
  return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}`
}

function weekdayOf(stamp) {
  const y = Number(stamp.slice(0, 4))
  const m = Number(stamp.slice(4, 6))
  const d = Number(stamp.slice(6, 8))
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

function isWeekend(stampOrDate) {
  if (typeof stampOrDate === 'string') return [0, 6].includes(weekdayOf(stampOrDate))
  return [0, 6].includes(stampOrDate.getDay())
}

function marketStatus(now = beijingNow()) {
  const weekday = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()]
  const mins = now.getHours() * 60 + now.getMinutes()
  if (isWeekend(now)) {
    return { key: 'closed', label: '周末休市', live: false, weekday, mins, now: hhmm(now) }
  }
  if (mins < 9 * 60 + 15) return { key: 'preopen', label: '盘前', live: false, weekday, mins, now: hhmm(now) }
  if (mins < 9 * 60 + 25) return { key: 'auction', label: '集合竞价', live: true, weekday, mins, now: hhmm(now) }
  if (mins < 9 * 60 + 30) return { key: 'waiting', label: '待开盘', live: true, weekday, mins, now: hhmm(now) }
  if (mins < 11 * 60 + 30) return { key: 'morning', label: '盘中', live: true, weekday, mins, now: hhmm(now) }
  if (mins < 13 * 60) return { key: 'lunch', label: '午间休市', live: false, weekday, mins, now: hhmm(now) }
  if (mins < 15 * 60) return { key: 'afternoon', label: '盘中', live: true, weekday, mins, now: hhmm(now) }
  return { key: 'closed', label: '已收盘', live: false, weekday, mins, now: hhmm(now) }
}

function hhmm(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function clamp(v, min = 0, max = 100) {
  if (!Number.isFinite(v)) return min
  return Math.min(max, Math.max(min, v))
}

function round(v, digits = 0) {
  const p = Math.pow(10, digits)
  return Math.round(v * p) / p
}

function num(v, fallback = null) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function safeDivide(a, b, fallback = 0) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return fallback
  return a / b
}

function stripLevel(name) {
  return String(name || '')
    .replace(/[ⅡⅢ]/g, '')
    .replace(/\s+/g, '')
    .trim()
}

/* 双创 20cm：科创板 688/689、创业板 300/301；推荐与预警默认剔除 */
function is20cmCode(code) {
  return /^(300|301|688|689)/.test(String(code || ''))
}

module.exports = {
  UA,
  requestRaw,
  fetchText,
  fetchJson,
  cached,
  primeCache,
  cacheAge,
  sleep,
  beijingNow,
  dateStamp,
  dateDashed,
  addDays,
  weekdayOf,
  isWeekend,
  marketStatus,
  hhmm,
  clamp,
  round,
  num,
  safeDivide,
  stripLevel,
  is20cmCode
}