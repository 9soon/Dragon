'use strict'

const http = require('http')
const fs = require('fs')
const path = require('path')
const { URL } = require('url')

const {
  beijingNow,
  dateStamp,
  dateDashed,
  weekdayOf,
  marketStatus,
  hhmm,
  round,
  sleep
} = require('./util')
const {
  getPool,
  getLatestTradingPool,
  getPrevTradingPool,
  getBoards,
  batchQuotes,
  getTodayFlow,
  getFlowHistory,
  recordFlow,
  storedFlow,
  getTrends,
  boardFlowSnapshot
} = require('./eastmoney')
const {
  buildSectors,
  applySectorEvidence,
  buildSentiment,
  buildPicks,
  buildReview,
  matchBoard,
  flowText
} = require('./scoring')
const {
  buildWeakContext,
  weakMapFor,
  enrichPicks
} = require('./gene')
const {
  buildAuction,
  buildOvernight,
  getDragonProfile,
  warmDragonProfile,
  peekDragonProfile
} = require('./edge')

const PORT = Number(process.env.PORT || 8787)
const DIST = path.join(__dirname, '..', 'dist')
const CACHE_DIR = path.join(__dirname, '..', '.cache')
const CACHE_FILE = path.join(CACHE_DIR, 'dashboard.json')
const DASHBOARD_TTL = 8000

let lastGood = null
let lastGoodAt = 0
let lastPersistAt = 0
let building = null
let startupDiskLoaded = false

function loadDiskCache() {
  if (startupDiskLoaded) return
  startupDiskLoaded = true
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8')
    const data = JSON.parse(raw)
    if (data && data.tradeDate) {
      lastGood = data
      lastGoodAt = Date.parse(data.generatedAt) || Date.now()
    }
  } catch (err) {
    /* no cache yet */
  }
}

function persistCache(dashboard) {
  const now = Date.now()
  if (now - lastPersistAt < 60000) return
  lastPersistAt = now
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    fs.writeFileSync(CACHE_FILE, JSON.stringify(dashboard), 'utf8')
  } catch (err) {
    /* cache persistence is best effort */
  }
}

function weekLabel(stamp) {
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const w = weekdayOf(stamp)
  return `${stamp.slice(4, 6)}-${stamp.slice(6, 8)} ${names[w] || ''}`.trim()
}

function groupBySector(pool) {
  const map = new Map()
  for (const s of pool) {
    const key = s.sector || '未分类'
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(s)
  }
  return map
}

function quotesByCode(quoteItems) {
  const map = new Map()
  for (const q of quoteItems || []) {
    if (q && q.code) map.set(q.code, q)
  }
  return map
}

function poolBrief(items) {
  return (items || []).map((s) => ({
    code: s.code,
    name: s.name,
    sector: s.sector,
    lbc: s.lbc,
    firstSeal: s.firstSeal,
    blowCount: s.blowCount,
    amount: s.amount,
    price: s.price
  }))
}

async function buildDashboard() {
  const now = beijingNow()
  const today = dateStamp(now)
  const market = marketStatus(now)
  const warnings = []

  const todayPool = await getPool(today, 'zt')
  let tradePool = todayPool
  let isTodayData = todayPool.items.length > 0
  if (!isTodayData) {
    const latest = await getLatestTradingPool(today)
    if (!latest || !latest.items.length) {
      throw new Error('未获取到最近交易日的涨停池数据')
    }
    tradePool = latest
    isTodayData = latest.date === today
  }
  const tradeDate = tradePool.date
  const pool = tradePool.items

  const [prevSettled, boardsSettled, blowSettled, downSettled] = await Promise.allSettled([
    getPrevTradingPool(tradeDate),
    getBoards(),
    getPool(tradeDate, 'zb'),
    getPool(tradeDate, 'dt')
  ])

  let prevPool = []
  let prevTradeDate = null
  if (prevSettled.status === 'fulfilled' && prevSettled.value) {
    prevPool = prevSettled.value.items || []
    prevTradeDate = prevSettled.value.date
  } else {
    warnings.push('上一交易日涨停池读取失败，连续性判断可能不完整')
  }

  let boards = []
  if (boardsSettled.status === 'fulfilled') {
    boards = boardsSettled.value || []
  } else {
    warnings.push('行业板块列表读取失败，资金与热度映射不完整')
  }

  let blowPool = []
  if (blowSettled.status === 'fulfilled') {
    blowPool = blowSettled.value.items || []
  } else {
    warnings.push('炸板池读取失败，封板质量指标不完整')
  }

  let downPool = []
  if (downSettled.status === 'fulfilled') {
    downPool = downSettled.value.items || []
  } else {
    warnings.push('跌停池读取失败')
  }

  /* 弱转强需要昨日炸板 / 跌停池：炸板回封、跌停反包都来自这里 */
  let prevBlowPool = []
  let prevDownPool = []
  if (prevTradeDate) {
    const [pb, pd] = await Promise.allSettled([
      getPool(prevTradeDate, 'zb'),
      getPool(prevTradeDate, 'dt')
    ])
    if (pb.status === 'fulfilled') prevBlowPool = pb.value.items || []
    if (pd.status === 'fulfilled') prevDownPool = pd.value.items || []
    if (pb.status !== 'fulfilled' || pd.status !== 'fulfilled') {
      warnings.push('上一交易日炸板 / 跌停池读取失败，弱转强识别可能不完整')
    }
  }

  const groups = groupBySector(pool)
  const detailTargets = Array.from(groups.entries())
    .filter(([, arr]) => arr.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 10)
  const boardByCode = new Map()
  for (const [name] of detailTargets) {
    const board = matchBoard(name, boards)
    if (board) boardByCode.set(board.code, board)
  }

  const [flowResults, todayFlowResults] = await Promise.all([
    Promise.allSettled(
      Array.from(boardByCode.values()).map(async (board) => {
        const hist = await getFlowHistory(board.code)
        return { code: board.code, snap: boardFlowSnapshot(hist, tradeDate, prevTradeDate) }
      })
    ),
    Promise.allSettled(
      Array.from(boardByCode.values()).map(async (board) => {
        const today = await getTodayFlow(`90.${board.code}`)
        return { code: board.code, today }
      })
    )
  ])

  const todayFlowByCode = new Map()
  for (const result of todayFlowResults) {
    if (result.status === 'fulfilled' && result.value && result.value.today) {
      const { code, today } = result.value
      if (today.date === tradeDate) {
        todayFlowByCode.set(code, today.main)
        recordFlow(code, tradeDate, today.main)
      }
    }
  }
  let todayMissing = 0
  for (const board of boardByCode.values()) {
    const hasDetail = todayFlowByCode.has(board.code)
    const hasCatalog = board.todayFlow != null && board.todayFlow !== 0
    if (!hasDetail && !hasCatalog) todayMissing++
  }
  if (todayMissing) {
    warnings.push(`部分板块当日资金读取失败（${todayMissing} 个）`)
  }

  const flowMap = new Map()
  let historyMissing = 0
  for (const board of boardByCode.values()) {
    const flowResult = flowResults.find(
      (r) => r.status === 'fulfilled' && r.value && r.value.code === board.code
    )
    const snap = flowResult ? flowResult.value.snap : { yesterday: null, history: [] }
    const yesterdayMain = snap.yesterday
      ? snap.yesterday.main
      : storedFlow(board.code, prevTradeDate || '')
    if (yesterdayMain == null) historyMissing++
    const todayMain = todayFlowByCode.has(board.code)
      ? todayFlowByCode.get(board.code)
      : board.todayFlow != null && board.todayFlow !== 0
        ? board.todayFlow
        : null
    if (snap.history && snap.history.length >= 2) {
      const sum = snap.history
        .slice(-5)
        .reduce((acc, row) => acc + (Number.isFinite(row.main) ? row.main : 0), 0)
      if (Number.isFinite(sum)) board.flow5d = sum
    }
    flowMap.set(board.code, {
      todayFlow: todayMain,
      yesterday: yesterdayMain != null ? { main: yesterdayMain } : null,
      history: snap.history
    })
  }
  if (historyMissing) {
    warnings.push(`部分板块资金历史读取失败（${historyMissing} 个，资金关可能无法确认）`)
  }

  const weakCtx = buildWeakContext({
    prevPool,
    prevBlow: prevBlowPool,
    prevDown: prevDownPool
  })
  const weakMap = weakMapFor(pool, weakCtx)
  const sectorData = buildSectors({ pool, prevPool, boards, flowMap, tradeDate, weakMap })
  const focusProxy = sectorData.mainCandidates
    .concat(sectorData.newThemes)
    .filter((s) => s.money.proxy)
  if (focusProxy.length) {
    warnings.push(
      `${focusProxy.map((s) => s.name).join('、')} 未取到昨日资金明细：资金承接按量能 / 封单 / 溢价晋级等证据核对，主力资金一项记未知`
    )
  }

  const MARKET_INDEXES = [{ secid: '1.000001', name: '上证指数' }]
  const indexSecids = MARKET_INDEXES.map((item) => item.secid)

  const leadSecids = []
  const leadSeen = new Set()
  for (const sector of sectorData.mainCandidates.concat(sectorData.newThemes)) {
    const leadCode = sector.board && sector.board.leadCode
    if (leadCode && !leadSeen.has(leadCode)) {
      leadSeen.add(leadCode)
      leadSecids.push(`${/^6/.test(leadCode) ? 1 : 0}.${leadCode}`)
    }
  }
  const allQuoteSecids = Array.from(
    new Set(
      pool
        .concat(prevPool)
        .map((s) => s.secid)
        .filter(Boolean)
        .concat(leadSecids, indexSecids)
    )
  )
  let quoteItems = []
  let quoteAt = 0
  try {
    const quoteResult = await batchQuotes(allQuoteSecids)
    quoteItems = quoteResult.items || []
    quoteAt = quoteResult.at || Date.now()
  } catch (err) {
    warnings.push('个股实时行情读取失败，价格可能使用池内快照')
  }
  const indices = MARKET_INDEXES.map((item) => {
    const q = quoteItems.find((x) => x.secid === item.secid)
    if (!q) return null
    return {
      secid: q.secid,
      code: q.code,
      name: q.name || item.name,
      price: q.price,
      pct: q.pct,
      change: q.change,
      open: q.open,
      high: q.high,
      low: q.low,
      prevClose: q.prevClose,
      amount: q.amount,
      upCount: q.upCount,
      downCount: q.downCount,
      at: quoteAt
    }
  }).filter(Boolean)
  /* 指数与个股都使用 000001 这类代码，qMap 排除指数，避免与平安银行等个股冲突 */
  const qMap = quotesByCode(quoteItems.filter((q) => !indexSecids.includes(q.secid)))

  /* 行情到位后补第 4 项证据（昨日涨停溢价），再定资金承接关 */
  applySectorEvidence(sectorData, { quotesByCode: qMap, prevPool })

  const awaitingToday = !isTodayData && market.live
  const skipPremium = awaitingToday
  const sentiment = buildSentiment({
    pool,
    blowPool,
    downPool,
    prevPool,
    quotesByCode: qMap,
    skipPremium
  })

  let picks = buildPicks({
    sectors: sectorData.mainCandidates.concat(sectorData.newThemes),
    quotesByCode: qMap
  })
  /* 先按基因分重排（弱转强 / 情绪 / 封板 / 画像），再给最终前 8 只补个股资金 */
  picks = enrichPicks(picks, {
    sectors: sectorData.mainCandidates.concat(sectorData.newThemes),
    profile: peekDragonProfile(),
    sentiment
  })
  if (picks.length && market.live) {
    const flowPicks = await Promise.allSettled(
      picks.slice(0, 8).map(async (pick) => {
        const flow = await getTodayFlow(pick.secid)
        if (!flow || flow.date !== tradeDate || flow.main == null) return null
        return { code: pick.code, main: flow.main }
      })
    )
    const flowByPick = new Map()
    for (const result of flowPicks) {
      if (result.status === 'fulfilled' && result.value) {
        flowByPick.set(result.value.code, result.value.main)
      }
    }
    for (const pick of picks) {
      if (flowByPick.has(pick.code)) {
        pick.mainInflow = flowByPick.get(pick.code)
        if (pick.amount > 0) pick.mainPct = Math.round((pick.mainInflow / pick.amount) * 1000) / 10
        if (pick.mainInflow > 0 && !pick.tags.includes('资金抢筹') && (pick.mainPct || 0) >= 8) {
          pick.tags.push('资金抢筹')
        }
      }
    }
  }

  const review = buildReview({
    sentiment,
    pool,
    blowPool,
    downPool,
    sectors: sectorData.all,
    prevPool,
    quotesByCode: qMap
  })

  const readyCount = sectorData.counts.dataReady
  const closeCandidate = sectorData.mainCandidates[0] || sectorData.newThemes[0] || null
  const sentiLead =
    sentiment.score != null ? `情绪 ${sentiment.score} 分是环境分，不等于主线确认；` : ''
  let gate
  if (!readyCount) {
    let detail = `${sentiLead}今天没有板块三关全过，按口诀空仓等待，只观察核心。`
    if (closeCandidate) {
      const passed = closeCandidate.gatesPassed != null
        ? closeCandidate.gatesPassed
        : closeCandidate.checks.filter((c) => c.pass).length
      const failed = closeCandidate.checks.filter((c) => !c.pass).map((c) => c.label)
      const moneyCheck = closeCandidate.checks.find((c) => c.key === 'money')
      const moneyNote =
        moneyCheck && !moneyCheck.pass && moneyCheck.detail
          ? `（${moneyCheck.detail}）`
          : closeCandidate.money && closeCandidate.money.yesterday != null &&
              failed.includes('资金承接（4项）')
            ? `（昨日 ${flowText(closeCandidate.money.yesterday)}）`
            : ''
      detail = `${sentiLead}今天没有板块三关全过；最强「${closeCandidate.name}」过 ${passed}/3 关` +
        (failed.length ? `，差「${failed.join('、')}」${moneyNote}` : '') +
        '，只做核心观察，不追高。'
    }
    gate = { key: 'empty', label: '空仓等待', detail }
  } else if (sentiment.phaseKey === 'ice' || sentiment.phaseKey === 'ebb') {
    gate = {
      key: 'defend',
      label: '降频观察',
      detail: `${readyCount} 个板块数据达标，但情绪处于「${sentiment.phase.label}」，只观察核心，不追一致。`
    }
  } else {
    gate = {
      key: 'ready',
      label: '待催化确认',
      detail: `${readyCount} 个板块数据达标，核验政策 / 产业 / 事件催化后，只做最强核心。`
    }
  }
  sentiment.gate = gate
  sentiment.dataGate = {
    readyCount,
    candidateCount: sectorData.counts.mainCandidates,
    totalSectors: sectorData.counts.sectors
  }

  if (warnings.length) sentiment.warnings = warnings
  sentiment.incomplete = warnings.some((w) => w.includes('炸板') || w.includes('行情'))

  const watchSecids = Array.from(
    new Set(
      picks
        .map((p) => p.secid)
        .concat(
          sectorData.mainCandidates
            .slice(0, 3)
            .map((s) => (s.board ? `90.${s.board.code}` : null))
            .filter(Boolean)
        )
        .filter(Boolean)
    )
  )

  const dataMode = isTodayData ? (market.live ? 'live' : 'review') : 'review'
  const snapshotLabel = isTodayData
    ? market.label
    : ['preopen', 'auction', 'waiting'].includes(market.key)
      ? '盘前'
      : '最近交易日'

  const generatedAt = new Date().toISOString()
  const dashboard = {
    ok: true,
    generatedAt,
    serverTime: hhmm(now),
    dataMode,
    isTodayData,
    awaitingToday,
    tradeDate,
    tradeDateLabel: weekLabel(tradeDate),
    tradeDateDashed: `${tradeDate.slice(0, 4)}-${tradeDate.slice(4, 6)}-${tradeDate.slice(6, 8)}`,
    prevTradeDate,
    prevTradeDateLabel: prevTradeDate ? weekLabel(prevTradeDate) : null,
    market: { ...market, snapshotLabel },
    indices,
    sentiment,
    gate,
    sectors: {
      mainCandidates: sectorData.mainCandidates,
      newThemes: sectorData.newThemes,
      fading: sectorData.fading,
      counts: sectorData.counts,
      all: sectorData.all
    },
    /* 上一交易日的涨停 / 炸板 / 跌停快照：竞价页据此识别弱转强，不再重复请求 */
    prevContext: prevTradeDate
      ? {
          date: prevTradeDate,
          zt: poolBrief(prevPool),
          blow: poolBrief(prevBlowPool),
          down: poolBrief(prevDownPool)
        }
      : null,
    picks,
    review,
    watchSecids,
    warnings,
    source: {
      name: '东方财富公开行情接口',
      note: '行情可能存在延迟；仅用于个人研究，不构成投资建议。'
    }
  }

  /* 首页直接带一份隔夜摘要：严格候选为空时也展示最强观察池与原因 */
  try {
    const overnight = buildOvernight({ dashboard, profile: peekDragonProfile(), now })
    const trim = (item) => ({
      code: item.code,
      name: item.name,
      sector: item.sector,
      roleLabel: item.roleLabel,
      lbc: item.lbc,
      close: item.close,
      limitUp: item.limitUp,
      boardRule: item.boardRule,
      score: item.score,
      prepScore: item.prepScore,
      geneScore: item.geneScore,
      weakLabel: item.weakLabel || '',
      acceptable: !!item.acceptable,
      observation: !!item.observation,
      why: (item.why || item.reasons || []).slice(0, 3),
      risks: (item.risks || []).slice(0, 2),
      tags: (item.tags || []).slice(0, 3)
    })
    dashboard.overnightBrief = {
      status: overnight.status,
      statusLabel: overnight.statusLabel,
      reason: overnight.reason,
      mode: overnight.mode,
      dataReady: overnight.dataReady,
      recommendations: (overnight.recommendations || []).slice(0, 3).map(trim),
      preparation: (overnight.preparation || []).slice(0, 5).map(trim),
      updatedAt: overnight.generatedAt
    }
  } catch (err) {
    dashboard.overnightBrief = null
    warnings.push(`隔夜计划生成失败：${err.message}`)
  }

  lastGood = dashboard
  lastGoodAt = Date.now()
  persistCache(dashboard)
  setTimeout(() => warmDragonProfile(tradeDate), 3000)
  return dashboard
}

async function getDashboard({ force = false } = {}) {
  loadDiskCache()
  const now = Date.now()
  if (!force && lastGood && now - lastGoodAt < DASHBOARD_TTL) {
    return { ...lastGood, cacheAge: Math.round((now - lastGoodAt) / 1000) }
  }
  if (building) return building
  building = (async () => {
    try {
      return await buildDashboard()
    } catch (err) {
      if (lastGood) {
        const age = Math.max(0, Math.round((now - lastGoodAt) / 1000))
        return {
          ...lastGood,
          dataMode: 'stale',
          staleAge: age,
          staleReason: err.message,
          warnings: Array.from(new Set([...(lastGood.warnings || []), `实时重建失败：${err.message}`]))
        }
      }
      throw err
    } finally {
      building = null
    }
  })()
  return building
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

function serveStatic(req, res, pathname) {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    sendJson(res, 503, {
      ok: false,
      error: '前端尚未构建。开发请访问 Vite 5173，或先运行 npm run build。'
    })
    return
  }
  const rel = pathname === '/' ? '/index.html' : pathname
  const target = path.resolve(DIST, '.' + rel)
  if (!target.startsWith(DIST)) {
    sendJson(res, 403, { ok: false, error: 'forbidden' })
    return
  }
  let file = target
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(DIST, 'index.html')
  }
  const ext = path.extname(file).toLowerCase()
  const isHashed = /\/assets\//.test(file)
  try {
    const buf = fs.readFileSync(file)
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': isHashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      'Content-Length': buf.length
    })
    res.end(buf)
  } catch (err) {
    sendJson(res, 404, { ok: false, error: 'not found' })
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const pathname = decodeURIComponent(url.pathname)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    })
    res.end()
    return
  }

  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' })
    return
  }

  try {
    if (pathname === '/api/dashboard') {
      const force = url.searchParams.get('refresh') === '1'
      const data = await getDashboard({ force })
      sendJson(res, 200, data)
      return
    }

    if (pathname === '/api/quotes') {
      const secids = String(url.searchParams.get('secids') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 80)
      if (!secids.length) {
        sendJson(res, 400, { ok: false, error: 'secids required' })
        return
      }
      const seal = url.searchParams.get('seal') === '1'
      const result = await batchQuotes(secids, { seal })
      sendJson(res, 200, {
        ok: true,
        at: result.at,
        stale: !!result.stale,
        serverTime: hhmm(beijingNow()),
        quotes: result.items
      })
      return
    }

    if (pathname === '/api/trend') {
      const secid = String(url.searchParams.get('secid') || '')
      if (!/^\d\.(\d{6}|BK\d{4})$/.test(secid)) {
        sendJson(res, 400, { ok: false, error: 'invalid secid' })
        return
      }
      const compare = url.searchParams.get('compare') === '1'
      const data = await getTrends(secid, { compare })
      sendJson(res, 200, { ok: true, data, at: Date.now() })
      return
    }

    if (pathname === '/api/auction') {
      const dashboard = await getDashboard()
      const data = await buildAuction({ dashboard, profile: peekDragonProfile() })
      sendJson(res, 200, data)
      return
    }

    if (pathname === '/api/overnight') {
      const dashboard = await getDashboard()
      const data = buildOvernight({ dashboard, profile: peekDragonProfile() })
      sendJson(res, 200, data)
      return
    }

    if (pathname === '/api/dragon-profile') {
      const force = url.searchParams.get('refresh') === '1'
      const days = Math.max(10, Math.min(60, Number(url.searchParams.get('days')) || 30))
      const latestDate = lastGood ? lastGood.tradeDate : null
      const task = getDragonProfile({ days, force, latestDate }).catch((err) => {
        console.error('[profile]', err && err.message)
        return null
      })
      const quick = await Promise.race([task, sleep(1600).then(() => null)])
      const profile = quick || peekDragonProfile()
      if (profile) {
        const { rawSamples, ...publicProfile } = profile
        sendJson(res, 200, { ...publicProfile, building: !quick })
      } else {
        sendJson(res, 200, {
          ok: true,
          building: true,
          pending: true,
          message: '正在建立老龙头样本画像，首次约需 10–40 秒，稍后会随行情自动补齐。'
        })
      }
      return
    }

    if (pathname === '/api/health') {
      const profile = peekDragonProfile()
      sendJson(res, 200, {
        ok: true,
        time: new Date().toISOString(),
        beijingTime: hhmm(beijingNow()),
        dashboardReady: !!lastGood,
        dashboardAge: lastGoodAt ? Math.round((Date.now() - lastGoodAt) / 1000) : null,
        dashboardDate: lastGood ? lastGood.tradeDate : null,
        dragonProfile: profile
          ? {
              latestDate: profile.latestDate,
              builtAt: profile.builtAt,
              samples: profile.samples,
              samplesCount: profile.samples,
              stale: !!profile.stale
            }
          : null
      })
      return
    }

    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { ok: false, error: 'api not found' })
      return
    }

    serveStatic(req, res, pathname)
  } catch (err) {
    console.error('[api]', err && err.message)
    sendJson(res, 502, { ok: false, error: err.message || 'upstream error' })
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[龙脉] API + H5 服务已启动: http://127.0.0.1:${PORT}`)
  console.log(`[龙脉] 开发模式请另开终端执行 npm run dev (Vite 5173 代理 /api)`)
})

process.on('SIGINT', () => {
  server.close(() => process.exit(0))
})
process.on('SIGTERM', () => {
  server.close(() => process.exit(0))
})