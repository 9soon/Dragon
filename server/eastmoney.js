'use strict'

const fs = require('fs')
const path = require('path')
const { fetchJson, requestRaw, cached, num, dateStamp, addDays, isWeekend, sleep } = require('./util')

const UT_QUOTE = 'fa5fd1943c7b386f172d6893dbfba10b'
const UT_FLOW = 'b2884a393a59ad64002292a3e90d46a5'
const UT_POOL = '7eea3edcaed734bea9cbfc24409ed989'

const QUOTE_FIELDS =
  'f1,f2,f3,f4,f5,f6,f8,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f62,f100,f184,' +
  'f104,f105,f128,f136,f140,f164,f174'
const BOARD_FIELDS =
  'f3,f12,f14,f62,f104,f105,f128,f136,f140,f164,f174,f184'

/* 部分网络下 push2 / push2his 的 CDN 节点会被重置，push2test 与主站同源同数据，作为自动兜底 */
const EM_FALLBACK_HOSTS = {
  'push2.eastmoney.com': 'push2test.eastmoney.com',
  'push2his.eastmoney.com': 'push2test.eastmoney.com'
}
/* 主节点被重置后 2 分钟内直接走备用节点，避免每次请求都白等一次失败 */
const hostDownUntil = new Map()

function fallbackUrl(url) {
  try {
    const u = new URL(url)
    const host = EM_FALLBACK_HOSTS[u.host]
    if (!host) return null
    u.host = host
    return { host: new URL(url).host, alt: u.toString() }
  } catch (e) {
    return null
  }
}

async function emFetch(url, opts = {}) {
  const fb = fallbackUrl(url)
  if (fb && (hostDownUntil.get(fb.host) || 0) > Date.now()) {
    return fetchJson(fb.alt, opts)
  }
  try {
    const data = await fetchJson(url, opts)
    if (fb) hostDownUntil.delete(fb.host)
    return data
  } catch (err) {
    if (!fb) throw err
    try {
      const data = await fetchJson(fb.alt, opts)
      hostDownUntil.set(fb.host, Date.now() + 1000 * 120)
      return data
    } catch (err2) {
      err2.message = `${err.message}；备用节点失败：${err2.message}`
      throw err2
    }
  }
}

async function getPool(date, kind = 'zt') {
  const today = dateStamp(new Date())
  const ttl = date === today ? 8000 : 1000 * 60 * 60
  return cached(`pool:${kind}:${date}`, ttl, async () => {
    const action =
      kind === 'zb' ? 'getTopicZBPool' : kind === 'dt' ? 'getTopicDTPool' : 'getTopicZTPool'
    const url =
      `https://push2ex.eastmoney.com/${action}?ut=${UT_POOL}&dpt=wz.ztzt` +
      `&Pageindex=0&pagesize=300&sort=fbt%3Aasc&date=${date}&_=${Date.now()}`
    const json = await fetchJson(url, { timeout: 12000 })
    if (!json || json.rc !== 0 || !json.data) {
      return { date, total: 0, items: [] }
    }
    const list = Array.isArray(json.data.pool) ? json.data.pool : []
    return {
      date,
      marketDate: String(json.data.qdate || date),
      total: num(json.data.tc, list.length),
      items: list.map((x) => normalizePoolItem(x, kind))
    }
  })
}

function normalizePoolItem(x, kind) {
  const market = x.m === 1 ? 1 : 0
  const rawPrice = num(x.p, 0)
  return {
    code: String(x.c || ''),
    market,
    secid: `${market}.${x.c}`,
    name: String(x.n || ''),
    price: rawPrice / 1000,
    pct: num(x.zdp, 0),
    amount: num(x.amount, 0),
    floatCap: num(x.ltsz, 0),
    totalCap: num(x.tshare, 0),
    turnover: num(x.hs, 0),
    lbc: Math.max(1, num(x.lbc, 1)),
    firstSeal: num(x.fbt, 0),
    lastSeal: num(x.lbt, 0),
    sealFund: kind === 'zt' ? num(x.fund, 0) : 0,
    blowCount: num(x.zbc, 0),
    sector: String(x.hybk || ''),
    ztDays: num(x.zttj && x.zttj.days, 0),
    ztCount: num(x.zttj && x.zttj.ct, 0),
    limitPrice: kind === 'zb' ? num(x.ztp, 0) / 1000 : num(x.p, 0) / 1000
  }
}

async function findPoolBack(date, { includeSelf = true, maxBack = 12 } = {}) {
  let cursor = includeSelf ? date : addDays(date, -1)
  for (let i = 0; i < maxBack; i++) {
    if (!isWeekend(cursor)) {
      const pool = await getPool(cursor, 'zt')
      if (pool.items.length) return { ...pool, date: cursor }
    }
    cursor = addDays(cursor, -1)
  }
  return null
}

async function getLatestTradingPool(today) {
  return findPoolBack(today, { includeSelf: true, maxBack: 12 })
}

async function getPrevTradingPool(date) {
  return findPoolBack(date, { includeSelf: false, maxBack: 10 })
}

const catalogFile = path.join(__dirname, 'data', 'boards.json')
let catalogCache = null
let liveBoards = null
let liveBoardsAt = 0
let lastBoardTry = 0
let boardRefreshing = false

function loadBoardCatalog() {
  if (catalogCache) return catalogCache
  try {
    const raw = JSON.parse(require('fs').readFileSync(catalogFile, 'utf8'))
    catalogCache = (raw.boards || []).map((b) => normalizeBoard(b))
  } catch (err) {
    catalogCache = []
  }
  return catalogCache
}

function normalizeBoard(b) {
  return {
    code: String(b.f12 || b.code || ''),
    name: String(b.f14 || b.name || ''),
    secid: `90.${b.f12 || b.code}`,
    pct: num(b.f3, null),
    todayFlow: num(b.f62, null),
    /* 备用节点会把 f164/f174 填成今日值；5 日累计只认日线资金历史 */
    flow5d: null,
    flow10d: null,
    flowPct: num(b.f184, null),
    upCount: num(b.f104, null),
    downCount: num(b.f105, null),
    leadName: String(b.f128 || ''),
    leadCode: String(b.f140 || ''),
    leadPct: num(b.f136, null)
  }
}

async function refreshBoardsInBackground() {
  if (boardRefreshing || Date.now() - lastBoardTry < 1000 * 60) return
  boardRefreshing = true
  lastBoardTry = Date.now()
  try {
    const first = await fetchBoardPage(1)
    const total = first.total || (first.items || []).length
    if (!total) throw new Error('板块目录为空')
    const pages = Math.max(1, Math.ceil(total / 500))
    const items = first.items.slice()
    for (let p = 2; p <= pages; p++) {
      const page = await fetchBoardPage(p)
      items.push(...(page.items || []))
    }
    if (items.length < 50) throw new Error('板块目录异常')
    liveBoards = items.map(normalizeBoard)
    liveBoardsAt = Date.now()
  } catch (err) {
    /* 内置目录兜底；接口恢复后会自动替换 */
  } finally {
    boardRefreshing = false
  }
}

function mergeBoards(live, catalog) {
  const map = new Map()
  for (const b of catalog) map.set(b.code, b)
  for (const b of live) {
    const prev = map.get(b.code)
    map.set(b.code, prev ? { ...prev, ...b } : b)
  }
  return Array.from(map.values())
}

async function getBoards() {
  const catalog = loadBoardCatalog()
  if (liveBoards) {
    /* 线上目录可能只抓到部分行业，内置目录兜底补全，
     * 否则板块映射会时有时无（资金证据跟着变 unknown） */
    if (Date.now() - liveBoardsAt >= 1000 * 60 * 30) refreshBoardsInBackground()
    return mergeBoards(liveBoards, catalog)
  }
  refreshBoardsInBackground()
  return catalog
}

async function getBoardQuotes(boardSecids) {
  if (!boardSecids || !boardSecids.length) return []
  const result = await batchQuotes(boardSecids)
  return result.items || []
}

/**
 * 全市场实时涨幅榜（沪深 A 股，剔除 ST / 退市整理）。
 * 竞价阶段 f3 是集合竞价参考涨幅；盘中是实时涨幅。
 * 用于抓“昨天炸板/跌停，今天弱转强”的非涨停池个股，避免只看昨日涨停池。
 */
async function scanMarketLeaders(limit = 80) {
  const size = Math.max(20, Math.min(100, Number(limit) || 80))
  return cached(`scan:leaders:${size}`, 1800, async () => {
    const url =
      `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=${size}&po=1&np=1` +
      `&ut=${UT_QUOTE}&fltt=2&invt=2&fid=f3` +
      `&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23` +
      `&fields=${QUOTE_FIELDS}&_=${Date.now()}`
    const json = await emFetch(url, { timeout: 10000 })
    const diff = json && json.data && json.data.diff
    if (!Array.isArray(diff)) return { items: [], at: Date.now() }
    const items = diff
      .map(normalizeQuote)
      .filter(
        (q) =>
          q &&
          q.code &&
          /^\d{6}$/.test(q.code) &&
          !/ST|退/i.test(q.name || '') &&
          q.pct != null
      )
    return { items, at: Date.now() }
  })
}

/**
 * 尾盘“明日超预期”专用扫描：只在中低位找今天没涨停、但日内走强且板块有涨停核心的票。
 * 不能沿用涨幅榜（那天然是高位），这里按成交额 + 换手率各取一批活跃股，再去重过滤。
 * 只做尾盘扫描，不并入竞价 / 盘中预警主榜。
 */
async function scanTailSurprises(limit = 120) {
  const size = Math.max(40, Math.min(150, Number(limit) || 120))
  return cached(`scan:tail-surprises:${size}`, 25000, async () => {
    const buildUrl = (fid) =>
      `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=${size}&po=1&np=1` +
      `&ut=${UT_QUOTE}&fltt=2&invt=2&fid=${fid}` +
      `&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23` +
      `&fields=${QUOTE_FIELDS}&_=${Date.now()}`
    const [amountRes, turnoverRes] = await Promise.allSettled([
      emFetch(buildUrl('f6'), { timeout: 10000 }),
      emFetch(buildUrl('f8'), { timeout: 10000 })
    ])
    const seen = new Set()
    const items = []
    for (const res of [amountRes, turnoverRes]) {
      if (res.status !== 'fulfilled') continue
      const diff = res.value && res.value.data && res.value.data.diff
      if (!Array.isArray(diff)) continue
      for (const d of diff) {
        const q = normalizeQuote(d)
        if (!q || !q.code || seen.has(q.code)) continue
        if (!/^\d{6}$/.test(q.code)) continue
        if (/ST|退/i.test(q.name || '')) continue
        /* 先宽后严：这里只做初级过滤，最终门槛在 edge 的尾盘超预期规则里 */
        if (q.pct == null || q.pct < 0.3 || q.pct > 7) continue
        if (q.amount != null && q.amount < 2e7) continue
        seen.add(q.code)
        items.push({ ...q, tailSource: true })
      }
    }
    return { items, at: Date.now() }
  })
}

async function fetchBoardPage(page) {
  const url =
    `https://push2.eastmoney.com/api/qt/clist/get?pn=${page}&pz=500&po=1&np=1` +
    `&ut=${UT_QUOTE}&fltt=2&invt=2&fid=f3&fs=m:90+t:2+f:!50&fields=${BOARD_FIELDS}&_=${Date.now()}`
  const json = await emFetch(url, { timeout: 12000 })
  const data = json && json.data
  return {
    total: num(data && data.total, 0),
    items: (data && Array.isArray(data.diff) ? data.diff : []) || []
  }
}

const quoteCache = new Map()
const quoteInflight = new Map()

function normalizeQuote(d) {
  const code = String(d.f12 || '')
  const inferred = /^6/.test(code) ? 1 : 0
  const market = d.f13 != null ? Number(d.f13) : inferred
  return {
    secid: `${market}.${code}`,
    code,
    name: String(d.f14 || ''),
    price: num(d.f2, null),
    pct: num(d.f3, null),
    change: num(d.f4, null),
    volume: num(d.f5, null),
    amount: num(d.f6, null),
    turnover: num(d.f8, null),
    volRatio: num(d.f10, null),
    high: num(d.f15, null),
    low: num(d.f16, null),
    open: num(d.f17, null),
    prevClose: num(d.f18, null),
    totalCap: num(d.f20, null),
    floatCap: num(d.f21, null),
    mainInflow: num(d.f62, null),
    industry: d.f100 != null ? String(d.f100) : '',
    mainPct: num(d.f184, null),
    flow5d: num(d.f164, null),
    flow10d: num(d.f174, null),
    upCount: num(d.f104, null),
    downCount: num(d.f105, null),
    leadName: d.f128 != null ? String(d.f128) : '',
    leadCode: d.f140 != null ? String(d.f140) : '',
    leadPct: num(d.f136, null)
  }
}

const { TextDecoder } = require('util')
let gbkDecoder = null
function decodeGbk(buf) {
  try {
    if (!gbkDecoder) gbkDecoder = new TextDecoder('gbk')
    return gbkDecoder.decode(buf)
  } catch (err) {
    return buf.toString('latin1')
  }
}

function tencentSymbol(secid) {
  const code = String(secid || '').split('.')[1] || ''
  if (!/^\d{6}$/.test(code)) return null
  if (String(secid).startsWith('1.')) return `sh${code}`
  if (/^[48]/.test(code)) return `bj${code}`
  return `sz${code}`
}

const tqCache = new Map()
const tqInflight = new Map()

async function tencentQuotes(secids) {
  const pairs = []
  for (const secid of secids || []) {
    const sym = tencentSymbol(secid)
    if (sym) pairs.push({ secid, sym })
  }
  if (!pairs.length) return []
  const key = pairs.map((p) => p.sym).sort().join(',')
  const hit = tqCache.get(key)
  if (hit && Date.now() - hit.at < 800) return hit.items
  if (tqInflight.has(key)) return tqInflight.get(key)
  const task = (async () => {
    try {
      const url = `https://qt.gtimg.cn/q=${pairs.map((p) => p.sym).join(',')}`
      const buf = await requestRaw(url, { timeout: 6000, referer: 'https://gu.qq.com/' })
      const text = decodeGbk(buf)
      const bySym = new Map(pairs.map((p) => [p.sym, p.secid]))
      const items = []
      const re = /v_((?:sh|sz|bj)\d{6})="([^"]*)"/g
      let m
      while ((m = re.exec(text))) {
        const sym = m[1]
        const secid = bySym.get(sym)
        if (!secid) continue
        const f = String(m[2]).split('~')
        if (!f || f.length < 50) continue
        const amountWan = num(f[37], null)
        const floatCapYi = num(f[44], null)
        const totalCapYi = num(f[45], null)
        const t = String(f[30] || '')
        const limitUp = num(f[47], null)
        const limitDown = num(f[48], null)
        const priceNow = num(f[3], null)
        const bid1 = num(f[9], null)
        /* 腾讯买一量单位为手；封单金额 = 涨停价 × 买一量 × 100。
           只有最新价与买一价都贴在涨停价时才算封板，炸板后不再返回封单。 */
        const sealed = !!(
          limitUp != null &&
          priceNow != null &&
          bid1 != null &&
          bid1 > 0 &&
          Math.abs(priceNow - limitUp) < 0.005 &&
          Math.abs(bid1 - limitUp) < 0.005 &&
          num(f[10], 0) > 0
        )
        items.push({
          secid,
          code: String(f[2] || ''),
          name: String(f[1] || ''),
          price: priceNow,
          pct: num(f[32], null),
          change: num(f[31], null),
          volume: num(f[6], null),
          amount: amountWan != null ? amountWan * 1e4 : null,
          turnover: num(f[38], null),
          volRatio: num(f[49], null),
          high: num(f[33], null),
          low: num(f[34], null),
          open: num(f[5], null),
          prevClose: num(f[4], null),
          totalCap: totalCapYi != null ? totalCapYi * 1e8 : null,
          floatCap: floatCapYi != null ? floatCapYi * 1e8 : null,
          mainInflow: null,
          mainPct: null,
          flow5d: null,
          flow10d: null,
          upCount: null,
          downCount: null,
          leadName: '',
          leadCode: '',
          leadPct: null,
          limitUp,
          limitDown,
          bid1,
          bid1Vol: num(f[10], null),
          sealed,
          sealFund: sealed ? Math.round(limitUp * num(f[10], 0) * 100) : null,
          quoteTime: t.length === 14 ? `${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}` : '',
          source: 'tencent'
        })
      }
      tqCache.set(key, { at: Date.now(), items })
      if (tqCache.size > 60) tqCache.delete(tqCache.keys().next().value)
      return items
    } finally {
      tqInflight.delete(key)
    }
  })()
  tqInflight.set(key, task)
  return task
}

async function tencentKline(secid, limit = 160) {
  if (!/^\d{1,2}\.\d{6}$/.test(String(secid || ''))) return []
  return cached(`kline:${secid}:${limit}`, 1000 * 60 * 60 * 6, async () => {
    const sym = tencentSymbol(secid)
    if (!sym) return []
    const url =
      `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${sym},day,,,${limit},qfq`
    const buf = await requestRaw(url, { timeout: 10000, referer: 'https://gu.qq.com/' })
    const text = buf.toString('utf8').trim()
    const json = JSON.parse(text)
    const d = (json && json.data && json.data[sym]) || {}
    const rows = d.qfqday || d.day || []
    if (!Array.isArray(rows)) return []
    return rows
      .map((row) => ({
        date: String(row[0] || '').replace(/-/g, ''),
        open: num(row[1], null),
        close: num(row[2], null),
        high: num(row[3], null),
        low: num(row[4], null),
        volume: num(row[5], null)
      }))
      .filter((x) => x.date && x.open != null && x.close != null)
  })
}

const boardQuoteCache = new Map()

async function emBoardQuote(code) {
  const hit = boardQuoteCache.get(code)
  if (hit && Date.now() - hit.at < 3000) return hit.q
  const url =
    `https://push2.eastmoney.com/api/qt/stock/get?secid=90.${code}&fltt=2&invt=2` +
    `&ut=${UT_QUOTE}&fields=f43,f48,f57,f58,f60,f168,f170&_=${Date.now()}`
  const json = await emFetch(url, { timeout: 8000 })
  const d = json && json.data
  if (!d) return null
  const q = {
    secid: `90.${code}`,
    code,
    name: String(d.f58 || ''),
    price: null,
    pct: num(d.f170, null),
    change: null,
    volume: null,
    amount: num(d.f48, null),
    turnover: num(d.f168, null),
    volRatio: null,
    high: null,
    low: null,
    open: null,
    prevClose: num(d.f60, null),
    totalCap: null,
    floatCap: null,
    mainInflow: null,
    mainPct: null,
    flow5d: null,
    flow10d: null,
    upCount: null,
    downCount: null,
    leadName: '',
    leadCode: '',
    leadPct: null,
    source: 'em-single'
  }
  boardQuoteCache.set(code, { at: Date.now(), q })
  return q
}

let ulistDownUntil = 0

const INDEX_SECID_RE = /^(?:1\.000\d{3}|0\.399\d{3})$/

async function batchQuotes(secids, { seal = false } = {}) {
  const clean = Array.from(
    new Set(
      (secids || []).filter((s) => /^\d{1,2}\.(\d{6}|BK\d{4})$/.test(String(s)))
    )
  )
  if (!clean.length) return { items: [], at: Date.now(), stale: false }
  const key = `quotes:${seal ? 'seal:' : ''}${clean.slice().sort().join(',')}`
  const now = Date.now()
  const hit = quoteCache.get(key)
  if (hit && now - hit.at < 850) return { items: hit.items, at: hit.at, stale: false }
  if (quoteInflight.has(key)) return quoteInflight.get(key)
  const task = (async () => {
    try {
      const stockSecids = clean.filter((s) => /\.\d{6}$/.test(s))
      const boardSecids = clean.filter((s) => /\.BK\d{4}$/.test(s))
      const indexSecids = stockSecids.filter((s) => INDEX_SECID_RE.test(s))
      const normalStocks = stockSecids.filter((s) => !INDEX_SECID_RE.test(s))
      /* 封单需要腾讯五档买一量，与东财报价并行拉取，避免串行等待 */
      const tqTask = seal && normalStocks.length
        ? tencentQuotes(normalStocks).catch(() => [])
        : Promise.resolve([])
      let emItems = []
      if (Date.now() > ulistDownUntil) {
        const chunks = []
        /* 指数单独成块：不受个股分块失败连累，涨跌家数只有指数行情才带 */
        if (indexSecids.length) chunks.push(indexSecids)
        for (let i = 0; i < normalStocks.length; i += 50) {
          chunks.push(normalStocks.slice(i, i + 50))
        }
        if (chunks.length) {
          const results = await Promise.all(
            chunks.map(async (part) => {
              try {
                const url =
                  `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2` +
                  `&ut=${UT_QUOTE}&fields=${QUOTE_FIELDS}&secids=${part.join(',')}&_=${Date.now()}`
                const json = await emFetch(url, { timeout: 8000 })
                const diff = json && json.data && json.data.diff
                return Array.isArray(diff) ? diff.map(normalizeQuote) : []
              } catch (err) {
                /* 单块失败保留其它块，避免一块超时把整批报价打成降级 */
                return []
              }
            })
          )
          emItems = results.flat()
          if (!emItems.length) ulistDownUntil = Date.now() + 60000
        }
      }
      const got = new Set(emItems.map((q) => q.secid))
      const needStocks = stockSecids.filter((s) => !got.has(s))
      const needBoards = boardSecids.filter((s) => !got.has(s))
      const [tqAll, boardItems] = await Promise.all([
        tqTask,
        Promise.all(needBoards.map((s) => emBoardQuote(s.split('.')[1]).catch(() => null)))
      ])
      let tqItems = []
      if (seal) {
        tqItems = needStocks.length ? tqAll.filter((q) => needStocks.includes(q.secid)) : []
      } else if (needStocks.length) {
        tqItems = await tencentQuotes(needStocks).catch(() => [])
      }
      /* 东财负责主力资金，腾讯负责实时价与五档；备用节点给深市返回的现价会滞后，封单场景统一以腾讯为准 */
      let merged = emItems
      if (seal && tqAll.length) {
        const tqMap = new Map(tqAll.map((q) => [q.secid, q]))
        merged = emItems.map((q) => {
          const t = tqMap.get(q.secid)
          if (!t) return q
          const pick = (a, b) => (a != null ? a : b)
          return {
            ...q,
            price: pick(t.price, q.price),
            pct: pick(t.pct, q.pct),
            change: pick(t.change, q.change),
            volume: pick(t.volume, q.volume),
            amount: pick(t.amount, q.amount),
            turnover: pick(t.turnover, q.turnover),
            volRatio: pick(t.volRatio, q.volRatio),
            high: pick(t.high, q.high),
            low: pick(t.low, q.low),
            open: pick(t.open, q.open),
            prevClose: pick(t.prevClose, q.prevClose),
            totalCap: pick(t.totalCap, q.totalCap),
            floatCap: pick(t.floatCap, q.floatCap),
            quoteTime: t.quoteTime || q.quoteTime,
            limitUp: pick(t.limitUp, q.limitUp),
            limitDown: pick(t.limitDown, q.limitDown),
            bid1: t.bid1,
            bid1Vol: t.bid1Vol,
            sealed: t.sealed,
            sealFund: t.sealFund
          }
        })
      }
      const items = merged.concat(tqItems, boardItems.filter(Boolean))
      quoteCache.set(key, { at: Date.now(), items })
      if (quoteCache.size > 120) {
        const oldest = Array.from(quoteCache.keys()).slice(0, 40)
        oldest.forEach((k) => quoteCache.delete(k))
      }
      return { items, at: Date.now(), stale: false }
    } catch (err) {
      if (hit) return { items: hit.items, at: hit.at, stale: true, error: err.message }
      throw err
    } finally {
      quoteInflight.delete(key)
    }
  })()
  quoteInflight.set(key, task)
  return task
}

/* 当日资金与历史资金分开计数：单只板块失败不再连坐整轮，连续失败才短冷却 */
let todayFlowDownUntil = 0
let historyFlowDownUntil = 0
let todayFlowFailStreak = 0
let historyFlowFailStreak = 0
let emQueue = Promise.resolve()

function todayFlowGateDown() {
  return Date.now() < todayFlowDownUntil
}

function historyFlowGateDown() {
  return Date.now() < historyFlowDownUntil
}

function noteFlowFailure(kind, label, err) {
  console.warn(`[flow] ${kind} ${label} 失败：${err.message}`)
  if (kind === 'today') {
    todayFlowFailStreak++
    if (todayFlowFailStreak >= 3) {
      todayFlowDownUntil = Date.now() + 60000
      todayFlowFailStreak = 0
    }
  } else {
    historyFlowFailStreak++
    if (historyFlowFailStreak >= 3) {
      historyFlowDownUntil = Date.now() + 60000
      historyFlowFailStreak = 0
    }
  }
}

function noteFlowOk(kind) {
  if (kind === 'today') todayFlowFailStreak = 0
  else historyFlowFailStreak = 0
}

function emSlot() {
  const p = emQueue.then(() => sleep(160))
  emQueue = p.catch(() => {})
  return p
}

async function getTodayFlow(secid) {
  const code = String(secid || '')
  if (!/^\d{1,2}\.(?:\d{6}|BK\d{4})$/.test(code)) return null
  return cached(`todayflow:${code}`, 20000, async () => {
    if (todayFlowGateDown()) throw new Error('资金接口冷却中')
    await emSlot()
    const url =
      `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2` +
      `&secids=${code}&ut=${UT_QUOTE}&fields=f62,f124&_=${Date.now()}`
    let json
    try {
      json = await emFetch(url, { timeout: 8000 })
      noteFlowOk('today')
    } catch (err) {
      noteFlowFailure('today', code, err)
      throw err
    }
    const diff = json && json.data && json.data.diff
    const row = Array.isArray(diff) ? diff[0] : null
    if (!row) return null
    const main = num(row.f62, null)
    const ts = num(row.f124, null)
    const date = ts ? dateStamp(new Date(ts * 1000)) : ''
    if (main == null || !date) return null
    return { main, date }
  })
}

const FLOW_FILE = path.join(__dirname, '..', '.cache', 'flow-daily.json')
let flowDaily = null
let flowWriteAt = 0

function loadFlowDaily() {
  if (flowDaily) return flowDaily
  try {
    flowDaily = JSON.parse(fs.readFileSync(FLOW_FILE, 'utf8')) || {}
  } catch (err) {
    flowDaily = {}
  }
  return flowDaily
}

function recordFlow(code, date, main) {
  if (!code || !date || main == null) return
  const store = loadFlowDaily()
  if (!store[date]) store[date] = {}
  store[date][code] = main
  if (Date.now() - flowWriteAt > 45000) {
    flowWriteAt = Date.now()
    try {
      fs.mkdirSync(path.dirname(FLOW_FILE), { recursive: true })
      fs.writeFileSync(FLOW_FILE, JSON.stringify(store))
    } catch (err) {
      /* 本地资金快照写入失败不影响主流程 */
    }
  }
}

function storedFlow(code, date) {
  const store = loadFlowDaily()
  const day = store[date]
  return day && day[code] != null ? day[code] : null
}

async function getFlowHistory(boardCode) {
  return cached(`flowhist:${boardCode}`, 1000 * 60 * 10, async () => {
    if (historyFlowGateDown()) throw new Error('板块资金历史接口冷却中')
    await emSlot()
    const url =
      `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?lmt=12&klt=101` +
      `&secid=90.${boardCode}&ut=${UT_FLOW}&fields1=f1,f2,f3,f7` +
      `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65&_=${Date.now()}`
    let json
    try {
      json = await emFetch(url, { timeout: 10000 })
      noteFlowOk('history')
    } catch (err) {
      noteFlowFailure('history', boardCode, err)
      throw err
    }
    const lines = json && json.data && json.data.klines
    if (!Array.isArray(lines)) return []
    const rows = lines
      .map((line) => {
        const p = String(line).split(',')
        return {
          date: String(p[0] || '').replace(/-/g, ''),
          main: num(p[1], null),
          mainPct: num(p[6], null)
        }
      })
      .filter((x) => x.date && x.main != null)
    rows.forEach((x) => recordFlow(boardCode, x.date, x.main))
    return rows
  })
}

async function getConstituents(boardCode, limit = 50) {
  return cached(`cons:${boardCode}:${limit}`, 1000 * 30, async () => {
    const url =
      `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=${limit}&po=1&np=1` +
      `&ut=${UT_QUOTE}&fltt=2&invt=2&fid=f3&fs=b:${boardCode}+f:!50` +
      `&fields=${QUOTE_FIELDS}&_=${Date.now()}`
    const json = await emFetch(url, { timeout: 10000 })
    const diff = json && json.data && json.data.diff
    return Array.isArray(diff) ? diff.map(normalizeQuote) : []
  })
}

async function fetchTrendRows(secid, ndays) {
  const url =
    `https://push2.eastmoney.com/api/qt/stock/trends2/get?secid=${secid}` +
    `&ut=${UT_QUOTE}&iscr=0&ndays=${ndays}&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13` +
    `&fields2=f51,f52,f53,f54,f55,f56,f57,f58&_=${Date.now()}`
  const json = await emFetch(url, { timeout: 10000 })
  const data = json && json.data
  return {
    preClose: data ? num(data.preClose, null) : null,
    rows: data && Array.isArray(data.trends) ? data.trends : []
  }
}

/* 昨日对比取最近一个量能正常的交易日；数据源偶尔混入量极低的测试日，用中位数的 20% 过滤 */
async function getPrevTrendSession(secid) {
  return cached(`trend:prev:${secid}`, 1000 * 60 * 10, async () => {
    const { rows } = await fetchTrendRows(secid, 5)
    const groups = new Map()
    rows.forEach((row) => {
      const p = String(row).split(',')
      const stamp = p[0] || ''
      const date = stamp.slice(0, 10)
      const t = stamp.slice(-5)
      const close = num(p[2], null)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !t || close == null) return
      if (!groups.has(date)) groups.set(date, [])
      groups.get(date).push({
        t,
        p: close,
        o: num(p[1], null),
        v: num(p[5], 0) || 0,
        a: num(p[6], 0) || 0
      })
    })
    const dates = Array.from(groups.keys()).sort()
    if (dates.length < 2) return null
    const totals = dates.slice(0, -1).map((date) => ({
      date,
      amount: groups.get(date).reduce((sum, item) => sum + item.a, 0)
    }))
    const amounts = totals.map((item) => item.amount).filter((v) => v > 0).sort((a, b) => a - b)
    if (!amounts.length) return null
    const median = amounts[Math.floor(amounts.length / 2)]
    const valid = totals.filter((item) => item.amount >= median * 0.2)
    if (!valid.length) return null
    const prev = valid[valid.length - 1]
    return { date: prev.date, rows: groups.get(prev.date) }
  })
}

function buildTrendCompare(data, prev) {
  if (!data || !prev || !Array.isArray(prev.rows) || !prev.rows.length) return null
  const todayAmount = Number(data.amount)
  if (!Number.isFinite(todayAmount) || todayAmount <= 0) return null
  const cutoff = data.time || prev.rows[prev.rows.length - 1].t
  let prevAmount = 0
  let prevVolume = 0
  let matched = 0
  prev.rows.forEach((row) => {
    if (row.t && row.t <= cutoff) {
      prevAmount += row.a
      prevVolume += row.v
      matched += 1
    }
  })
  if (!matched || prevAmount <= 0) return null
  const ratio = todayAmount / prevAmount - 1
  const tag = ratio >= 0.05 ? '放量' : ratio <= -0.05 ? '缩量' : '量平'
  return {
    prevDate: prev.date,
    time: cutoff,
    todayAmount,
    prevAmount,
    todayVolume: data.volume,
    prevVolume,
    ratio,
    tag,
    tone: tag === '放量' ? 'up' : tag === '缩量' ? 'down' : 'flat',
    band: '±5%'
  }
}

/* 沪深两市成交额用腾讯指数行情，东财备用节点给深证指数返回的成交额明显偏小，不能直接相加 */
async function fetchTencentIndexDays(code) {
  return cached(`tq:days:${code}`, 1000 * 60 * 10, async () => {
    const url = `https://web.ifzq.gtimg.cn/appstock/app/day/query?code=${code}`
    const json = await fetchJson(url, { timeout: 12000, referer: 'https://gu.qq.com/' })
    const days = json && json.data && json.data[code] && json.data[code].data
    if (!Array.isArray(days)) return []
    return days
      .map((day) => ({
        date: String(day.date || ''),
        rows: (Array.isArray(day.data) ? day.data : [])
          .map((row) => {
            const p = String(row).split(' ')
            return { t: p[0] || '', a: num(p[3], null) }
          })
          .filter((row) => /^\d{4}$/.test(row.t) && row.a != null)
      }))
      .filter((day) => /^\d{8}$/.test(day.date) && day.rows.length)
  })
}

function pickPrevTencentDay(days) {
  const sorted = (days || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1))
  if (sorted.length < 2) return null
  const totals = sorted.slice(0, -1).map((day) => ({
    day,
    amount: day.rows[day.rows.length - 1].a
  }))
  const amounts = totals.map((x) => x.amount).filter((v) => v > 0).sort((a, b) => a - b)
  if (!amounts.length) return null
  const median = amounts[Math.floor(amounts.length / 2)]
  const valid = totals.filter((x) => x.amount >= median * 0.2)
  return valid.length ? valid[valid.length - 1].day : null
}

function amountAtTencentTime(rows, cutoff) {
  let amount = null
  for (const row of rows) {
    if (row.t <= cutoff) amount = row.a
    else break
  }
  return amount
}

async function getMarketTurnoverCompare() {
  const [shDays, szDays, quotes] = await Promise.all([
    fetchTencentIndexDays('sh000001'),
    fetchTencentIndexDays('sz399001'),
    tencentQuotes(['1.000001', '0.399001'])
  ])
  const shQuote = quotes.find((q) => q.secid === '1.000001')
  const szQuote = quotes.find((q) => q.secid === '0.399001')
  if (!shQuote || !szQuote || !shQuote.amount || !szQuote.amount) return null
  const shPrev = pickPrevTencentDay(shDays)
  const szPrev = pickPrevTencentDay(szDays)
  if (!shPrev || !szPrev || shPrev.date !== szPrev.date) return null
  const cutoff = [shQuote.quoteTime, szQuote.quoteTime]
    .map((t) => String(t || '').slice(0, 5).replace(':', ''))
    .filter((t) => /^\d{4}$/.test(t))
    .sort()[0]
  if (!cutoff) return null
  const prevSh = amountAtTencentTime(shPrev.rows, cutoff)
  const prevSz = amountAtTencentTime(szPrev.rows, cutoff)
  if (!prevSh || !prevSz) return null
  const todayAmount = Number(shQuote.amount) + Number(szQuote.amount)
  const prevAmount = prevSh + prevSz
  if (!Number.isFinite(todayAmount) || todayAmount <= 0 || prevAmount <= 0) return null
  const ratio = todayAmount / prevAmount - 1
  const tag = ratio >= 0.05 ? '放量' : ratio <= -0.05 ? '缩量' : '量平'
  const date = shPrev.date
  return {
    prevDate: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
    time: `${cutoff.slice(0, 2)}:${cutoff.slice(2)}`,
    todayAmount,
    prevAmount,
    ratio,
    tag,
    tone: tag === '放量' ? 'up' : tag === '缩量' ? 'down' : 'flat',
    band: '±5%',
    scope: 'sh+sz'
  }
}

/* 全市场涨跌家数：东财涨跌分布，覆盖沪深两市正在交易的 A 股（不是上证指数单市场口径） */
async function getMarketBreadth() {
  return cached('market:breadth', 3000, async () => {
    const url =
      `https://push2ex.eastmoney.com/getTopicZDFenBu?ut=${UT_POOL}&dpt=wz.ztzt&_=${Date.now()}`
    const json = await fetchJson(url, { timeout: 10000 })
    const bins = json && json.data && json.data.fenbu
    if (!Array.isArray(bins) || !bins.length) return null
    let up = 0
    let down = 0
    let flat = 0
    bins.forEach((bin) => {
      if (!bin) return
      Object.keys(bin).forEach((key) => {
        const edge = Number(key)
        const count = num(bin[key], 0)
        if (!Number.isFinite(edge) || !Number.isFinite(count) || count <= 0) return
        if (edge > 0) up += count
        else if (edge < 0) down += count
        else flat += count
      })
    })
    const total = up + down + flat
    if (up + down < 1000 || down <= 0) return null
    const qdate = String((json.data && json.data.qdate) || '')
    return {
      up,
      down,
      flat,
      total,
      date: /^\d{8}$/.test(qdate)
        ? `${qdate.slice(0, 4)}-${qdate.slice(4, 6)}-${qdate.slice(6, 8)}`
        : '',
      scope: 'sh+sz'
    }
  })
}

async function getTrends(secid, { compare = false } = {}) {
  if (!/^\d{1,2}\.(\d{6}|BK\d{4})$/.test(String(secid))) {
    throw new Error('secid 非法')
  }
  const data = await cached(`trend:${secid}`, 2000, async () => {
    const { preClose, rows } = await fetchTrendRows(secid, 1)
    if (!rows.length) {
      return { preClose, points: [], last: null, date: '', time: '', amount: 0, volume: 0 }
    }
    const points = []
    let amountSum = 0
    let volumeSum = 0
    rows.forEach((row) => {
      const p = String(row).split(',')
      const t = p[0] ? p[0].slice(-5) : ''
      const open = num(p[1], null)
      const close = num(p[2], null)
      const volume = num(p[5], null)
      const amount = num(p[6], 0)
      if (t && close != null) {
        points.push({ t, p: close, o: open, v: volume })
        if (Number.isFinite(volume)) volumeSum += volume
        if (Number.isFinite(amount)) amountSum += amount
      }
    })
    const last = points.length ? points[points.length - 1].p : null
    const date = rows.length ? String(rows[0]).slice(0, 10) : ''
    const time = points.length ? points[points.length - 1].t : ''
    return { preClose, points, last, date, time, amount: amountSum, volume: volumeSum }
  })
  const result = { ...data }
  if (secid === '1.000001') {
    try {
      result.breadth = await getMarketBreadth()
    } catch (err) {
      result.breadth = null
    }
  }
  if (!compare) return result
  result.compare = null
  try {
    const prev = await getPrevTrendSession(secid)
    result.compare = buildTrendCompare(data, prev)
  } catch (err) {
    /* 单指数对比失败不影响分时本身 */
  }
  if (secid === '1.000001') {
    try {
      result.marketCompare = await getMarketTurnoverCompare()
    } catch (err) {
      result.marketCompare = null
    }
  }
  return result
}

function boardFlowSnapshot(history, tradeDate, prevTradeDate = null) {
  const stamp = String(tradeDate || '').replace(/-/g, '')
  const prevStamp = prevTradeDate ? String(prevTradeDate).replace(/-/g, '') : null
  const rows = (history || []).map((x) => ({
    ...x,
    date: String(x.date || '').replace(/-/g, '')
  }))
  const sorted = rows.sort((a, b) => (a.date < b.date ? -1 : 1))
  const todayRow = sorted.find((x) => x.date === stamp) || null
  /* 优先按真实上一交易日取数，避免历史里夹带非交易日行或今日行 */
  let yesterday = prevStamp ? sorted.find((x) => x.date === prevStamp) || null : null
  if (!yesterday) {
    const prior = sorted.filter((x) => x.date < stamp)
    yesterday = prior.length ? prior[prior.length - 1] : null
  }
  return { todayRow, yesterday, history: sorted.slice(-5) }
}

module.exports = {
  getPool,
  getLatestTradingPool,
  getPrevTradingPool,
  findPoolBack,
  getBoards,
  getBoardQuotes,
  scanMarketLeaders,
  scanTailSurprises,
  batchQuotes,
  tencentQuotes,
  getTodayFlow,
  getFlowHistory,
  recordFlow,
  storedFlow,
  getConstituents,
  getTrends,
  tencentKline,
  boardFlowSnapshot,
  normalizePoolItem,
  UT_QUOTE
}