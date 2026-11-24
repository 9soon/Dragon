'use strict'

const fs = require('fs')
const path = require('path')

const {
  getPool,
  getLatestTradingPool,
  getPrevTradingPool,
  batchQuotes,
  scanMarketLeaders,
  tencentKline
} = require('./eastmoney')
const { sealMinutesFromOpen, sealTimeLabel } = require('./scoring')
const {
  limitRatioFor,
  fitDragonCandidate,
  geneScore,
  buildWeakContext,
  weakForCode
} = require('./gene')
const {
  beijingNow,
  dateStamp,
  marketStatus,
  clamp,
  round,
  num,
  sleep,
  stripLevel,
  is20cmCode
} = require('./util')

const PROFILE_FILE = path.join(__dirname, '..', '.cache', 'dragon-profile.json')
const PROFILE_TTL = 1000 * 60 * 60 * 6
const PROFILE_DAYS = 30
const PROFILE_VERSION = 2
const PROFILE_MAX_DAYS = 120
const PROFILE_MAX_SAMPLES = 600

let profileMemory = null
let profileDiskLoaded = false
let profileBuilding = null
let profileTriedAt = 0

/* ------------------------------------------------------------------ *
 * 通用：交易规则与阶段
 * ------------------------------------------------------------------ */

function boardRuleLabel(code) {
  const ratio = limitRatioFor(code)
  if (ratio === 0.3) return '北交所 30%'
  if (ratio === 0.2) return '双创 20%'
  return '主板 10%'
}

function auctionStage(market) {
  if (market.key === 'auction') {
    if (market.mins < 9 * 60 + 20) {
      return {
        key: 'trial',
        label: '试撮阶段',
        active: true,
        cancellable: true,
        final: false,
        note: '9:15–9:20 允许撤单，价格与匹配量都可能变化，只做观察。'
      }
    }
    return {
      key: 'locked',
      label: '不可撤单',
      active: true,
      cancellable: false,
      final: false,
      note: '9:20–9:25 不可撤单，竞价数据参考价值最高，但仍需开盘承接确认。'
    }
  }
  if (market.key === 'waiting') {
    return {
      key: 'final',
      label: '竞价定稿',
      active: true,
      cancellable: false,
      final: true,
      note: '9:25 竞价已定稿。高开只是起点，9:30 后的承接才决定是否参与。'
    }
  }
  if (market.key === 'preopen') {
    return {
      key: 'preopen',
      label: '等待竞价',
      active: false,
      cancellable: true,
      final: false,
      note: '尚未到 9:15。先看昨日主线与老龙头画像，竞价开始后再看真实资金态度。'
    }
  }
  if (market.key === 'morning' || market.key === 'afternoon') {
    return {
      key: 'intraday',
      label: '盘中实时',
      active: true,
      cancellable: false,
      final: false,
      intraday: true,
      note: '盘中抓板看实时封板与近板强度，不做竞价撤单那套推演；封板确认只认买一贴在涨停价。'
    }
  }
  if (market.key === 'lunch') {
    return {
      key: 'intraday',
      label: '午间冻结',
      active: true,
      cancellable: false,
      final: false,
      intraday: true,
      frozen: true,
      note: '午间行情冻结，排名沿用上午收盘；13:00 后继续刷新，不在冻结时段做新决策。'
    }
  }
  return {
    key: 'off',
    label: '非交易时段',
    active: false,
    cancellable: true,
    final: false,
    note: '当前不在交易时段。竞价抓强只在 9:15–9:30 计算，盘中抓板只在 9:30–15:00 计算，其余时间不做事后拟合。'
  }
}

function phaseFactor(phaseKey) {
  if (phaseKey === 'ice') return 0.55
  if (phaseKey === 'ebb') return 0.72
  if (phaseKey === 'mixed') return 0.86
  if (phaseKey === 'repair' || phaseKey === 'feast') return 1
  return 0.9
}

function sectorPriorScore(sector) {
  if (!sector) return 25
  if (sector.dataReady) return 100
  if (sector.group === 'main') return 78
  if (sector.group === 'new') return 52
  return 28
}

/* ------------------------------------------------------------------ *
 * 老龙头画像
 * ------------------------------------------------------------------ */

function loadProfileDisk() {
  if (profileDiskLoaded) return profileMemory
  profileDiskLoaded = true
  try {
    const raw = fs.readFileSync(PROFILE_FILE, 'utf8')
    const data = JSON.parse(raw)
    if (data && data.ok && data.builtAt) profileMemory = data
  } catch (err) {
    /* 首次运行没有画像缓存 */
  }
  return profileMemory
}

function peekDragonProfile() {
  return profileMemory || loadProfileDisk()
}

function saveProfile(profile) {
  profileMemory = profile
  try {
    fs.mkdirSync(path.dirname(PROFILE_FILE), { recursive: true })
    fs.writeFileSync(PROFILE_FILE, JSON.stringify(profile), 'utf8')
  } catch (err) {
    /* 画像缓存写入失败不影响本次统计 */
  }
}

function normalizeDateLabel(stamp) {
  if (!stamp || stamp.length !== 8) return ''
  const m = Number(stamp.slice(4, 6))
  const d = Number(stamp.slice(6, 8))
  return `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function bucketStats(samples, key, defs) {
  return defs.map((def) => {
    const list = samples.filter((s) => {
      const v = key(s)
      return v != null && v >= def.min && v <= def.max
    })
    const gaps = list.filter((x) => x.gap != null).map((x) => x.gap)
    const avgGap = gaps.length ? round(gaps.reduce((a, b) => a + b, 0) / gaps.length, 2) : null
    const continued = list.filter((x) => x.nextLimitUp).length
    return {
      key: def.key,
      label: def.label,
      min: def.min,
      max: def.max,
      samples: list.length,
      continued,
      rate: list.length ? round((continued / list.length) * 100, 0) : null,
      avgGap,
      gapSamples: gaps.length
    }
  })
}

const BUCKET_DEFS = {
  height: [
    { key: 'h3', label: '3 板', min: 3, max: 3 },
    { key: 'h4', label: '4 板', min: 4, max: 4 },
    { key: 'h5', label: '5 板+', min: 5, max: 99 }
  ],
  sealTime: [
    { key: 't1', label: '≤ 09:45', min: 0, max: 15 },
    { key: 't2', label: '09:46–10:30', min: 16, max: 60 },
    { key: 't3', label: '10:31–13:30', min: 61, max: 150 },
    { key: 't4', label: '13:30 后', min: 151, max: 999 }
  ],
  sealRatio: [
    { key: 's1', label: '< 0.5%', min: 0, max: 0.4999 },
    { key: 's2', label: '0.5%–1%', min: 0.5, max: 0.9999 },
    { key: 's3', label: '1%–2%', min: 1, max: 1.9999 },
    { key: 's4', label: '≥ 2%', min: 2, max: 999 }
  ],
  turnover: [
    { key: 'v1', label: '< 3%', min: 0, max: 2.9999 },
    { key: 'v2', label: '3%–10%', min: 3, max: 10 },
    { key: 'v3', label: '10%–20%', min: 10.0001, max: 20 },
    { key: 'v4', label: '> 20%', min: 20.0001, max: 999 }
  ],
  floatCap: [
    { key: 'c1', label: '< 50 亿', min: 0, max: 49.9999 },
    { key: 'c2', label: '50–150 亿', min: 50, max: 150 },
    { key: 'c3', label: '150–300 亿', min: 150.0001, max: 300 },
    { key: 'c4', label: '> 300 亿', min: 300.0001, max: 99999 }
  ],
  sectorCount: [
    { key: 'n1', label: '2 家', min: 2, max: 2 },
    { key: 'n2', label: '3–4 家', min: 3, max: 4 },
    { key: 'n3', label: '5 家+', min: 5, max: 99 }
  ]
}

function groupBySector(items) {
  const map = new Map()
  for (const s of items || []) {
    const key = s.sector || '未分类'
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(s)
  }
  return map
}

function sealRatioOf(s) {
  return s.floatCap > 0 ? (s.sealFund / s.floatCap) * 100 : 0
}

async function buildProfileData({ days = PROFILE_DAYS, latestDate = null } = {}) {
  const now = beijingNow()
  let latest = null
  if (latestDate) {
    const p = await getPool(latestDate, 'zt')
    if (p.items.length) latest = p
  }
  if (!latest) latest = await getLatestTradingPool(dateStamp(now))
  if (!latest || !latest.items.length) {
    throw new Error('没有可用的涨停池，无法建立老龙头样本')
  }

  const pools = []
  let cursor = latest
  for (let i = 0; i < days; i++) {
    if (!cursor || !cursor.items.length) break
    pools.unshift({ date: cursor.date, items: cursor.items })
    if (i === days - 1) break
    cursor = await getPrevTradingPool(cursor.date)
  }
  if (pools.length < 2) {
    throw new Error('历史涨停池不足，至少需要两个交易日')
  }

  const samples = []
  for (let i = 0; i < pools.length - 1; i++) {
    const day = pools[i]
    const next = pools[i + 1]
    const prev = i > 0 ? pools[i - 1] : null
    const groups = groupBySector(day.items)
    const prevGroups = prev ? groupBySector(prev.items) : null
    const nextMap = new Map(next.items.map((s) => [s.code, s]))
    for (const [sectorName, stocks] of groups) {
      if (stocks.length < 2) continue
      const sorted = stocks
        .slice()
        .sort(
          (a, b) =>
            b.lbc - a.lbc ||
            (a.firstSeal || 999999) - (b.firstSeal || 999999) ||
            b.sealFund - a.sealFund
        )
      const leader = sorted[0]
      if (!leader || leader.lbc < 3) continue
      const nextStock = nextMap.get(leader.code) || null
      samples.push({
        date: day.date,
        nextDate: next.date,
        code: leader.code,
        secid: leader.secid,
        name: leader.name,
        sector: sectorName,
        lbc: leader.lbc,
        firstSeal: leader.firstSeal,
        sealMinutes: sealMinutesFromOpen(leader.firstSeal),
        sealRatio: round(sealRatioOf(leader), 2),
        turnover: round(leader.turnover, 2),
        floatCapYi: round(leader.floatCap / 1e8, 1),
        blowCount: leader.blowCount,
        sectorCount: stocks.length,
        sectorPrevCount: prevGroups ? (prevGroups.get(sectorName) || []).length : null,
        nextLimitUp: !!nextStock,
        nextLbc: nextStock ? nextStock.lbc : null,
        gap: null
      })
    }
  }

  if (!samples.length) {
    throw new Error('历史样本中没有形成 3 板以上的板块龙头')
  }

  const unique = new Map()
  for (const s of samples) unique.set(s.secid, s)
  const klineTargets = Array.from(unique.values()).slice(-48)
  for (let i = 0; i < klineTargets.length; i += 4) {
    const part = klineTargets.slice(i, i + 4)
    const results = await Promise.allSettled(part.map((s) => tencentKline(s.secid, 220)))
    results.forEach((res, idx) => {
      if (res.status !== 'fulfilled' || !res.value.length) return
      const target = part[idx]
      const rows = res.value
      const rowIdx = rows.findIndex((r) => r.date === target.date)
      if (rowIdx < 0 || rowIdx >= rows.length - 1) return
      const close = rows[rowIdx].close
      const next = rows[rowIdx + 1]
      if (!close || !next.open) return
      for (const s of samples) {
        if (s.code !== target.code || s.date !== target.date) continue
        s.gap = round(((next.open / close - 1) * 100), 2)
        s.nextRet = round(((next.close / close - 1) * 100), 2)
      }
    })
    if (i + 4 < klineTargets.length) await sleep(80)
  }

  const previous = loadProfileDisk()
  const freshMap = new Map(samples.map((s) => [`${s.code}|${s.date}`, s]))
  let carriedSamples = 0
  if (previous && previous.version === PROFILE_VERSION && Array.isArray(previous.rawSamples)) {
    for (const s of previous.rawSamples) {
      const key = `${s.code}|${s.date}`
      if (!freshMap.has(key)) {
        freshMap.set(key, s)
        carriedSamples++
      }
    }
  }
  let merged = Array.from(freshMap.values()).sort(
    (a, b) => b.date.localeCompare(a.date) || b.lbc - a.lbc
  )
  const allDates = Array.from(new Set(merged.map((s) => s.date))).sort().reverse()
  const allowedDates = new Set(allDates.slice(0, PROFILE_MAX_DAYS))
  merged = merged.filter((s) => allowedDates.has(s.date)).slice(0, PROFILE_MAX_SAMPLES)
  const mergedDates = Array.from(new Set(merged.map((s) => s.date))).sort()
  const mergedCodes = new Set(merged.map((s) => s.code))

  const continued = merged.filter((s) => s.nextLimitUp).length
  const gaps = merged.filter((s) => s.gap != null).map((s) => s.gap)
  const sortedGaps = gaps.slice().sort((a, b) => a - b)
  const medianGap = sortedGaps.length
    ? sortedGaps[Math.floor(sortedGaps.length / 2)]
    : null

  const buckets = {
    height: bucketStats(merged, (s) => s.lbc, BUCKET_DEFS.height),
    sealTime: bucketStats(merged, (s) => s.sealMinutes, BUCKET_DEFS.sealTime),
    sealRatio: bucketStats(merged, (s) => s.sealRatio, BUCKET_DEFS.sealRatio),
    turnover: bucketStats(merged, (s) => s.turnover, BUCKET_DEFS.turnover),
    floatCap: bucketStats(merged, (s) => s.floatCapYi, BUCKET_DEFS.floatCap),
    sectorCount: bucketStats(merged, (s) => s.sectorCount, BUCKET_DEFS.sectorCount)
  }

  return {
    ok: true,
    version: PROFILE_VERSION,
    builtAt: new Date().toISOString(),
    latestDate: latest.date,
    days: pools.length,
    coverageDays: mergedDates.length,
    fromDate: mergedDates[0],
    toDate: mergedDates[mergedDates.length - 1],
    sampleStocks: mergedCodes.size,
    samples: merged.length,
    freshSamples: samples.length,
    carriedSamples,
    stats: {
      continued,
      continuedRate: merged.length ? round((continued / merged.length) * 100, 0) : null,
      gapSamples: gaps.length,
      gapWinRate: gaps.length
        ? round((gaps.filter((g) => g > 0).length / gaps.length) * 100, 0)
        : null,
      avgGap: gaps.length ? round(gaps.reduce((a, b) => a + b, 0) / gaps.length, 2) : null,
      medianGap
    },
    buckets,
    recentSamples: merged.slice(0, 12).map((s) => ({
      date: s.date,
      name: s.name,
      sector: s.sector,
      lbc: s.lbc,
      sealTime: sealTimeLabel(s.firstSeal),
      sealRatio: s.sealRatio,
      turnover: s.turnover,
      nextLimitUp: !!s.nextLimitUp,
      gap: s.gap
    })),
    rawSamples: merged,
    rules: {
      title: '高位龙头严格画像',
      items: [
        { key: 'height', label: '连板高度', ideal: '3–5 板', note: '5 板以上只做情绪观察，不默认接力' },
        { key: 'sealTime', label: '首封时间', ideal: '≤ 10:00', note: '越早封板，主动性越强' },
        { key: 'sealRatio', label: '封单 / 流通', ideal: '≥ 1%', note: '低于 0.5% 视为封单偏薄' },
        { key: 'turnover', label: '换手', ideal: '3%–20%', note: '过低没分歧，过高易兑现' },
        { key: 'floatCap', label: '流通市值', ideal: '50–300 亿', note: '太小易被操控，太大难持续' },
        { key: 'sectorCount', label: '板块涨停家数', ideal: '≥ 3 家', note: '孤零零一只不构成龙头' }
      ]
    },
    notes: [
      '样本只统计“板块内 3 板以上领涨股”，按每个龙头日计一次，不是独立个股数。',
      '延续率 = 样本次日继续涨停的比例；这是样本统计，不是预测准确率，也不是收益承诺。',
      '隔夜溢价 = 次日开盘相对样本日收盘的涨跌幅；跳空与滑点会显著改变实盘结果。',
      '东方财富涨停池仅能回溯最近约 15 个交易日；本地会把每次成功构建的样本累加保留，最多 120 个交易日 / 600 条，样本会随每日运行逐步变厚。',
      '样本量有限时使用原始计数，不做参数寻优；不要拿小样本统计替代交易纪律。'
    ]
  }
}

async function getDragonProfile({ days = PROFILE_DAYS, force = false, latestDate = null } = {}) {
  const cached = peekDragonProfile()
  const fresh =
    cached &&
    cached.version === PROFILE_VERSION &&
    cached.builtAt &&
    Date.now() - Date.parse(cached.builtAt) < PROFILE_TTL &&
    (!latestDate || cached.latestDate === latestDate)
  if (fresh && !force) return cached
  if (profileBuilding) return profileBuilding
  profileTriedAt = Date.now()
  profileBuilding = (async () => {
    try {
      const data = await buildProfileData({ days, latestDate })
      saveProfile(data)
      return data
    } catch (err) {
      if (cached) return { ...cached, stale: true, error: err.message }
      throw err
    } finally {
      profileBuilding = null
    }
  })()
  return profileBuilding
}

function warmDragonProfile(latestDate = null) {
  const cached = peekDragonProfile()
  const fresh =
    cached &&
    cached.version === PROFILE_VERSION &&
    Date.now() - Date.parse(cached.builtAt) < PROFILE_TTL &&
    (!latestDate || cached.latestDate === latestDate)
  if (fresh || profileBuilding) return
  if (Date.now() - profileTriedAt < 1000 * 60 * 2) return
  getDragonProfile({ latestDate }).catch((err) => {
    console.error('[profile]', err && err.message)
  })
}

function profileSummary(profile) {
  if (!profile) return null
  return {
    ok: !!profile.ok,
    builtAt: profile.builtAt,
    latestDate: profile.latestDate,
    days: profile.days,
    coverageDays: profile.coverageDays,
    fromDate: profile.fromDate,
    toDate: profile.toDate,
    sampleStocks: profile.sampleStocks,
    samples: profile.samples,
    freshSamples: profile.freshSamples,
    carriedSamples: profile.carriedSamples,
    stats: profile.stats,
    stale: !!profile.stale
  }
}

/* 画像匹配与弱转强已统一到 gene.js，edge.js 只保留编排逻辑 */

/* ------------------------------------------------------------------ *
 * 盘前竞价
 * ------------------------------------------------------------------ */

function auctionPctScore(pct) {
  if (pct == null) return 0
  if (pct >= 4 && pct <= 5) return 100
  if (pct > 5 && pct <= 7) return 100 - (pct - 5) * 8
  if (pct >= 2 && pct < 4) return 80 + (pct - 2) * 10
  if (pct > 7 && pct <= 9) return Math.max(35, 84 - (pct - 7) * 22)
  if (pct > 9) return Math.max(10, 40 - (pct - 9) * 15)
  if (pct >= 0) return 52 + pct * 14
  if (pct >= -3) return Math.max(10, 48 + pct * 12)
  return 5
}

function auctionAmountScore(amount, ratioPct) {
  if (amount == null) return 0
  let abs
  if (amount >= 1e8) abs = 100
  else if (amount >= 5e7) abs = 92
  else if (amount >= 2e7) abs = 82
  else if (amount >= 1e7) abs = 72
  else if (amount >= 5e6) abs = 60
  else if (amount >= 2e6) abs = 48
  else abs = 30
  if (ratioPct == null) return Math.min(85, abs)
  let ratio
  if (ratioPct >= 10) ratio = 100
  else if (ratioPct >= 5) ratio = 86
  else if (ratioPct >= 3) ratio = 72
  else if (ratioPct >= 1.5) ratio = 56
  else if (ratioPct >= 0.8) ratio = 42
  else ratio = 24
  return abs * 0.55 + ratio * 0.45
}

function priorSealScore(stock) {
  const minutes = sealMinutesFromOpen(stock.firstSeal)
  let timeScore
  if (minutes <= 15) timeScore = 100
  else if (minutes <= 60) timeScore = 86
  else if (minutes <= 120) timeScore = 68
  else if (minutes <= 180) timeScore = 52
  else timeScore = 34
  const ratioScore = clamp((num(stock.sealRatio, 0) / 2) * 100, 0, 100)
  const blowPenalty = Math.min(30, num(stock.blowCount, 0) * 8)
  return clamp(timeScore * 0.62 + ratioScore * 0.38 - blowPenalty, 0, 100)
}

function auctionLabel(status, stageKey) {
  if (status === 'confirm') {
    if (stageKey === 'intraday') return '封板确认'
    if (stageKey === 'locked') return '竞价确认'
    if (stageKey === 'final') return '竞价强势'
    return '仅观察'
  }
  if (status === 'watch') return stageKey === 'intraday' ? '临板 / 跟踪' : '观察'
  return '剔除'
}

/* ------------------------------------------------------------------ *
 * 节点票模型
 * 借鉴公开短线与量化资料里较稳定的四类结构因子：
 *   情绪周期（冰点/退潮/混沌/修复/主升）、空间板与卡位、弱转强、流通市值与连板高度。
 * 这些是排序与过滤因子，不是胜率模型；高位空间板同样可能次日补跌。
 * ------------------------------------------------------------------ */

const NODE_PHASE = { ice: 20, ebb: 36, mixed: 56, repair: 74, feast: 88 }

function sentimentFitOf(sentiment) {
  const s = sentiment || {}
  const key = s.phaseKey || 'mixed'
  let fit = NODE_PHASE[key] != null ? NODE_PHASE[key] : 55
  const signal = s.signal || {}
  if (signal.attack) fit += 5
  if (signal.defense) fit -= 10
  const premium = s.premium && s.premium.avg != null ? num(s.premium.avg, 0) : null
  if (premium != null) fit += premium >= 2 ? 4 : premium >= 0 ? 2 : -6
  const promote =
    s.promotion && s.promotion.overall ? num(s.promotion.overall.rate, null) : null
  if (promote != null) {
    fit += promote >= 50 ? 4 : promote >= 35 ? 2 : promote < 25 ? -6 : 0
  }
  const blowRate = num(s.blowRate, null)
  if (blowRate != null) fit += blowRate <= 18 ? 3 : blowRate >= 40 ? -6 : 0
  return Math.round(clamp(fit, 5, 98))
}

/* 公开研究里短线龙头多集中在中小流通盘；过大弹性弱，过小操控与流动性风险高 */
function capFitOf(capYi) {
  if (!(capYi > 0)) return 50
  if (capYi < 20) return 55
  if (capYi < 30) return 75
  if (capYi < 50) return 92
  if (capYi <= 120) return 100
  if (capYi <= 200) return 88
  if (capYi <= 350) return 70
  if (capYi <= 600) return 52
  return 38
}

/* 连板高度要相对“市场空间板”看：离顶 1 板的卡位价值高，离顶 3 板以上只是跟随 */
function heightFitOf(lbc, maxBoard) {
  const h = num(lbc, 0)
  const max = Math.max(1, num(maxBoard, 0))
  if (h <= 0) return 30
  if (max <= 2) return h >= 2 ? 64 : 50
  if (h >= max) return h <= 4 ? 100 : h === 5 ? 86 : 60
  const gap = max - h
  if (gap === 1) return h >= 3 ? 94 : 78
  if (gap === 2) return h >= 2 ? 72 : 56
  return h >= 2 ? 52 : 40
}

function nodeModelOf(stock, sector, sentiment) {
  const s = stock || {}
  const lbc = num(s.lbc, 0)
  const maxBoard = Math.max(1, num(sentiment && sentiment.maxBoard, 0))
  const phaseKey = (sentiment && sentiment.phaseKey) || 'mixed'
  const signal = (sentiment && sentiment.signal) || {}
  const premium =
    sentiment && sentiment.premium && sentiment.premium.avg != null
      ? num(sentiment.premium.avg, 0)
      : null
  const promote =
    sentiment && sentiment.promotion && sentiment.promotion.overall
      ? num(sentiment.promotion.overall.rate, null)
      : null
  const blowRate = num(sentiment && sentiment.blowRate, null)
  const capYi = num(s.floatCap, 0) / 1e8
  const blow = num(s.blowCount, 0)
  const turnover = num(s.turnover, 0)
  const sealRatio = num(s.sealRatio, 0)
  const minutes = sealMinutesFromOpen(s.firstSeal)
  const weakKind = s.weak && s.weak.kind ? s.weak.kind : ''
  const weakLabel = s.weak && s.weak.label ? s.weak.label : ''
  const sectorMax = num(sector && sector.maxBoard, 0)
  const isLeader = !!(sector && sector.leader && sector.leader.code === s.code)
  const sectorTop = sectorMax > 0 && lbc >= sectorMax
  const gap = Math.max(0, maxBoard - lbc)

  const sentimentFit = sentimentFitOf(sentiment)
  const capFit = capFitOf(capYi)
  const heightFit = heightFitOf(lbc, maxBoard)

  let score = 44
  let role = 'follower'
  let label = '低位跟随'
  const why = []
  const risks = []

  if (maxBoard <= 1) {
    score = lbc >= 1 ? 52 : 40
    label = lbc >= 1 ? '首板节点' : '无高度'
    role = 'fresh'
  } else if (maxBoard === 2) {
    if (lbc >= 2) {
      score = 62
      label = '二板节点'
      role = 'ladder'
      why.push('市场高度仅 2 板，二板就是空间节点')
    } else {
      score = 46
      label = '首板跟随'
      role = 'fresh'
    }
  } else if (lbc >= maxBoard) {
    score = 88
    label = '空间板'
    role = 'space'
    why.push(`市场最高 ${maxBoard} 板，处在空间高度`)
  } else if (gap === 1 && lbc >= 3) {
    score = 78
    label = '卡位节点'
    role = 'pivot'
    why.push(`距空间板 ${gap} 板，龙头分歧时的第一卡位`)
  } else if (gap === 1) {
    score = 66
    label = '次高节点'
    role = 'pivot'
    why.push(`距空间板 ${gap} 板，二板梯队冲板`)
  } else if (gap === 2 && lbc >= 2) {
    score = 56
    label = '梯队节点'
    role = 'ladder'
    why.push(`距空间板 ${gap} 板，属于中位梯队`)
  } else {
    const cleanSeal =
      blow === 0 && sealRatio >= 1.5 && turnover <= 20 && minutes <= 60 && lbc >= 2
    if (cleanSeal) {
      score = 52
      label = '补涨节点'
      role = 'ladder'
      why.push('空间板之外的低位强封核心，走补涨 / 接力')
    } else {
      score = 44
      label = '梯队跟随'
      role = 'follower'
      why.push(`距空间板 ${gap} 板，节点地位弱`)
    }
  }

  if (weakKind === 'downReversal' || weakKind === 'blowReversal' || weakKind === 'lame') {
    score = Math.max(score, weakKind === 'lame' ? 72 : 82)
    label = '转势板'
    role = 'reversal'
    why.unshift(`${weakLabel}，具备情绪修复的转势属性`)
  }

  if (role === 'space' && (phaseKey === 'repair' || phaseKey === 'feast')) {
    label = '破局龙'
    role = 'breaker'
    why.push(`${phaseKey === 'feast' ? '主升发酵' : '修复'}期空间板，负责打开高度`)
    if (signal.attack) score += 4
  }

  let env = 0
  if (phaseKey === 'feast') env += 5
  else if (phaseKey === 'repair') env += 3
  else if (phaseKey === 'ebb') env -= 8
  else if (phaseKey === 'ice') env -= 12
  if (signal.attack) env += 3
  if (signal.defense) env -= 5
  if (premium != null) env += premium >= 2 ? 2 : premium < 0 ? -4 : 0
  if (promote != null) env += promote >= 50 ? 2 : promote < 30 ? -4 : 0
  if (blowRate != null && blowRate >= 40) env -= 4
  env = Math.max(-18, Math.min(10, env))
  score += env

  let quality = 0
  if (blow > 0) quality -= Math.min(12, blow * 2)
  if (turnover > 30) quality -= 8
  else if (turnover > 20) quality -= 4
  if (sealRatio > 0 && sealRatio < 1) quality -= 5
  if (minutes > 120) quality -= 3
  if (isLeader) score += 2
  if (sector && sector.dataReady) score += 2

  score = Math.round(clamp(score + quality, 0, 100))

  const dirty = blow >= 3 || turnover >= 35
  let tone = 'ok'
  if (role === 'breaker' || role === 'space') tone = 'hot'
  if (role === 'follower' || role === 'fresh') tone = 'dim'
  if (dirty) {
    if (role !== 'follower' && role !== 'fresh') tone = 'risk'
    if (role === 'breaker' || role === 'space') label = '高位空间板'
  }
  if (role === 'reversal') tone = dirty ? 'risk' : 'hot'

  if (dirty) {
    risks.push(
      role === 'follower'
        ? `炸板 ${blow} 次 / 换手 ${round(turnover, 1)}%，封板质量打折`
        : `${label}但炸板 ${blow} 次 / 换手 ${round(turnover, 1)}%，只验证不接力`
    )
  }
  if (lbc >= 5) risks.push('高位节点，次日分歧波动放大')
  if (turnover > 0 && turnover < 3) risks.push('换手偏低，缺少分歧换手')
  if (!sector) risks.push('板块缺失，节点缺少共振')
  else if (!sector.dataReady) risks.push('板块三关未过，节点只能观察')
  if (role === 'follower') risks.push('不是空间 / 卡位节点，只是梯队跟随')
  if (signal.defense) risks.push('市场防守窗口，节点票也容易补跌')

  const summary =
    `${label} ${score} 分：空间 ${maxBoard} 板 · ` +
    `${gap === 0 ? '处在最高板' : `距顶 ${gap} 板`} · ` +
    `情绪适配 ${sentimentFit} / 高度适配 ${heightFit} / 市值适配 ${capFit}`

  return {
    score,
    label,
    role,
    tone,
    gap,
    maxBoard,
    sentimentFit,
    capFit,
    heightFit,
    env,
    quality,
    capYi: round(capYi, 1),
    weakKind,
    dirty,
    summary,
    why: why.slice(0, 3),
    risks: Array.from(new Set(risks)).slice(0, 3)
  }
}

function buildNodeBoard(sentiment) {
  const s = sentiment || {}
  const tier = s.tierCounts || {}
  const maxBoard = num(s.maxBoard, 0)
  const phaseKey = s.phaseKey || 'mixed'
  const signal = s.signal || {}
  const premium = s.premium && s.premium.avg != null ? num(s.premium.avg, 0) : null
  const promote =
    s.promotion && s.promotion.overall ? num(s.promotion.overall.rate, null) : null
  const blowRate = num(s.blowRate, null)
  const sentimentFit = sentimentFitOf(s)
  let hint
  if (phaseKey === 'ice') hint = '冰点期不接空间板，等首个转势板确认'
  else if (signal.defense) hint = `防守窗口，节点票也只观察；当前空间 ${maxBoard} 板`
  else if (maxBoard >= 3) {
    hint = `空间板 ${maxBoard} 板；卡位看 ${maxBoard - 1} 板，转势看弱转强回封`
  } else hint = '没有明显空间节点，只做低位确认'
  return {
    maxBoard,
    first: num(tier.first, 0),
    mid: num(tier.mid, 0),
    high: num(tier.high, 0),
    phaseKey,
    phaseLabel: s.phase && s.phase.label ? s.phase.label : '',
    signalLabel: signal.label || '',
    premium,
    promote,
    blowRate,
    sentimentFit,
    hint
  }
}

/* ------------------------------------------------------------------ *
 * 复盘作战室：今日短线拆解、前排过滤、明日晋级估算、能不能出手
 * 晋级概率是启发式估算：用今日实测晋级率做平滑先验，再按节点、封板、
 * 板块、高度、拥挤度修正；不是回测胜率，也不保证次日涨停。
 * ------------------------------------------------------------------ */

const PROMO_PRIORS = {
  first: { rate: 26, k: 14 },
  continuation: { rate: 40, k: 14 }
}

function smoothPromotionRate(block, priorPct, k) {
  const total = num(block && block.total, 0)
  const promoted = num(block && block.promoted, 0)
  const prior = priorPct / 100
  return round(((promoted + prior * k) / (total + k)) * 100, 1)
}

function sealProfileOf(stock) {
  const s = stock || {}
  const floatCap = num(s.floatCap, 0)
  const sealRatio =
    s.sealRatio != null
      ? num(s.sealRatio, 0)
      : floatCap > 0
        ? (num(s.sealFund, 0) / floatCap) * 100
        : 0
  const minutes = sealMinutesFromOpen(s.firstSeal)
  let timeScore
  if (minutes <= 15) timeScore = 100
  else if (minutes <= 60) timeScore = 86
  else if (minutes <= 120) timeScore = 68
  else if (minutes <= 180) timeScore = 52
  else timeScore = 34
  const ratioScore = clamp((sealRatio / 2) * 100, 0, 100)
  const blowPenalty = Math.min(35, num(s.blowCount, 0) * 6)
  return {
    score: Math.round(clamp(timeScore * 0.62 + ratioScore * 0.38 - blowPenalty, 0, 100)),
    sealRatio: round(sealRatio, 2),
    minutes,
    timeScore,
    ratioScore,
    late: minutes > 120,
    veryLate: minutes > 180,
    thin: sealRatio > 0 && sealRatio < 0.8
  }
}

function turnoverQualityOf(turnover) {
  const t = num(turnover, 0)
  if (t <= 0) return 50
  if (t < 3) return 70
  if (t <= 20) return 100
  if (t <= 30) return 68
  if (t <= 50) return 35
  return 15
}

function sectorQualityOf(sector) {
  if (!sector) return 0
  const heat = clamp(num(sector.heat, 0), 0, 100)
  const gates = clamp(num(sector.gatesPassed, 0), 0, 3)
  return round(
    clamp(
      0.55 * heat + 0.25 * (gates / 3) * 100 + 0.2 * (sector.dataReady ? 100 : 0),
      0,
      100
    ),
    1
  )
}

function heightPromoMult(lbc) {
  const h = num(lbc, 0)
  if (h <= 1) return 1
  if (h === 2) return 1.02
  if (h === 3) return 1
  if (h === 4) return 0.92
  return 0.8
}

function nodeThesisOf(node, maxBoard) {
  const n = node || {}
  if (n.role === 'breaker' || n.role === 'space') {
    return `处在 ${maxBoard} 板空间高度，负责打开情绪上限`
  }
  if (n.role === 'pivot') return `卡位空间板下一板，龙头分歧时的第一替补`
  if (n.role === 'reversal') return '弱转强转势，修复期的情绪先锋'
  if (n.role === 'ladder') return '低位强封核心，走补涨 / 接力'
  return '梯队跟随，不具前排地位'
}

function planItemOf(x, rank) {
  const stock = x.stock
  return {
    rank,
    code: stock.code,
    name: stock.name,
    sector: x.sector ? x.sector.name : stock.sector || null,
    lbc: x.lbc,
    nodeScore: x.node.score,
    nodeLabel: x.node.label,
    nodeRole: x.node.role,
    nodeTone: x.node.tone,
    nodeWhy: (x.node.why || []).slice(0, 2),
    nodeRisks: (x.node.risks || []).slice(0, 2),
    promoProb: x.promoProb,
    probLow: Math.max(2, Math.round(x.promoProb - 9)),
    probHigh: Math.min(70, Math.round(x.promoProb + 9)),
    promoQuality: x.promoQuality,
    baseRate: x.baseRate,
    qualityMult: x.qualityMult,
    heightMult: x.heightMult,
    penaltyMult: x.penaltyMult,
    firstSealLabel: sealTimeLabel(stock.firstSeal),
    sealRatio: round(x.seal.sealRatio, 2),
    turnover: round(stock.turnover, 1),
    blowCount: num(stock.blowCount, 0),
    floatCapYi: round(num(stock.floatCap, 0) / 1e8, 1),
    sectorHeat: x.sector ? num(x.sector.heat, 0) : null,
    sectorReady: !!(x.sector && x.sector.dataReady),
    sectorGates: x.sector ? num(x.sector.gatesPassed, 0) : 0,
    sameHeight: x.sameHeight,
    threeCrowd: x.threeCrowd,
    midTrap: x.midTrap,
    weakLabel: (stock.weak && stock.weak.label) || '',
    thesis: x.thesis,
    why: x.why.slice(0, 4),
    risks: x.risks.slice(0, 4),
    riskLevel: x.riskLevel,
    riskShort: x.riskShort,
    leaderScore: x.leaderScore == null ? null : x.leaderScore
  }
}

/* ------------------------------------------------------------------ *
 * 打板客审美：北京炒家 / 92科比 / 全能的野人 的公开打法，拆成可检查条件
 * - 首板套利：板块效应 + 早封 + 换手健康 + 封单不薄
 * - 一进二 / 二进三：低位优先，避开中位；缩量二板是加分项但承接未知
 * - 龙空龙：只做板块内最强，不是龙一就观察；没有合格载体就空仓
 * 这些是审美过滤，不是胜率；三家公开战绩无法在本地复现验证。
 * ------------------------------------------------------------------ */
function hotshotCapScore(floatCap) {
  const yi = num(floatCap, 0) / 1e8
  if (yi <= 0) return 50
  if (yi < 20) return 45
  if (yi < 30) return 70
  if (yi <= 150) return 100
  if (yi <= 250) return 80
  if (yi <= 400) return 55
  return 30
}

function hotshotTurnScore(turnover, lbc) {
  const t = num(turnover, 0)
  if (t <= 0) return 50
  if (lbc >= 2) {
    if (t < 0.8) return 45
    if (t < 3) return 75
    if (t <= 15) return 100
    if (t <= 20) return 85
    if (t <= 30) return 60
    if (t <= 40) return 35
    return 15
  }
  if (t < 1.5) return 35
  if (t < 3) return 70
  if (t <= 15) return 100
  if (t <= 20) return 85
  if (t <= 30) return 65
  if (t <= 40) return 35
  return 15
}

function hotshotHeightScore(lbc, { maxBoard, sameHeight, isLeader }) {
  const h = num(lbc, 1)
  if (h <= 1) return 82
  if (h === 2) return 95
  if (h === 3) return isLeader && sameHeight <= 1 && h >= maxBoard ? 60 : 22
  if (h === 4) return 15
  return 5
}

function hotshotPositionOf(stock, sector, node) {
  if (!sector) return { score: 20, rank: 0, leader: false, count: 0 }
  const stocks = sector.stocks || []
  const idx = stocks.findIndex((s) => s.code === stock.code)
  const leader = idx === 0
  let score = 40
  if (leader) score = 100
  else if (idx === 1) score = 82
  else if (idx === 2) score = 68
  else if (node && node.role !== 'follower') score = 58
  return { score, rank: idx >= 0 ? idx + 1 : stocks.length + 1, leader, count: stocks.length }
}

function hotshotProfileOf({ stock, sector, lbc, sameHeight, maxBoard, node, seal, sectorQ }) {
  const position = hotshotPositionOf(stock, sector, node)
  const capScore = hotshotCapScore(stock.floatCap)
  const turnScore = hotshotTurnScore(stock.turnover, lbc)
  const heightScore = hotshotHeightScore(lbc, {
    maxBoard,
    sameHeight,
    isLeader: position.leader
  })
  const weakScore = num(stock.weak && stock.weak.score, 50)
  const score = round(
    clamp(
      0.3 * seal.score +
        0.18 * sectorQ +
        0.14 * node.score +
        0.12 * heightScore +
        0.08 * capScore +
        0.08 * turnScore +
        0.05 * weakScore +
        0.05 * position.score,
      0,
      100
    ),
    1
  )
  return {
    score,
    position,
    parts: {
      seal: seal.score,
      sector: Math.round(sectorQ),
      node: node.score,
      height: heightScore,
      cap: capScore,
      turnover: turnScore,
      weak: weakScore,
      position: position.score
    }
  }
}

function hotshotTagsOf(x) {
  const tags = []
  const stock = x.stock || {}
  const turnover = num(stock.turnover, 0)
  if (x.lbc === 1) tags.push('北京炒家 · 首板套利', '92科比 · 低位首板')
  if (x.lbc === 2) tags.push('92科比 · 一进二 / 二板核心')
  if (x.lbc === 2 && turnover > 0 && turnover < 3) tags.push('北京炒家 · 缩量二板')
  if (x.hotPosition && x.hotPosition.leader) tags.push('野人 · 龙空龙只做龙一')
  const weakKind = stock.weak && stock.weak.kind
  if (weakKind === 'downReversal' || weakKind === 'blowReversal' || weakKind === 'lame') {
    tags.push('92科比 · 弱转强')
  }
  return Array.from(new Set(tags)).slice(0, 3)
}

function hotshotPlanOf(x) {
  if (x.lbc === 1) {
    return {
      bucket: 'first',
      bucketLabel: '一进二 · 首板强封',
      entry: [
        `竞价 +1%–4%、竞价额 ≥ 今日成交 3%，同板块至少 2 只红盘；9:30–10:30 盯买一，封板前扫板或回封打板。`,
        `高开 >6% 或竞价额 <2%、板块核心走弱、10:30 仍未上板 → 放弃。`
      ],
      giveUp: '低开翻绿、竞价撤单、同板块没有第二只红盘，按失效处理。',
      position: '试错 0.5–1 成；同板块最多 2 只，打板总仓 ≤3 成。'
    }
  }
  if (x.lbc === 2) {
    return {
      bucket: 'second',
      bucketLabel: '二进三 · 二板核心',
      entry: [
        `竞价 +1%–3%、竞价额 ≥ 今日成交 3%，同板块龙头红盘；只做分歧回封或分时均线转强，不接一致高开秒板。`,
        `高开 >5%、竞价撤单、同板块无共振、最高板断板 → 放弃。`
      ],
      giveUp: '高开秒板不追；开板后不能回封，当天不再参与。',
      position: '单票 ≤1 成；与晋级榜重叠时只算一笔，不重复加仓。'
    }
  }
  return {
    bucket: 'third',
    bucketLabel: '三板以上 · 只观察',
    entry: ['三板组与中位三板不进入打板候选，只作为情绪风向标。'],
    giveUp: '不接中位、不接后排。',
    position: '0 成观察。'
  }
}

function buildHotshotSection(items) {
  const list = Array.isArray(items) ? items : []
  const byScore = (a, b) =>
    b.hotScore - a.hotScore ||
    b.promoProb - a.promoProb ||
    b.node.score - a.node.score ||
    b.lbc - a.lbc

  const sectorOk = (x) => {
    if (!x.sector) return false
    const heat = num(x.sector.heat, 0)
    const count = num(x.sector.todayCount, 0)
    const gates = num(x.sector.gatesPassed, 0)
    return (heat >= 45 && count >= 3) || gates >= 1
  }

  const hits = []
  const hitSector = new Map()
  for (const x of list
    .filter((item) => {
      if (item.lbc < 1 || item.lbc > 3) return false
      if (is20cmCode(item.stock.code)) return false
      if (!item.sector || !sectorOk(item)) return false
      if (num(item.stock.blowCount, 0) >= 3 || num(item.stock.turnover, 0) > 40) return false
      if (item.seal.late || item.seal.sealRatio < 0.7) return false
      if (item.threeCrowd || item.midTrap) return false
      if (item.lbc === 3 && item.node.role === 'follower') return false
      return item.hotScore >= 62
    })
    .sort(byScore)) {
    const key = x.sector.name
    const used = hitSector.get(key) || 0
    if (used >= 2) continue
    hitSector.set(key, used + 1)
    hits.push(x)
    if (hits.length >= 5) break
  }

  const readyBase = list
    .filter((x) => {
      const stock = x.stock
      const lbc = x.lbc
      if (lbc < 1 || lbc > 2) return false
      if (is20cmCode(stock.code)) return false
      /* 明日待选只从三关全过的板块里取；只过 1–2 关的降为观察，不降标准补位 */
      if (!x.sector || !x.sector.dataReady) return false
      /* 只做板块龙一：龙一是 3 板或不在 1–2 板范围时，宁可空仓，不拿跟随卡位 */
      if (!x.hotPosition || !x.hotPosition.leader) return false
      if (x.node.tone === 'risk') return false
      if (x.threeCrowd || x.midTrap) return false
      if (!x.seal || x.seal.late || x.seal.sealRatio < 0.7) return false
      if (num(stock.turnover, 0) > 30) return false
      const capYi = num(stock.floatCap, 0) / 1e8
      if (capYi < 20 || capYi > 300) return false
      if (lbc === 1) {
        if (num(stock.blowCount, 0) > 1) return false
        if (num(stock.turnover, 0) < 1.5) return false
        if (x.seal.minutes > 60) return false
      } else {
        if (num(stock.blowCount, 0) > 2) return false
        if (num(stock.turnover, 0) < 0.8) return false
        if (x.node.role === 'follower') return false
      }
      return x.hotScore >= 65
    })
    .sort(byScore)

  const ready = []
  const readySector = new Map()
  const quotaHit = new Set()
  for (const x of readyBase) {
    const key = x.sector.name
    const used = readySector.get(key) || 0
    if (used >= 2) {
      quotaHit.add(x.stock.code)
      continue
    }
    readySector.set(key, used + 1)
    ready.push(x)
    if (ready.length >= 5) break
  }
  ready.forEach((x, i) => {
    x.hotRank = i + 1
  })

  const readySet = new Set(ready.map((x) => x.stock.code))
  const whyWatch = (x) => {
    if (!x.sector || !x.sector.dataReady) {
      return `板块三关未全过（${num(x.sector && x.sector.gatesPassed, 0)}/3），只观察，不进明日待选`
    }
    if (!x.hotPosition || !x.hotPosition.leader) {
      const lead =
        (x.sector.board && x.sector.board.leadName) ||
        (x.sector.stocks && x.sector.stocks[0] && x.sector.stocks[0].name) ||
        '板块龙头'
      return `板块龙一是 ${lead}，本票只是跟随 / 卡位，不进明日待选`
    }
    if (quotaHit.has(x.stock.code)) return '同板块已有 2 只，避免同板块过度集中'
    if (x.seal.late) return `首封 ${sealTimeLabel(x.stock.firstSeal)} 偏晚`
    if (x.seal.thin) return `封单 ${round(x.seal.sealRatio, 2)}% 偏薄`
    if (num(x.stock.blowCount, 0) >= 3) return `炸板 ${num(x.stock.blowCount, 0)} 次`
    if (num(x.stock.turnover, 0) > 30) return `换手 ${round(x.stock.turnover, 1)}% 过热`
    if (x.lbc === 1 && num(x.stock.turnover, 0) < 1.5) {
      return `换手 ${round(x.stock.turnover, 1)}% 偏低，关注度不足`
    }
    const capYi = num(x.stock.floatCap, 0) / 1e8
    if (capYi < 20) return `流通 ${round(capYi, 1)} 亿偏小，波动与操控风险高`
    if (capYi > 300) return `流通 ${round(capYi, 1)} 亿偏大，短线弹性不足`
    if (x.node.role === 'follower') return '节点只是梯队跟随，不是板块前排'
    if (x.lbc === 1 && x.seal.minutes > 60) {
      return `首封 ${sealTimeLabel(x.stock.firstSeal)}，晚于 10:30`
    }
    return x.hotScore >= 65
      ? `审美 ${x.hotScore} 达标，但同板块名额或前排排序未进前 5`
      : `审美分 ${x.hotScore}，未到 65`
  }

  const watch = []
  const watchSector = new Map()
  for (const x of list
    .filter((item) => {
      if (item.lbc < 1 || item.lbc > 2) return false
      if (is20cmCode(item.stock.code)) return false
      if (!item.sector || readySet.has(item.stock.code)) return false
      if (num(item.stock.blowCount, 0) >= 4 || num(item.stock.turnover, 0) > 40) return false
      if (item.seal.veryLate) return false
      const capYi = num(item.stock.floatCap, 0) / 1e8
      if (capYi < 10 || capYi > 400) return false
      return item.hotScore >= 58
    })
    .sort(byScore)) {
    const key = x.sector.name
    const used = watchSector.get(key) || 0
    if (used >= 1) continue
    watchSector.set(key, used + 1)
    watch.push(x)
    if (watch.length >= 3) break
  }

  const todayList = hits.map((x, i) => ({
    rank: i + 1,
    code: x.stock.code,
    name: x.stock.name,
    lbc: x.lbc,
    sector: x.sector.name,
    score: x.hotScore,
    tags: hotshotTagsOf(x),
    why: [
      `${x.lbc} 板 · 首封 ${sealTimeLabel(x.stock.firstSeal)} · ${
        num(x.stock.blowCount, 0) ? `炸 ${num(x.stock.blowCount, 0)} 次` : '0 炸板'
      } · 封单 ${round(x.seal.sealRatio, 2)}% · 换手 ${round(x.stock.turnover, 1)}% · ${round(
        num(x.stock.floatCap, 0) / 1e8,
        1
      )} 亿`,
      `板块「${x.sector.name}」热度 ${num(x.sector.heat, 0)} · 同板 ${num(
        x.sector.todayCount,
        0
      )} 家 · ${
        x.hotPosition.leader ? '板块领涨' : `板块第 ${x.hotPosition.rank} 位`
      } · ${x.sector.dataReady ? '三关全过' : `过 ${num(x.sector.gatesPassed, 0)}/3 关`}`,
      `审美 ${x.hotScore}：封板 ${x.hotParts.seal} / 板块 ${x.hotParts.sector} / 身位 ${x.hotParts.height} / 换手 ${x.hotParts.turnover}`
    ],
    risks: Array.from(
      new Set([
        num(x.stock.floatCap, 0) / 1e8 < 20
          ? `流通仅 ${round(num(x.stock.floatCap, 0) / 1e8, 1)} 亿，波动与操控风险高`
          : '',
        ...x.risks,
        x.hotPosition.leader ? '' : '板块内不是龙一，卡位需竞价确认',
        x.sector.dataReady ? '' : '板块三关未全过，只用热度与家数做参考'
      ])
    )
      .filter(Boolean)
      .slice(0, 3)
  }))

  const tomorrowReady = ready.map((x) => {
    const plan = hotshotPlanOf(x)
    const capYi = round(num(x.stock.floatCap, 0) / 1e8, 1)
    const risks = Array.from(
      new Set([
        ...x.risks,
        !x.hotPosition.leader ? '板块内不是龙一，竞价必须确认卡位' : '',
        !x.sector.dataReady ? '板块三关未全过，只能按热度 / 家数参考' : '',
        x.lbc === 2 && num(x.stock.turnover, 0) < 1.5
          ? '缩量加速，开板承接未知，只打回封 / 首封'
          : '',
        x.lbc === 1 ? '首板尚未建立市场地位，只做一进二验证，不重仓' : ''
      ])
    )
      .filter(Boolean)
      .slice(0, 4)
    return {
      rank: x.hotRank,
      code: x.stock.code,
      name: x.stock.name,
      lbc: x.lbc,
      sector: x.sector.name,
      score: x.hotScore,
      bucket: plan.bucket,
      bucketLabel: plan.bucketLabel,
      tags: hotshotTagsOf(x),
      sealLabel: sealTimeLabel(x.stock.firstSeal),
      sealRatio: round(x.seal.sealRatio, 2),
      turnover: round(x.stock.turnover, 1),
      blowCount: num(x.stock.blowCount, 0),
      floatCapYi: capYi,
      sectorHeat: num(x.sector.heat, 0),
      sectorGates: num(x.sector.gatesPassed, 0),
      sectorCount: num(x.sector.todayCount, 0),
      sectorReady: !!x.sector.dataReady,
      leader: !!x.hotPosition.leader,
      why: [
        `${x.lbc} 板 · 首封 ${sealTimeLabel(x.stock.firstSeal)} · ${
          num(x.stock.blowCount, 0) ? `炸 ${num(x.stock.blowCount, 0)} 次` : '0 炸板'
        } · 封单 ${round(x.seal.sealRatio, 2)}% · 换手 ${round(x.stock.turnover, 1)}% · ${capYi} 亿`,
        `板块「${x.sector.name}」热度 ${num(x.sector.heat, 0)} · 同板 ${num(
          x.sector.todayCount,
          0
        )} 家 · ${x.hotPosition.leader ? '板块领涨' : `板块第 ${x.hotPosition.rank} 位`}`,
        `审美 ${x.hotScore}：${hotshotTagsOf(x).join(' / ')}`
      ],
      entry: plan.entry,
      giveUp: plan.giveUp,
      position: plan.position,
      risks
    }
  })

  const tomorrowWatch = watch.map((x) => ({
    code: x.stock.code,
    name: x.stock.name,
    lbc: x.lbc,
    sector: x.sector.name,
    score: x.hotScore,
    reason: whyWatch(x),
    tags: hotshotTagsOf(x)
  }))

  return {
    today: { count: todayList.length, list: todayList },
    tomorrow: {
      ready: tomorrowReady,
      watch: tomorrowWatch,
      empty: tomorrowReady.length === 0,
      note:
        tomorrowReady.length === 0
          ? '龙空龙：三关全过板块里没有合格的 1–2 板龙一，明天空仓等新核心；不拿跟随 / 只过 1–2 关的票凑数。'
          : `只从三关全过、且是板块龙一的 1–2 板里选，最强 5 只以内、同板块最多 2 只；没有就空仓，符合“有龙做龙，无龙空仓”。`
    },
    notes: [
      '审美分 = 30% 封板 + 18% 板块 + 14% 节点 + 12% 身位 + 8% 市值 + 8% 换手 + 5% 弱转强 + 5% 板块地位；只用于排序，不是胜率。',
      '明日待选只从“三关全过 + 板块龙一”的 1–2 板里取；板块龙头是 3 板或只过 1–2 关时，宁可空仓，不降标准补位。',
      '20cm 标的（科创板 688/689、创业板 300/301）不进入今日命中、明日待选与观察清单；涨停统计仍按全市场。',
      '北京炒家偏好首板套利、板块效应与缩量二板；92科比只做高位龙头或低位首板 / 一进二，避开中位；全能的野人强调龙空龙，不是龙一就空仓。以上来自公开访谈与复盘总结，未验证其宣称胜率。',
      '板块采用行业板块口径，和概念题材不完全等价；打板前必须人工核对催化与同板块是否真的一条主线。',
      '缩量二板是加分项，但开板承接未知；首板换手过低多是关注度不足。'
    ]
  }
}

function buildReviewPlan({ sentiment, gate, pool, sectors, quotesByCode }) {
  const s = sentiment || {}
  const list = Array.isArray(pool) ? pool : []
  const sectorList = Array.isArray(sectors) ? sectors : []
  const quoteMap = quotesByCode || new Map()
  const sectorByCode = new Map()
  const stockMeta = new Map()
  for (const sector of sectorList) {
    for (const st of sector.stocks || []) {
      if (!st || !st.code) continue
      if (!sectorByCode.has(st.code)) sectorByCode.set(st.code, sector)
      if (!stockMeta.has(st.code)) stockMeta.set(st.code, st)
    }
  }

  const sameHeightMap = new Map()
  for (const raw of list) {
    const h = num(raw.lbc, 0)
    if (h > 0) sameHeightMap.set(h, (sameHeightMap.get(h) || 0) + 1)
  }
  const maxBoard = Math.max(1, num(s.maxBoard, 0))
  const spaceCount = sameHeightMap.get(maxBoard) || 0
  const firstCount = sameHeightMap.get(1) || 0
  const twoBoardCount = sameHeightMap.get(2) || 0
  const threeBoardCount = sameHeightMap.get(3) || 0
  const topGap =
    maxBoard >= 4 && !(sameHeightMap.get(maxBoard - 1) > 0) ? maxBoard - 1 : null

  const firstBase = smoothPromotionRate(
    s.promotion && s.promotion.first,
    PROMO_PRIORS.first.rate,
    PROMO_PRIORS.first.k
  )
  const contBase = smoothPromotionRate(
    s.promotion && s.promotion.continuation,
    PROMO_PRIORS.continuation.rate,
    PROMO_PRIORS.continuation.k
  )
  const contTotal = num(s.promotion && s.promotion.continuation && s.promotion.continuation.total, 0)
  const contPromoted = num(s.promotion && s.promotion.continuation && s.promotion.continuation.promoted, 0)

  const items = []
  for (const raw of list) {
    if (!raw || !/^\d{6}$/.test(String(raw.code || ''))) continue
    if (/ST|退/i.test(raw.name || '')) continue
    const meta = stockMeta.get(raw.code) || null
    const sector = sectorByCode.get(raw.code) || null
    const q = quoteMap.get(raw.code) || null
    const stock = {
      ...raw,
      turnover:
        q && q.turnover != null && q.turnover > 0 ? q.turnover : num(raw.turnover, 0),
      sealRatio:
        meta && meta.sealRatio != null
          ? num(meta.sealRatio, 0)
          : num(raw.floatCap, 0) > 0
            ? (num(raw.sealFund, 0) / num(raw.floatCap, 0)) * 100
            : 0,
      weak: (meta && meta.weak) || raw.weak || null
    }
    const lbc = num(stock.lbc, 0)
    const sameHeight = sameHeightMap.get(lbc) || 0
    const node = nodeModelOf(stock, sector, s)
    const seal = sealProfileOf(stock)
    const sectorQ = sectorQualityOf(sector)
    const turnQ = turnoverQualityOf(stock.turnover)
    const weakScore = num(stock.weak && stock.weak.score, 55)
    const quality = round(
      clamp(
        0.3 * node.score +
          0.15 * node.heightFit +
          0.13 * seal.score +
          0.1 * node.capFit +
          0.12 * sectorQ +
          0.1 * turnQ +
          0.05 * weakScore +
          0.05 * node.sentimentFit,
        0,
        100
      ),
      1
    )
    const threeCrowd = lbc === 3 && sameHeight >= 2 && lbc < maxBoard
    const midTrap = lbc >= 3 && lbc < maxBoard && maxBoard - lbc >= 2
    const packMult = sameHeight >= 10 ? 0.78 : sameHeight >= 6 ? 0.85 : sameHeight >= 3 ? 0.92 : 1
    let penalty = 1
    if (node.tone === 'risk') penalty *= 0.78
    if (num(stock.blowCount, 0) >= 3) penalty *= 0.9
    if (num(stock.turnover, 0) > 50) penalty *= 0.75
    else if (num(stock.turnover, 0) > 30) penalty *= 0.85
    if (seal.thin) penalty *= 0.92
    if (seal.late) penalty *= 0.9
    if (lbc >= 2) penalty *= packMult
    if (threeCrowd) penalty *= 0.78
    if (midTrap) penalty *= 0.85
    if (node.role === 'follower') penalty *= 0.85
    if (!sector) penalty *= 0.82
    else {
      if (!sector.dataReady) penalty *= 0.92
      if (num(sector.gatesPassed, 0) < 1) penalty *= 0.9
      if (num(sector.heat, 0) < 30) penalty *= 0.9
    }
    if (lbc === maxBoard && sameHeight === 1 && maxBoard >= 3) penalty *= 1.05
    if (topGap) penalty *= 0.94
    if (lbc >= 2 && num(stock.turnover, 0) < 1.5) penalty *= 0.95

    const baseRate = lbc <= 1 ? firstBase : contBase
    const hMult = heightPromoMult(lbc)
    const qualityMult = 0.42 + 0.78 * (quality / 100)
    const promoProb = round(clamp(baseRate * hMult * qualityMult * penalty, 3, 62), 1)
    const promoQuality = round(quality * penalty, 1)

    const sectorLine = sector
      ? `板块「${sector.name}」热度 ${num(sector.heat, 0)} · ${
          sector.dataReady ? '三关全过' : `过 ${num(sector.gatesPassed, 0)}/3 关`
        }`
      : '无板块归属，孤立涨停'
    const why = [
      `节点 ${node.label} ${node.score}：${node.why[0] || '结构中性'}`,
      `${lbc} 板 · 首封 ${sealTimeLabel(stock.firstSeal)} · 封单 ${round(seal.sealRatio, 2)}% · 换手 ${round(
        stock.turnover,
        1
      )}% · ${round(num(stock.floatCap, 0) / 1e8, 1)} 亿流通`,
      sectorLine,
      `晋级估算：基准 ${baseRate}% × 高度 ${hMult} × 质量 ${round(qualityMult, 2)} × 瑕疵 ${round(
        penalty,
        2
      )}`
    ]
    if (node.why[1]) why.splice(2, 0, node.why[1])
    if (stock.weak && stock.weak.label && stock.weak.kind !== 'fresh') {
      why.push(`弱转强：${stock.weak.label}`)
    }

    const risks = []
    if (num(stock.blowCount, 0) > 0) {
      risks.push(`炸板 ${num(stock.blowCount, 0)} 次，封板稳定性待确认`)
    }
    if (seal.late) risks.push(`首封 ${sealTimeLabel(stock.firstSeal)}，尾盘板主动性弱`)
    if (seal.thin) risks.push(`封单 ${round(seal.sealRatio, 2)}% 偏薄`)
    if (num(stock.blowCount, 0) === 0 && num(stock.turnover, 0) > 0 && num(stock.turnover, 0) < 3) {
      risks.push('换手偏低，缺少分歧检验，警惕一致加速后的兑现')
    }
    if (sector && !sector.dataReady) {
      risks.push(`板块「${sector.name}」未过三关，晋级缺少板块共振`)
    }
    if (lbc >= 2 && sameHeight >= 3) {
      risks.push(`${lbc} 板同高度 ${sameHeight} 家，明日卡位竞争激烈`)
    }
    if (midTrap) risks.push('中位三板 / 距顶两板以上，非卡位核心，先挨分歧')
    if (lbc >= 5) risks.push('高位节点，次日分歧波动放大')
    if (topGap && lbc === maxBoard) risks.push(`${topGap} 板断层，缺少下一板的卡位保护`)
    const hasSectorGateRisk = risks.some((x) => x.includes('三关'))
    const hasLowTurnoverRisk = risks.some((x) => x.includes('换手偏低'))
    for (const risk of node.risks || []) {
      const duplicate =
        risks.includes(risk) ||
        (hasSectorGateRisk && risk.includes('三关')) ||
        (hasLowTurnoverRisk && risk.includes('换手偏低'))
      if (!duplicate) risks.push(risk)
    }
    const riskShort = [
      num(stock.blowCount, 0) >= 3 ? `${num(stock.blowCount, 0)} 次炸板` : '',
      num(stock.turnover, 0) >= 50
        ? `换手 ${round(stock.turnover, 0)}%`
        : num(stock.turnover, 0) >= 30
          ? `换手 ${round(stock.turnover, 1)}%`
          : '',
      seal.late ? `首封 ${sealTimeLabel(stock.firstSeal)}` : '',
      sector && num(sector.gatesPassed, 0) < 1 ? '板块 0 关' : '',
      seal.thin ? '封单薄' : ''
    ]
      .filter(Boolean)
      .slice(0, 3)
      .join(' / ')
    let riskLevel = 'ok'
    if (node.tone === 'risk' || num(stock.blowCount, 0) >= 4 || num(stock.turnover, 0) >= 50) {
      riskLevel = 'high'
    } else if (seal.late || seal.thin || midTrap || (sector && num(sector.gatesPassed, 0) < 1)) {
      riskLevel = 'mid'
    }
    const hot = hotshotProfileOf({
      stock,
      sector,
      lbc,
      sameHeight,
      maxBoard,
      node,
      seal,
      sectorQ
    })

    items.push({
      stock,
      sector,
      lbc,
      sameHeight,
      node,
      seal,
      sectorQ,
      quality,
      penalty,
      baseRate,
      heightMult: hMult,
      qualityMult: round(qualityMult, 2),
      penaltyMult: round(penalty, 2),
      promoProb,
      promoQuality,
      threeCrowd,
      midTrap,
      riskLevel,
      riskShort: riskShort || '结构一般',
      thesis: nodeThesisOf(node, maxBoard),
      why,
      risks: Array.from(new Set(risks)).slice(0, 5),
      hotScore: hot.score,
      hotParts: hot.parts,
      hotPosition: hot.position
    })
  }

  /* 推荐口径：20cm 不进入晋级榜 / 龙头 / 高位观察 / 剔除池 / 打板客，只留在涨停统计 */
  const recommendable = items.filter((x) => !is20cmCode(x.stock.code))

  const qualifiedAll = recommendable
    .filter(
      (x) =>
        x.lbc >= 2 &&
        x.lbc <= 5 &&
        x.node.score >= 50 &&
        x.node.tone !== 'risk' &&
        num(x.stock.blowCount, 0) <= 2 &&
        num(x.stock.turnover, 0) <= 30 &&
        x.seal.sealRatio >= 0.7 &&
        !x.seal.late &&
        !x.threeCrowd &&
        !x.midTrap &&
        x.node.role !== 'follower' &&
        x.sector &&
        (x.sector.dataReady ||
          (num(x.sector.gatesPassed, 0) >= 1 && num(x.sector.heat, 0) >= 40))
    )
    .map((x) => {
      const weakScore = num(x.stock.weak && x.stock.weak.score, 55)
      const leaderScore = round(
        clamp(
          0.42 * x.node.score +
            0.16 * x.node.heightFit +
            0.1 * x.node.capFit +
            0.14 * x.seal.score +
            0.12 * x.sectorQ +
            0.06 * weakScore -
            (x.seal.late ? 4 : 0),
          0,
          100
        ),
        1
      )
      return { ...x, leaderScore }
    })
    .sort(
      (a, b) =>
        b.promoProb - a.promoProb ||
        b.node.score - a.node.score ||
        b.leaderScore - a.leaderScore
    )
  qualifiedAll.forEach((x, i) => {
    x.rank = i + 1
  })
  const qualified = qualifiedAll.slice(0, 5)

  const qualifiedSet = new Set(qualifiedAll.map((x) => x.stock.code))
  const heightWatch = recommendable
    .filter((x) => x.lbc === maxBoard && !qualifiedSet.has(x.stock.code))
    .sort(
      (a, b) =>
        Number(b.riskLevel === 'high') - Number(a.riskLevel === 'high') ||
        b.lbc - a.lbc ||
        b.node.score - a.node.score
    )
    .slice(0, 3)
  const watchSet = new Set(heightWatch.map((x) => x.stock.code))

  function junkReasons(x) {
    const reasons = []
    const blow = num(x.stock.blowCount, 0)
    const turnover = num(x.stock.turnover, 0)
    if (x.node.tone === 'risk' || blow >= 3) {
      reasons.push(
        `炸板 ${blow} 次${turnover >= 25 ? ` / 换手 ${round(turnover, 1)}%` : ''}，封板质量不合格`
      )
    }
    if (x.threeCrowd) reasons.push(`三板组 ${x.sameHeight} 家，非唯一核心`)
    else if (x.midTrap) reasons.push(`距顶 ${maxBoard - x.lbc} 板，中位股先挨分歧`)
    if (x.seal.late) reasons.push(`首封 ${sealTimeLabel(x.stock.firstSeal)}，主动性不足`)
    if (x.seal.thin) reasons.push(`封单 ${round(x.seal.sealRatio, 2)}% 偏薄`)
    if (x.node.role === 'follower') reasons.push('节点只是梯队跟随，不是前排')
    if (!x.sector) reasons.push('无板块归属，孤立涨停')
    else if (num(x.sector.heat, 0) < 35) {
      reasons.push(`板块「${x.sector.name}」热度 ${num(x.sector.heat, 0)} 偏低`)
    }
    if (num(x.stock.floatCap, 0) / 1e8 >= 80) {
      reasons.push(`流通 ${round(num(x.stock.floatCap, 0) / 1e8, 1)} 亿，容量偏大`)
    }
    if (!reasons.length) reasons.push('综合节点 / 封板 / 板块评分不足')
    return Array.from(new Set(reasons)).slice(0, 3)
  }

  const rejectedPool = recommendable
    .filter(
      (x) => x.lbc >= 2 && !qualifiedSet.has(x.stock.code) && !watchSet.has(x.stock.code)
    )
    .sort(
      (a, b) =>
        b.lbc - a.lbc ||
        Number(b.node.tone === 'risk') - Number(a.node.tone === 'risk') ||
        num(b.stock.blowCount, 0) - num(a.stock.blowCount, 0) ||
        b.node.score - a.node.score
    )
  const rejectedSamples = rejectedPool.slice(0, 4).map((x) => ({
    code: x.stock.code,
    name: x.stock.name,
    sector: x.sector ? x.sector.name : null,
    lbc: x.lbc,
    nodeScore: x.node.score,
    nodeLabel: x.node.label,
    nodeTone: x.node.tone,
    category: x.threeCrowd
      ? '三板组'
      : x.midTrap
        ? '中位三板'
        : x.node.tone === 'risk'
          ? '脏板'
          : x.seal.late
            ? '尾盘板'
            : x.node.role === 'follower'
              ? '后排跟随'
              : '杂毛',
    reasons: junkReasons(x)
  }))

  const promotionRate =
    s.promotion && s.promotion.overall ? num(s.promotion.overall.rate, null) : null
  const premiumAvg =
    s.premium && s.premium.avg != null && !s.premium.skip ? num(s.premium.avg, 0) : null
  const blowRate = num(s.blowRate, 0)
  const signal = s.signal || {}
  const phaseLabel = s.phase && s.phase.label ? s.phase.label : '情绪待定'
  const defense = !!signal.defense || s.phaseKey === 'ice' || s.phaseKey === 'ebb'
  const highRisk = heightWatch.some((x) => x.riskLevel === 'high')
  const divergence =
    blowRate >= 30 ||
    highRisk ||
    heightWatch.length > 0 ||
    items.some((x) => x.threeCrowd) ||
    !!topGap

  const leadNames = qualified
    .slice(0, 2)
    .map((x) => x.stock.name)
    .join(' / ')
  let action
  if (!gate || gate.key === 'empty') {
    action = {
      canAct: 'no',
      label: '不能出手 · 空仓等待',
      tone: 'risk',
      position: '0 成',
      summary: `板块三关没有全过，情绪再好也缺少主线载体。明天只记录最强核心，不开新仓。`
    }
  } else if (defense) {
    action = {
      canAct: 'no',
      label: '不能出手 · 只观察核心',
      tone: 'risk',
      position: '0 成',
      summary: `情绪处在「${phaseLabel}」或防守窗口：弱势切核心抱团，只留最高板与唯一核心观察；核心不封板就空仓。`
    }
  } else if (!qualified.length) {
    action = {
      canAct: 'watch',
      label: '只观察 · 等新核心',
      tone: 'dim',
      position: '0 成观察',
      summary: `环境不差但前排全部不合格：高位脏板、后排杂毛、三板组都不接。等新的干净核心出现，不为了交易而交易。`
    }
  } else if (divergence) {
    action = {
      canAct: 'conditional',
      label: '能出手 · 只做分歧核心',
      tone: 'warn',
      position: '≤2 成，单票 ≤1 成',
      summary:
        `情绪 ${s.score == null ? '--' : s.score} 分「${phaseLabel}」，晋级 ${
          promotionRate == null ? '--' : promotionRate + '%'
        }、炸板率 ${blowRate}%，环境不差；` +
        `${topGap ? `${topGap} 板断层，` : ''}${
          heightWatch.length
            ? `高位 ${heightWatch.map((x) => x.stock.name).join('、')} 不适合接力，`
            : ''
        }${items.some((x) => x.threeCrowd) ? '三板组拥挤，' : ''}` +
        `所以明天只做 ${leadNames} 的分歧回封，不追高、不接后排。`
    }
  } else if (signal.attack) {
    action = {
      canAct: 'small',
      label: '可小仓试错核心',
      tone: 'ok',
      position: '≤3 成，单票 ≤1 成',
      summary: `情绪与晋级率同步走强，结构没有明显断层。只做 ${leadNames} 的最强核心，分歧低吸 / 回封确认，不买后排补涨。`
    }
  } else {
    action = {
      canAct: 'watch',
      label: '轻仓观察核心',
      tone: 'dim',
      position: '0–1 成',
      summary: `环境属于观察窗口：只跟最强核心，等晋级率回到 35% 以上或核心分歧回封，再考虑出手。`
    }
  }
  action.scenarios = [
    {
      key: 'weak',
      title: '弱势切核心抱团',
      active: defense,
      text: `晋级率跌破 30% 或炸板率升破 40% 时：删除所有后排与补涨，只抱最高板 / 唯一核心；核心不封板就空仓，不低吸跟风。`
    },
    {
      key: 'diverge',
      title: '分歧切核心',
      active: divergence && !defense,
      text: `高位出现炸板或断板时：只做最强核心的回封 / 分时转强，不接中位股和后排；核心不回封，当天不交易。`
    }
  ]
  action.triggers = [
    `竞价：${leadNames || '核心候选'} 高开 1%–4%，竞价额 ≥ 今日成交 3%，同板块至少 1 只核心同步红盘；否则放弃。`,
    '开盘：只等核心分歧回封 / 分时均线转强；高开秒板不追，后排补涨不做。',
    '风控：晋级率 < 30% 或炸板率 > 40%，或最高板断板，当天直接空仓。',
    '新周期：若出现新题材 ≥ 3 家首板且龙头一字，老核心降为观察，等第二日确认。'
  ]
  action.doNot = [
    ...heightWatch.slice(0, 2).map((x) => `不接 ${x.stock.name}：${x.riskShort}`),
    ...rejectedPool
      .filter((x) => x.lbc >= 3)
      .slice(0, 1)
      .map((x) => `不接 ${x.stock.name}（${x.lbc} 板）：${junkReasons(x)[0]}`),
    ...(topGap ? [`不把 ${topGap} 板断层期的孤板默认当总龙头`] : []),
    '不做首板后排 / 补涨杂毛；不在一致高开时追核心'
  ].slice(0, 5)

  const leaderRanked = qualifiedAll
    .slice()
    .sort((a, b) => b.leaderScore - a.leaderScore || b.promoProb - a.promoProb)
  let leader = null
  if (leaderRanked.length) {
    const x = leaderRanked[0]
    const base = planItemOf(x, x.rank)
    leader = {
      ...base,
      tag: x.lbc >= maxBoard ? '空间核心' : '接棒核心候选',
      note:
        x.lbc >= maxBoard
          ? `当前空间核心，但高位分歧放大；只做回封确认，不接一致加速。`
          : `当前是 ${x.lbc} 板核心，距最高板 ${maxBoard - x.lbc} 板；只有最高板断板、且自身分歧回封，才谈接棒，不是现在就能追。`,
      why: [
        ...base.why,
        `合格前排中龙头评分 ${x.leaderScore} 第一，晋级估算 ${x.promoProb}%`
      ].slice(0, 5)
    }
  }

  const spaceDetail = heightWatch.length
    ? heightWatch
        .map((x) => `${x.stock.name} ${x.lbc} 板：${x.riskShort}`)
        .join('；')
    : '结构待确认'
  const threeBoardItems = recommendable.filter((x) => x.lbc === 3)
  const threeBoardText = threeBoardItems.length
    ? threeBoardItems
        .map((x) => `${x.stock.name}（${x.riskShort}${x.midTrap ? ' / 中位三板' : ''}）`)
        .join('、')
    : '3 板断档'
  const review = [
    `情绪：涨停 ${num(s.limitUp, 0)} 家，炸板率 ${blowRate}%，昨日涨停溢价 ${
      premiumAvg == null ? '待更新' : round(premiumAvg, 2) + '%'
    }，${phaseLabel} / ${signal.label || '观察窗口'}。`,
    `高度：最高 ${maxBoard} 板 ${spaceCount} 家（${spaceDetail}）；${
      topGap ? `${topGap} 板断层，` : ''
    }3 板 ${threeBoardCount} 家，2 板 ${twoBoardCount} 家。`,
    `中位：${threeBoardText}。2 板同高度竞争激烈，只留封板最干净、板块有共振的核心。`,
    `前排：2 板+ ${recommendable.filter((x) => x.lbc >= 2).length} 只，合格 ${
      qualifiedAll.length
    } 只${
      qualified.length
        ? `（${qualified
            .slice(0, 3)
            .map((x) => x.stock.name)
            .join('、')}${qualifiedAll.length > 3 ? ' 等' : ''}）`
        : ''
    }；剔除 ${rejectedPool.length + heightWatch.length} 只（高位观察 ${heightWatch.length} · 后排剔除 ${rejectedPool.length}）。`,
    '口径：涨停家数与高度统计为全市场；推荐、晋级榜、龙头与明日待选剔除科创板 688/689、创业板 300/301 的 20cm。'
  ]

  return {
    generatedAt: new Date().toISOString(),
    headline: `${phaseLabel} · ${signal.label || '观察窗口'}：${maxBoard} 板 ${spaceCount} 家，${
      topGap ? `${topGap} 板断层，` : ''
    }2 板 ${twoBoardCount} 家；前排合格 ${qualifiedAll.length} 只。`,
    action,
    leader,
    promotionRank: qualified.map((x) => planItemOf(x, x.rank)),
    hotshot: buildHotshotSection(recommendable),
    heightWatch: heightWatch.map((x) => planItemOf(x, null)),
    rejected: {
      total: rejectedPool.length,
      samples: rejectedSamples
    },
    review,
    heights: Array.from(sameHeightMap.entries())
      .sort((a, b) => b[0] - a[0])
      .slice(0, 8)
      .map(([lbc, count]) => ({ lbc, count })),
    maxBoard,
    spaceCount,
    topGap,
    firstCount,
    twoBoardCount,
    threeBoardCount,
    threeCrowdCount: items.filter((x) => x.threeCrowd).length,
    qualifiedCount: qualifiedAll.length,
    rejectedCount: rejectedPool.length + heightWatch.length,
    baseRates: { first: firstBase, continuation: contBase },
    notes: [
      '晋级概率 = 今日实测晋级率平滑先验 × 高度系数 × 前排质量 × 瑕疵折扣；是排序工具，不是胜率，误差很大。',
      contTotal < 10
        ? `今日连板晋级实测样本仅 ${contTotal} 只（${contPromoted}/${contTotal}），平滑后 ${contBase}% 主要受先验约束；小样本不能外推为明日真实胜率。`
        : `今日连板晋级实测 ${contPromoted}/${contTotal}（${contBase}%），已做先验平滑，仍需明日竞价与板块共振验证。`,
      `首板 ${firstCount} 家不逐一给概率，只统计首板→二板整体水平（平滑后 ${firstBase}%）。`,
      '三板组 = 同高度 ≥2 且非最高板，默认剔除；距顶两板以上的中位三板也不进前排。',
      '弱势切核心抱团、分歧切核心：都只做最强核心，后排杂毛不参与。',
      '研究用途，不构成投资建议；样本外失效、风格切换都可能导致亏损。'
    ]
  }
}

/* 准备池统一公式：基因 30 + 基础 14 + 热度 10 + 弱转强 8 + 情绪 10 + 节点 12 + 高度 10 + 市值 6 */
function prepBaseScore({ gene, base, heat, weak, sentimentFit, node, heightFit, capFit }) {
  return Math.round(
    clamp(
      0.3 * num(gene, 50) +
        0.14 * num(base, 50) +
        0.1 * num(heat, 40) +
        0.08 * num(weak, 50) +
        0.1 * num(sentimentFit, 50) +
        0.12 * num(node, 45) +
        0.1 * num(heightFit, 50) +
        0.06 * num(capFit, 50),
      0,
      99
    )
  )
}

/* ------------------------------------------------------------------ *
 * 准备池候选：选股结果 + 各主线板块龙头 + 各板块强封核心
 * 选股分会被炸板 / 过热换手重罚，龙头可能因此掉出前 8；
 * 准备池必须把板块最高板龙头找回来，并把罚分原因明示，而不是静默消失。
 * 同时补入“不是板块最高板、但封板质量更干净”的核心票（如 2 板 0 炸、封单厚、换手低），
 * 否则只看龙头会漏掉真正的连板核心，把分歧中军排到第一。
 * ------------------------------------------------------------------ */

function coreAdjustOf(stock, sector) {
  const blow = num(stock && stock.blowCount, 0)
  const turnover = num(stock && stock.turnover, 0)
  const capYi = num(stock && stock.floatCap, 0) / 1e8
  const amountYi = num(stock && stock.amount, 0) / 1e8
  const sealRatio = num(stock && stock.sealRatio, 0)
  const minutes = sealMinutesFromOpen(stock && stock.firstSeal)
  const lbc = num(stock && stock.lbc, 0)

  const penalties = []
  let total = 0
  function add(points, text) {
    if (points > 0) {
      total += points
      penalties.push(`${text} -${points}`)
    }
  }

  add(Math.min(24, blow * 4), `炸板 ${blow} 次`)
  if (turnover > 20) add(Math.min(14, Math.round((turnover - 20) * 0.6)), `换手 ${round(turnover, 1)}% 过热`)
  if (sealRatio > 0 && sealRatio < 1) add(6, `封单 ${round(sealRatio, 2)}% 偏薄`)
  if (capYi > 0 && capYi < 20) add(4, '流通盘 <20 亿')
  if (minutes > 60) add(4, '首封晚于 10:30')
  if (lbc >= 5) add(6, '高位 5 板+')

  const mid = (capYi >= 80 && amountYi >= 10) || capYi >= 200
  if (mid) add(4, '容量中军')

  let label = '核心先锋'
  if (lbc >= 5 && (blow >= 3 || turnover >= 35)) label = '高位分歧'
  else if (mid) label = '容量中军'
  else if (blow > 0 || turnover > 20) label = '分歧转强'

  return {
    total: Math.min(60, total),
    penalties,
    label,
    mid,
    strongSeal:
      blow === 0 &&
      sealRatio >= 1.5 &&
      turnover <= 20 &&
      minutes <= 60 &&
      lbc >= 2,
    capYi: round(capYi, 1),
    amountYi: round(amountYi, 1)
  }
}

function candidateUniverse(dashboard) {
  const sectors = (dashboard.sectors && dashboard.sectors.all) || []
  const sectorByKey = new Map(sectors.map((s) => [s.key, s]))
  const entries = new Map()
  const picks = dashboard.picks || []
  const ordered = picks
    .filter((p) => p && p.role !== 'mid')
    .concat(picks.filter((p) => p && p.role === 'mid'))
  for (const p of ordered) {
    if (!p || !p.code || entries.has(p.code)) continue
    entries.set(p.code, { stock: p, sector: sectorByKey.get(p.sectorKey) || null })
  }
  for (const sector of sectors) {
    const leader = sector && sector.leader
    if (!leader || !leader.code || entries.has(leader.code)) continue
    const relevant = sector.dataReady || sector.group === 'main' || sector.group === 'new'
    if (!relevant) continue
    if (!(sector.maxBoard >= 2) && !sector.dataReady) continue
    entries.set(leader.code, {
      stock: {
        ...leader,
        sector: sector.name,
        sectorKey: sector.key,
        role: 'dragon',
        roleLabel: sector.maxBoard >= 2 ? '板块龙头' : '首板先锋',
        baseScore: null,
        fromSectorLeader: true
      },
      sector
    })
  }
  for (const sector of sectors) {
    const relevant = sector.dataReady || sector.group === 'main' || sector.group === 'new'
    if (!relevant) continue
    if (num(sector.heat, 0) < 45) continue
    for (const stock of sector.stocks || []) {
      if (!stock || !stock.code || entries.has(stock.code)) continue
      if (!/^\d{6}$/.test(stock.code)) continue
      if (/ST|退/i.test(stock.name || '')) continue
      if (num(stock.lbc, 0) < 2) continue
      if (num(stock.price, null) == null) continue
      const core = coreAdjustOf(stock, sector)
      entries.set(stock.code, {
        stock: {
          ...stock,
          sector: sector.name,
          sectorKey: sector.key,
          role: 'core',
          roleLabel: core.label,
          baseScore: null,
          coreClass: core.label,
          fromCoreScan: true
        },
        sector
      })
    }
  }
  return { entries: Array.from(entries.values()), sectorByKey }
}

/* 准备池排序：只收 2 板以上连板核心；多因子后做核心修正 */
function prepRank(entries, sentiment, profile) {
  return entries
    .filter((e) => e.stock && num(e.stock.price, null) != null)
    /* 准备池 / 隔夜推荐只做非 20cm；双创留给用户自己复盘，不进入推荐 */
    .filter((e) => !is20cmCode(e.stock.code))
    .filter((e) => num(e.stock.lbc, 0) >= 2)
    .filter((e) => {
      const s = e.sector
      if (!s) return false
      if (s.dataReady) return true
      const heat = num(s.heat, 0)
      const gates = num(s.gatesPassed, 0)
      return (s.group === 'main' || s.group === 'new') && heat >= 40 && gates >= 1
    })
    .map((e) => {
      const sector = e.sector
      const gene =
        e.stock.gene ||
        geneScore({
          stock: e.stock,
          sector,
          weak: e.stock.weak,
          sentiment,
          profile
        })
      const base = num(
        e.stock.baseScore != null ? e.stock.baseScore : e.stock.score,
        gene.fit && gene.fit.staticScore != null ? gene.fit.staticScore : 60
      )
      const heat = sector && sector.heat != null ? sector.heat : 40
      const weakScore = gene.weak && gene.weak.score != null ? gene.weak.score : 50
      const node = nodeModelOf(
        { ...e.stock, weak: e.stock.weak || gene.weak || null },
        sector,
        sentiment
      )
      const basePrep = prepBaseScore({
        gene: gene.score,
        base,
        heat,
        weak: weakScore,
        sentimentFit: node.sentimentFit,
        node: node.score,
        heightFit: node.heightFit,
        capFit: node.capFit
      })
      const core = coreAdjustOf(e.stock, sector)
      const prepScore = Math.round(clamp(basePrep - core.total, 0, 99))
      return { ...e, gene, core, node, basePrep, prepScore }
    })
    .sort(
      (a, b) =>
        b.prepScore - a.prepScore ||
        a.core.total - b.core.total ||
        b.node.score - a.node.score ||
        b.gene.score - a.gene.score
    )
}

/* 下一场竞价准备池：取最强 5 只，逐只解释入选原因与风险 */
function buildPreview(dashboard, profile) {
  const sentiment = dashboard.sentiment
  const ranked = prepRank(candidateUniverse(dashboard).entries, sentiment, profile)
  return ranked
    .filter((x) => x.prepScore >= 40)
    .slice(0, 5)
    .map(({ stock: p, sector, gene, core, node, basePrep, prepScore }, i) => {
    const fit = gene.fit
    const close = num(p.price, null)
    const limitRatio = limitRatioFor(p.code)
    const limitUp = close == null ? null : round(close * (1 + limitRatio), 2)
    const base = num(
      p.baseScore != null ? p.baseScore : p.score,
      fit && fit.staticScore != null ? fit.staticScore : 60
    )
    const heat = sector && sector.heat != null ? sector.heat : null
    const acceptable =
      !!(sector && sector.dataReady) &&
      fit.score >= 55 &&
      num(p.score != null ? p.score : base, 0) >= 65 &&
      p.lbc >= 2 &&
      p.lbc <= 5 &&
      !(p.blowCount > 0) &&
      node.score >= 50 &&
      node.tone !== 'risk'
    const coreWhy =
      core.total > 0
        ? `核心修正 -${core.total}：${core.penalties.join(' · ')}`
        : `核心校验：无炸板/过热/薄封扣分，${core.label}`
    const nodeLine =
      `节点 ${node.label} ${node.score}：${node.why[0] || '节点中性'}` +
      ` · 情绪适配 ${node.sentimentFit} / 高度适配 ${node.heightFit} / 市值适配 ${node.capFit}`
    const why = [
      `准备池 ${prepScore} 分（修正前 ${basePrep}）：基因 ${gene.score} / 基础分 ${base} / 热度 ${heat == null ? '--' : heat} / 弱转强 ${gene.weak ? gene.weak.label : '--'}`,
      nodeLine,
      coreWhy,
      ...(p.fromSectorLeader
        ? [`${sector ? sector.name : p.sector || '板块'} ${p.lbc} 板龙头，被炸板 / 换手惩罚后仍纳入核验`]
        : []),
      ...(p.fromCoreScan
        ? [`板块内${core.strongSeal ? '强封核心' : '连板补充'}（非最高板）：${p.lbc} 板 · ${p.blowCount === 0 ? '0 炸板' : `炸 ${p.blowCount} 次`} · 换手 ${round(p.turnover, 1)}%`]
        : []),
      ...(gene.why || [])
    ]
    return {
      rank: i + 1,
      code: p.code,
      name: p.name,
      sector: p.sector || (sector ? sector.name : null),
      sectorKey: p.sectorKey,
      role: p.role,
      roleLabel: p.roleLabel,
      coreLabel: core.label,
      coreAdjust: core.total,
      corePenalties: core.penalties,
      coreWhy,
      strongSeal: !!core.strongSeal,
      fromCoreScan: !!p.fromCoreScan,
      node,
      nodeScore: node.score,
      nodeLabel: node.label,
      nodeTone: node.tone,
      nodeWhy: node.why,
      nodeRisks: node.risks,
      nodeSummary: node.summary,
      sentimentFit: node.sentimentFit,
      capFit: node.capFit,
      heightFit: node.heightFit,
      marketMax: node.maxBoard,
      nodeGap: node.gap,
      lbc: p.lbc,
      price: close,
      limitRatio,
      boardRule: boardRuleLabel(p.code),
      limitUp,
      score: num(p.score, 0),
      baseScore: base,
      basePrep,
      prepScore,
      geneScore: gene.score,
      weak: p.weak || gene.weak || null,
      weakLabel: gene.weakLabel,
      observation: !acceptable,
      acceptable,
      firstSealLabel: p.firstSealLabel,
      sealRatio: p.sealRatio,
      turnover: p.turnover,
      floatCap: p.floatCap,
      heat,
      dataReady: !!(sector && sector.dataReady),
      tags: [
        ...(acceptable ? ['隔夜候选'] : ['观察池']),
        ...(p.roleLabel ? [p.roleLabel] : []),
        core.label,
        ...(node.tone === 'risk' ? ['节点风险'] : []),
        ...(core.strongSeal ? ['强封核心'] : []),
        ...(gene.tags || [])
      ]
        .filter((v, idx, arr) => arr.indexOf(v) === idx)
        .slice(0, 6),
      factors: gene.factors,
      why: why.slice(0, 7),
      risks: Array.from(
        new Set([
          ...(gene.risks || []),
          ...(node.risks || []),
          ...(core.mid ? ['容量中军，短线弹性弱于小盘核心'] : []),
          ...(core.label === '高位分歧' ? ['高位分歧，次日只观察不接力'] : []),
          ...(p.fromCoreScan ? ['非板块最高板，需同板块龙头同步走强'] : [])
        ])
      ).slice(0, 5),
      fit,
      plan: [
        '明日竞价高开 1%–4% 才执行；高于 6% 放弃，低于 -2% 放弃',
        '竞价额不低于今日成交 3%，同板块至少 1 只核心同步高开',
        `涨停价参考 ${limitUp == null ? '--' : limitUp}（${boardRuleLabel(p.code)}），只挂条件单，不追一字`,
        '催化未核验不下单；开盘跌破分时均线先退出'
      ]
    }
  })
}

async function buildAuction({ dashboard, profile = null, now = beijingNow() }) {
  const market = marketStatus(now)
  const stage = auctionStage(market)
  const latest = await getLatestTradingPool(dateStamp(now))
  const pool = latest && latest.items ? latest.items : []
  const sectorByName = new Map(
    (dashboard.sectors && dashboard.sectors.all ? dashboard.sectors.all : []).map((s) => [s.name, s])
  )
  const sectorByKey = new Map(
    (dashboard.sectors && dashboard.sectors.all ? dashboard.sectors.all : []).map((s) => [s.key, s])
  )
  const sectorList = (dashboard.sectors && dashboard.sectors.all) || []

  if (!stage.active) {
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      market,
      stage,
      tradeDate: latest ? latest.date : dashboard.tradeDate,
      tradeDateLabel: latest ? normalizeDateLabel(latest.date) : dashboard.tradeDateLabel,
      sentiment: {
        score: dashboard.sentiment ? dashboard.sentiment.score : null,
        phaseKey: dashboard.sentiment ? dashboard.sentiment.phaseKey : null,
        phase: dashboard.sentiment ? dashboard.sentiment.phase : null
      },
      gate: dashboard.gate,
      nodeBoard: buildNodeBoard(dashboard.sentiment),
      active: false,
      intraday: false,
      universe: pool.length,
      strongCount: 0,
      watchCount: 0,
      candidates: [],
      preview: buildPreview(dashboard, profile),
      notes: [
        stage.note,
        '非交易时段不计算竞价 / 盘中分，避免把历史涨幅伪装成实时强度。',
        '下方准备池按节点、情绪、连板高度、流通市值、弱转强与封板质量选最强 5 只，用于下一场竞价前准备。',
        '准备池与竞价榜剔除科创板 688/689、创业板 300/301 的 20cm 标的；不是没有行情，而是不进入本工具的推荐口径。',
        profile ? '准备池已叠加老龙头画像匹配；画像只是样本统计，不是准确率。' : '老龙头画像尚未就绪，当前只展示基础条件。'
      ],
      source: '东方财富涨停池 + 腾讯行情；竞价 9:15–9:30 / 盘中 9:30–15:00 计算'
    }
  }

  /* 弱转强上下文：盘中比较今日与昨日；竞价阶段最新池本身就是昨日涨停 */
  let weakCtx
  if (stage.intraday) {
    const prev = dashboard.prevContext
    weakCtx = buildWeakContext({
      prevPool: (prev && prev.zt) || [],
      prevBlow: (prev && prev.blow) || [],
      prevDown: (prev && prev.down) || []
    })
  } else if (latest) {
    const [zbRes, dtRes] = await Promise.allSettled([
      getPool(latest.date, 'zb'),
      getPool(latest.date, 'dt')
    ])
    weakCtx = buildWeakContext({
      prevPool: pool,
      prevBlow: zbRes.status === 'fulfilled' ? zbRes.value.items || [] : [],
      prevDown: dtRes.status === 'fulfilled' ? dtRes.value.items || [] : []
    })
  } else {
    weakCtx = buildWeakContext({})
  }

  function matchSectorLoose(name) {
    if (!name) return null
    const direct = sectorByName.get(name)
    if (direct) return direct
    const n = stripLevel(name)
    if (!n) return null
    for (const s of sectorList) {
      const sn = stripLevel(s.name)
      if (sn && (sn.includes(n) || n.includes(sn))) return s
    }
    return null
  }

  const map = new Map()
  for (const stock of pool) {
    if (!stock.code || /ST/i.test(stock.name || '')) continue
    if (!/^\d{6}$/.test(stock.code)) continue
    const sector = sectorByName.get(stock.sector) || null
    const sealRatio = sealRatioOf(stock)
    map.set(stock.code, {
      code: stock.code,
      secid: stock.secid,
      name: stock.name,
      sector: stock.sector || '未分类',
      sectorKey: stock.sector,
      lbc: stock.lbc,
      price: stock.price,
      turnover: stock.turnover,
      amount: stock.amount,
      prevAmount: stage.intraday ? null : stock.amount,
      floatCap: stock.floatCap,
      sealRatio: round(sealRatio, 2),
      sealFund: stock.sealFund,
      firstSeal: stock.firstSeal,
      firstSealLabel: sealTimeLabel(stock.firstSeal),
      blowCount: stock.blowCount,
      ztDays: stock.ztDays,
      fromPool: true,
      sectorRef: sector,
      sectorHeat: sector ? sector.heat : null,
      sectorGroup: sector ? sector.group : null,
      sectorReady: !!(sector && sector.dataReady),
      sectorTodayCount: sector ? sector.todayCount : null,
      sectorPrevCount: sector ? sector.prevCount : null
    })
  }

  for (const sector of (dashboard.sectors && dashboard.sectors.mainCandidates) || []) {
    const lead = sector.board && sector.board.leadCode
    if (!lead || map.has(lead) || !/^\d{6}$/.test(lead)) continue
    map.set(lead, {
      code: lead,
      secid: `${/^6/.test(lead) ? 1 : 0}.${lead}`,
      name: sector.board.leadName || sector.leader?.name || lead,
      sector: sector.name,
      sectorKey: sector.key,
      lbc: 0,
      price: null,
      turnover: null,
      amount: null,
      prevAmount: null,
      floatCap: null,
      sealRatio: 0,
      sealFund: 0,
      firstSeal: 0,
      firstSealLabel: '--:--',
      blowCount: 0,
      ztDays: 0,
      fromPool: false,
      sectorRef: sector,
      sectorHeat: sector.heat,
      sectorGroup: sector.group,
      sectorReady: !!sector.dataReady,
      sectorTodayCount: sector.todayCount,
      sectorPrevCount: sector.prevCount
    })
  }

  if (stage.active) {
    try {
      const scan = await scanMarketLeaders(80)
      for (const q of scan.items || []) {
        if (!q.code || map.has(q.code)) continue
        if (!/^\d{6}$/.test(q.code)) continue
        const industry = q.industry || ''
        const sector = matchSectorLoose(industry)
        map.set(q.code, {
          code: q.code,
          secid: q.secid || `${/^6/.test(q.code) ? 1 : 0}.${q.code}`,
          name: q.name || q.code,
          industry,
          sector: sector ? sector.name : industry || '未分类',
          sectorKey: sector ? sector.key : null,
          lbc: 0,
          price: q.price,
          turnover: q.turnover,
          amount: q.amount,
          prevAmount: null,
          floatCap: q.floatCap,
          sealRatio: 0,
          sealFund: 0,
          firstSeal: 0,
          firstSealLabel: '--:--',
          blowCount: 0,
          ztDays: 0,
          fromPool: false,
          scanned: true,
          sectorRef: sector,
          sectorHeat: sector ? sector.heat : null,
          sectorGroup: sector ? sector.group : null,
          sectorReady: !!(sector && sector.dataReady),
          sectorTodayCount: sector ? sector.todayCount : null,
          sectorPrevCount: sector ? sector.prevCount : null
        })
      }
    } catch (err) {
      /* 全市场扫描失败时仍保留涨停池与主线候选，不阻断抓板页 */
    }
  }

  /* 盘中 / 竞价定稿需要涨停价与买一量，腾讯五档随批次合并；其它阶段用轻量行情 */
  const needSeal = !!stage.intraday || stage.key === 'final'
  const list = Array.from(map.values())
  const quoteResult = await batchQuotes(list.map((x) => x.secid), { seal: needSeal })
  const qMap = new Map((quoteResult.items || []).map((q) => [q.code, q]))
  const live = []
  for (const c of list) {
    const q = qMap.get(c.code)
    if (!q) continue
    const pct = q.pct != null ? q.pct : null
    const amount = q.amount != null ? q.amount : null
    const prevAmount = c.prevAmount
    const amountRatio = prevAmount > 0 && amount != null ? (amount / prevAmount) * 100 : null
    const floatCap = q.floatCap != null ? q.floatCap : c.floatCap
    const price = q.price != null ? q.price : c.price
    const limitUp =
      q.limitUp != null
        ? q.limitUp
        : q.prevClose != null
          ? round(q.prevClose * (1 + limitRatioFor(c.code)), 2)
          : null
    const sealFund = q.sealFund != null ? q.sealFund : c.sealFund
    const sealRatio =
      sealFund != null && floatCap > 0
        ? round((sealFund / floatCap) * 100, 2)
        : round(c.sealRatio || 0, 2)
    live.push({
      ...c,
      name: q.name || c.name,
      price,
      floatCap,
      pct: pct == null ? null : round(pct, 2),
      amount,
      amountRatio: amountRatio == null ? null : round(amountRatio, 2),
      volRatio: q.volRatio,
      quoteTime: q.quoteTime || '',
      open: q.open,
      high: q.high,
      low: q.low,
      prevClose: q.prevClose,
      limitUp,
      limitDown: q.limitDown != null ? q.limitDown : null,
      sealed: !!q.sealed,
      bid1: q.bid1,
      bid1Vol: q.bid1Vol,
      sealFund,
      sealRatio,
      quoteSource: q.source || ''
    })
  }

  const sectorLiveStrong = new Map()
  for (const c of live) {
    const hot = stage.intraday ? c.pct != null && c.pct >= 5 : c.pct != null && c.pct >= 2
    if (hot && c.amount != null && c.amount >= 1e7) {
      const key = c.sector || c.industry || '未分类'
      sectorLiveStrong.set(key, (sectorLiveStrong.get(key) || 0) + 1)
    }
  }

  const strong = []
  for (const c of live) {
    /* 20cm 仍参与同板块强势度统计，但不进入榜单 / 预警 / 可执行候选 */
    if (is20cmCode(c.code)) continue
    if (c.pct == null) continue
    const pct = c.pct
    const limitPct = limitRatioFor(c.code) * 100
    const gapToLimit = round(limitPct - pct, 2)
    const nearLimit = gapToLimit <= 1.2 && gapToLimit >= -0.6
    const sealedNow =
      !!c.sealed ||
      (c.limitUp != null && c.price != null && Math.abs(c.price - c.limitUp) < 0.005)
    const sector = c.sectorRef || sectorByKey.get(c.sectorKey) || null
    const liveStrong = sectorLiveStrong.get(c.sector || c.industry || '未分类') || 0
    /* 竞价阶段部分行情源不返回成交额，此时“同板块强势数”不可测，不能当作负面证据 */
    const liveStrongKnown = !!stage.intraday || c.amount != null
    const weak = weakForCode(
      c.code,
      weakCtx,
      stage.intraday ? { code: c.code, lbc: c.lbc } : { code: c.code, lbc: 0 }
    )
    const gene = geneScore({
      stock: c,
      sector,
      weak,
      sentiment: dashboard.sentiment,
      profile,
      context: {
        intraday: !!stage.intraday,
        sealed: stage.intraday ? sealedNow : undefined,
        pct,
        limitPct,
        amountRatio: c.amountRatio
      }
    })
    const node = nodeModelOf({ ...c, weak }, sector, dashboard.sentiment)

    let score
    if (stage.intraday) {
      const near = clamp(100 - Math.max(0, gapToLimit) * 16, 0, 100)
      const vol = c.volRatio != null ? clamp(c.volRatio * 22, 0, 100) : 50
      const amtPart = auctionAmountScore(c.amount, null)
      const strength = clamp(near * 0.5 + vol * 0.25 + amtPart * 0.25, 0, 100)
      score = Math.round(clamp(strength * 0.62 + gene.score * 0.38, 0, 99))
      if (sealedNow) score = Math.max(score, Math.min(99, gene.score + 2))
    } else {
      const amountScore = auctionAmountScore(c.amount, c.amountRatio)
      const pScore = auctionPctScore(pct)
      const prior = sectorPriorScore({ dataReady: c.sectorReady, group: c.sectorGroup })
      const sectorScore = clamp(prior + (liveStrong >= 2 ? 12 : liveStrong >= 1 ? 6 : 0), 0, 100)
      const sealScore = c.fromPool ? priorSealScore(c) : 45
      const factor = phaseFactor(dashboard.sentiment && dashboard.sentiment.phaseKey)
      const base = 0.3 * pScore + 0.28 * amountScore + 0.24 * sectorScore + 0.18 * sealScore
      score = Math.round(clamp(base * factor * 0.72 + gene.score * 0.28, 0, 99))
      if (!c.fromPool) score = Math.min(score, 82)
      if (stage.key === 'final' && sealedNow) {
        score = Math.max(score, Math.min(96, gene.score + 2))
      }
    }

    let status = 'drop'
    let auctionHard = false
    if (stage.intraday) {
      if (sealedNow && (c.fromPool || c.sectorReady || gene.score >= 60)) {
        status = 'confirm'
      } else if (nearLimit || (pct >= 5 && gene.score >= 55)) {
        status = 'watch'
      }
    } else {
      auctionHard =
        pct >= 2 &&
        pct <= 8 &&
        c.amount != null &&
        c.amount >= 2e7 &&
        c.amountRatio != null &&
        c.amountRatio >= 2 &&
        liveStrong >= 2 &&
        c.sectorReady &&
        c.fromPool
      if (score >= 70 && auctionHard) status = 'confirm'
      else if (stage.key === 'final' && sealedNow && c.amount != null && c.amount >= 1e7) status = 'confirm'
      else if (score >= 55 && pct >= 0.5) status = 'watch'
      if (stage.key === 'trial' && status === 'confirm') status = 'watch'
    }

    const reasons = []
    if (stage.intraday) {
      if (sealedNow) {
        reasons.push(`已封板${c.sealFund ? ` · 封单 ${amountText(c.sealFund)}` : ''}`)
      } else {
        reasons.push(
          `实时 ${pct > 0 ? '+' : ''}${round(pct, 2)}% · 距涨停 ${Math.max(0, gapToLimit).toFixed(1)} 个点`
        )
      }
      if (c.volRatio != null) reasons.push(`量比 ${round(c.volRatio, 2)}`)
      else if (c.amount != null) reasons.push(`成交 ${amountText(c.amount)}`)
    } else {
      reasons.push(`竞价 ${pct > 0 ? '+' : ''}${round(pct, 2)}%`)
      if (c.amount != null) {
        reasons.push(
          `竞价额 ${amountText(c.amount)}${c.amountRatio != null ? `，占昨日成交 ${round(c.amountRatio, 1)}%` : ''}`
        )
      }
    }
    if (c.sector) {
      reasons.push(
        `「${c.sector}」${
          c.sectorTodayCount != null
            ? `${stage.intraday ? '今' : '昨'} ${c.sectorTodayCount} 家涨停`
            : '板块候选'
        }` +
          `${c.sectorReady ? ' · 三关通过' : ''}`
      )
    }
    if (c.fromPool) {
      reasons.push(`昨日 ${c.lbc} 板 · ${c.firstSealLabel} 首封 · 封单 ${round(c.sealRatio, 2)}%`)
    }
    if (liveStrong >= 2) {
      reasons.push(
        `同板块 ${liveStrong} 只${stage.intraday ? '涨幅居前且成交超千万' : '竞价额超千万且高开 2% 以上'}`
      )
    }
    if (weak && weak.kind !== 'fresh') reasons.push(`弱转强：${weak.detail}`)
    if (node.label !== '低位跟随' && node.label !== '无高度') {
      reasons.push(`节点：${node.label} · ${node.why[0] || node.summary}`)
    }
    reasons.push(
      ...gene.why.filter((w) => !w.startsWith('「') && !w.startsWith('实时 ')).slice(0, 2)
    )

    const risks = []
    if (stage.intraday) {
      if (!sealedNow) risks.push('尚未封板，冲板失败回落风险')
      if (sealedNow && c.sealFund != null && c.sealFund < 2e7) risks.push('封单不足 2000 万，容易开板')
      if (!sealedNow && gapToLimit > 0 && gapToLimit <= 1.2) risks.push('贴板但未封，最后一档抛压需观察')
      if (sealedNow && c.blowCount > 0) risks.push(`今日已炸板 ${c.blowCount} 次`)
    } else {
      if (pct > 8) risks.push('竞价高开超过 8%，追高容错低')
      if (pct < 0) risks.push('竞价翻绿，资金态度偏弱')
      if (c.amountRatio != null && c.amountRatio < 2) risks.push('竞价额不足昨日成交 2%')
      if (c.amount != null && c.amount < 2e7) risks.push('竞价额不足 2000 万，流动性不够')
      if (stage.key === 'trial') risks.push('9:20 前可撤单，虚假挂单风险高')
    }
    if (liveStrongKnown && liveStrong < 2) risks.push('同板块共振不足 2 只，可能只是孤军')
    if (!c.sectorReady) risks.push('板块三关未过，只能观察，不构成隔夜依据')
    if (c.lbc >= 5) risks.push('高位股，分歧时波动放大')
    if (c.blowCount > 0) risks.push(`昨日炸板 ${c.blowCount} 次`)
    if (!c.fromPool) risks.push('非涨停池成员，缺少昨日封板质量数据')
    risks.push(...(node.risks || []).slice(0, 1))
    risks.push(...(gene.risks || []).slice(0, 2))

    const tags = []
    if (stage.intraday) {
      if (sealedNow) tags.push('已封板')
      else if (nearLimit) tags.push('临近涨停')
      if (c.volRatio != null && c.volRatio >= 1.5) tags.push('盘中放量')
    } else {
      if (pct >= 2 && pct <= 7) tags.push('竞价强势')
      if (c.amountRatio != null && c.amountRatio >= 5) tags.push('竞价放量')
    }
    if (liveStrong >= 2) tags.push('板块共振')
    if (c.fromPool && c.lbc >= 3) tags.push('昨日高位')
    if (c.sectorReady) tags.push('三关通过')
    if (!c.fromPool) tags.push(c.scanned ? '全市场扫描' : '非涨停池')
    if (weak && weak.score >= 66) tags.push(weak.label)
    if (node.score >= 55 && node.label !== '低位跟随' && node.label !== '无高度') {
      tags.push(node.label)
    }
    tags.push(...(gene.tags || []))

    strong.push({
      code: c.code,
      secid: c.secid,
      name: c.name,
      sector: c.sector,
      sectorKey: c.sectorKey,
      sectorHeat: c.sectorHeat,
      sectorTodayCount: c.sectorTodayCount == null ? null : c.sectorTodayCount,
      sectorReady: !!c.sectorReady,
      industry: c.industry || '',
      lbc: c.lbc,
      fromPool: c.fromPool,
      scanned: !!c.scanned,
      price: c.price,
      pct,
      limitPct,
      gapToLimit,
      limitUp: c.limitUp,
      boardRule: boardRuleLabel(c.code),
      amount: c.amount,
      amountRatio: c.amountRatio,
      volRatio: c.volRatio,
      quoteTime: c.quoteTime,
      firstSealLabel: c.firstSealLabel,
      sealRatio: round(c.sealRatio, 2),
      sealFund: c.sealFund == null ? null : c.sealFund,
      sealed: sealedNow,
      bid1: c.bid1,
      bid1Vol: c.bid1Vol,
      turnover: c.turnover != null ? round(c.turnover, 2) : null,
      blowCount: c.blowCount,
      score,
      geneScore: gene.score,
      node,
      nodeScore: node.score,
      nodeLabel: node.label,
      nodeTone: node.tone,
      nodeWhy: node.why,
      sentimentFit: node.sentimentFit,
      capFit: node.capFit,
      heightFit: node.heightFit,
      marketMax: node.maxBoard,
      nodeGap: node.gap,
      status,
      statusLabel: auctionLabel(status, stage.key),
      auctionHard,
      liveStrong,
      liveStrongKnown,
      weak: weak || null,
      weakLabel: weak ? weak.label : '',
      tags: Array.from(new Set(tags)).slice(0, 6),
      reasons: reasons.slice(0, 6),
      risks: Array.from(new Set(risks)).slice(0, 5),
      factors: gene.factors,
      why: gene.why,
      fit: gene.fit,
      source: c.fromPool
        ? stage.intraday
          ? '今日涨停池'
          : '昨日涨停池'
        : c.scanned
          ? '全市场扫描'
          : '主线领涨股'
    })
  }

  strong.sort(
    (a, b) => b.score - a.score || (b.nodeScore || 0) - (a.nodeScore || 0)
  )
  const top = strong
    .filter((x) => x.status !== 'drop')
    .slice(0, 5)
    .map((x, i) => ({ ...x, rank: i + 1 }))
  const strongCount = top.filter((x) => x.status === 'confirm').length
  const watchCount = top.filter((x) => x.status === 'watch').length

  const notes = [stage.note]
  if (stage.intraday) {
    notes.push(
      '盘中排序：封板确认 → 近板强度 → 板块共振 → 弱转强 → 封板质量 / 历史画像；只列最强 5 只。'
    )
    notes.push('封板确认只认最新价与买一价都贴在涨停价；未封板一律按观察处理，不当作已经涨停。')
  } else {
    notes.push(
      '竞价确认硬条件：涨幅 +2% ~ +8%、竞价额 ≥ 2000 万且 ≥ 昨日成交 2%、同板块至少 2 只强势、板块三关通过；9:20 前只算试撮。'
    )
  }
  if (!profile) notes.push('老龙头画像尚未构建完成，本次评分只使用基础规则。')
  if (stage.key === 'trial') notes.push('试撮阶段的数据会撤单、重挂，任何结论都必须等到 9:20 之后复核。')
  if (stage.key === 'final') notes.push('竞价定稿后仍需看 9:30 后是否放量承接；高开低走按失败处理。')
  notes.push('本榜与预警剔除科创板 688/689、创业板 300/301 的 20cm 标的；20cm 不进入推荐，也不弹窗。')
  if (stage.frozen) notes.push('午间冻结：价格不再变化，13:00 后再看资金是否继续。')
  if (quoteResult.stale) notes.push('行情返回了缓存快照，请留意时间戳。')
  notes.push('节点标签只说明连板梯队地位（空间 / 卡位 / 转势 / 跟随），不改变竞价硬条件和仓位纪律。')

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    market,
    stage,
    active: true,
    intraday: !!stage.intraday,
    tradeDate: latest ? latest.date : dashboard.tradeDate,
    tradeDateLabel: latest ? normalizeDateLabel(latest.date) : dashboard.tradeDateLabel,
    sentiment: {
      score: dashboard.sentiment ? dashboard.sentiment.score : null,
      phaseKey: dashboard.sentiment ? dashboard.sentiment.phaseKey : null,
      phase: dashboard.sentiment ? dashboard.sentiment.phase : null
    },
    gate: dashboard.gate,
    nodeBoard: buildNodeBoard(dashboard.sentiment),
    universe: live.length,
    scanUniverse: live.filter((x) => x.scanned).length,
    strongCount,
    watchCount,
    candidates: top,
    preview: [],
    notes,
    quoteAt: quoteResult.at,
    source: stage.intraday
      ? '东方财富全市场涨幅榜 + 涨停池 + 腾讯五档；约 2 秒轮询，仅交易时段计算'
      : '东方财富涨停池 + 全市场扫描 + 腾讯行情；约 2 秒轮询，竞价 9:15–9:30 计算'
  }
}

/* ------------------------------------------------------------------ *
 * 实时预警：只在竞价 9:20–9:30 提醒“未涨停、还能挂单”的强势候选
 *  - 盘中封板、已经涨停的票不再弹窗（弹了也买不进）
 *  - 预警是条件触发，不是买入指令
 *  - 只给前端做弹窗，不改变仪表盘与竞价候选口径
 * ------------------------------------------------------------------ */

const ALERT_SCORE_THRESHOLD = 70
const ALERT_MIN_GENE = 65
const ALERT_MIN_PCT = 2
const ALERT_MAX_PCT = 8
const ALERT_MAX_ITEMS = 1
const ALERT_STAGE_KEYS = ['locked', 'final']

function auctionAlertPctPart(pct) {
  return clamp(((pct - ALERT_MIN_PCT) / 5) * 100, 0, 100)
}

function auctionAlertSectorPart(x) {
  if (x.sectorReady) return 100
  const n = num(x.sectorTodayCount, 0)
  if (n >= 10) return 70
  if (n >= 5) return 60
  return 20
}

/* 竞价预警分与竞价榜综合分分开：更重基因与竞价强度，不奖励“已经涨停” */
function auctionAlertScore(x) {
  const gene = num(x.geneScore, 0)
  const pctPart = auctionAlertPctPart(num(x.pct, 0))
  const sectorPart = auctionAlertSectorPart(x)
  const poolPart = x.fromPool ? 100 : 60
  return Math.round(
    clamp(gene * 0.5 + pctPart * 0.3 + sectorPart * 0.12 + poolPart * 0.08, 0, 100)
  )
}

function auctionAlertEligible(x) {
  if (!x || !x.code) return false
  /* 20cm 直接不提醒：科创板 688/689、创业板 300/301 */
  if (is20cmCode(x.code)) return false
  if (x.status !== 'watch' && x.status !== 'confirm') return false
  /* 已封板 / 贴涨停的票直接排除：提醒时已经买不进 */
  if (x.sealed) return false
  if (x.gapToLimit == null || num(x.gapToLimit, 0) <= 0.3) return false
  const pct = num(x.pct, null)
  if (pct == null || pct < ALERT_MIN_PCT || pct > ALERT_MAX_PCT) return false
  if (num(x.geneScore, 0) < ALERT_MIN_GENE) return false
  /* 板块三关通过，或昨日涨停 ≥5 家，二者至少满足一项 */
  if (!x.sectorReady && num(x.sectorTodayCount, 0) < 5) return false
  /* 竞价额缺失时不臆造；一旦有数据，必须过流动性门槛 */
  if (x.amount != null && num(x.amount, 0) < 2e7) return false
  if (x.amountRatio != null && num(x.amountRatio, 0) < 2) return false
  return true
}

function auctionAlertWindow(stage) {
  const key = (stage && stage.key) || 'off'
  if (key === 'locked') {
    return {
      open: true,
      key,
      label: '9:20–9:25 不可撤单',
      short: '竞价锁定',
      note: '9:20 后不可撤单，竞价数据参考价值最高；只提醒未涨停的强势候选，可挂单，成交看 9:25 撮合。'
    }
  }
  if (key === 'final') {
    return {
      open: true,
      key,
      label: '9:25–9:30 竞价定稿',
      short: '竞价定稿',
      note: '竞价已定稿，开盘前最后窗口；只提醒未涨停候选，9:30 后还要看承接，不保证成交。'
    }
  }
  if (key === 'trial') {
    return {
      open: false,
      key,
      label: '9:15–9:20 试撮不提醒',
      short: '试撮',
      note: '9:15–9:20 允许撤单，价格和匹配量都可能变，不弹预警；9:20 后再按不可撤单数据判断。'
    }
  }
  if (key === 'intraday') {
    return {
      open: false,
      key,
      label: '盘中不弹买入预警',
      short: '盘中',
      note: '盘中封板或涨停后才提醒，实际已经买不进；只在竞价 9:20–9:30 提醒未涨停候选。'
    }
  }
  return {
    open: false,
    key,
    label: '当前不在竞价预警窗口',
    short: '休市',
    note: '只在竞价 9:20–9:30 检查；休市不扫描，也不做事后预警。'
  }
}

function buildAuctionAlerts(payload) {
  const p = payload || {}
  const active = !!p.active
  const stage = p.stage || { key: 'off', label: '非交易时段', active: false }
  const win = auctionAlertWindow(stage)
  const windowOpen = !!(
    active &&
    !p.intraday &&
    win.open &&
    ALERT_STAGE_KEYS.includes(stage.key)
  )
  const items = windowOpen
    ? (p.candidates || [])
        .filter(auctionAlertEligible)
        .map((x) => ({
          code: x.code,
          secid: x.secid,
          name: x.name,
          sector: x.sector,
          sectorKey: x.sectorKey,
          sectorHeat: x.sectorHeat,
          sectorTodayCount: x.sectorTodayCount,
          sectorReady: !!x.sectorReady,
          lbc: x.lbc,
          fromPool: !!x.fromPool,
          price: x.price,
          pct: x.pct,
          limitUp: x.limitUp,
          gapToLimit: x.gapToLimit,
          sealed: false,
          buyable: true,
          sealRatio: x.sealRatio,
          sealFund: x.sealFund == null ? null : x.sealFund,
          firstSealLabel: x.firstSealLabel,
          blowCount: x.blowCount,
          turnover: x.turnover,
          amount: x.amount,
          amountRatio: x.amountRatio,
          volRatio: x.volRatio,
          score: x.score,
          alertScore: auctionAlertScore(x),
          geneScore: x.geneScore,
          nodeLabel: x.nodeLabel,
          nodeTone: x.nodeTone,
          status: x.status,
          statusLabel: stage.key === 'final' ? '竞价定稿 · 未涨停' : '竞价锁定 · 未涨停',
          stageKey: stage.key,
          tags: (x.tags || []).slice(0, 4),
          reasons: (x.reasons || []).slice(0, 4),
          risks: (x.risks || []).slice(0, 3),
          weakLabel: x.weakLabel || '',
          source: x.source || ''
        }))
        .filter((x) => x.alertScore >= ALERT_SCORE_THRESHOLD)
        .sort((a, b) => b.alertScore - a.alertScore)
        .slice(0, ALERT_MAX_ITEMS)
    : []

  return {
    ok: true,
    generatedAt: p.generatedAt || new Date().toISOString(),
    quoteAt: p.quoteAt || null,
    active,
    intraday: !!p.intraday,
    stage,
    market: p.market || null,
    tradeDate: p.tradeDate || '',
    tradeDateLabel: p.tradeDateLabel || '',
    threshold: ALERT_SCORE_THRESHOLD,
    minGene: ALERT_MIN_GENE,
    scoreMode: 'auction',
    window: { ...win, open: windowOpen },
    count: items.length,
    items,
    notes: [
      win.note,
      `竞价预警条件：未涨停、涨幅 +${ALERT_MIN_PCT}% ~ +${ALERT_MAX_PCT}%、基因 ≥${ALERT_MIN_GENE}、板块三关通过或板块昨日涨停 ≥5 家、竞价预警分 ≥${ALERT_SCORE_THRESHOLD}；有成交额数据时还要求 ≥2000 万且 ≥昨日成交 2%。`,
      '剔除科创板 688/689、创业板 300/301 的 20cm；每轮最多只提醒预警分最高的 1 只，避免刷屏。',
      '预警分 = 基因 50% + 竞价强度 30% + 板块 12% + 昨日涨停池 8%，与竞价榜综合分不是同一口径。',
      '同一代码每天最多提醒一次；盘中封板、已涨停、9:15–9:20 试撮都不弹。',
      '预警是条件触发，不是买入指令；催化未核验或板块三关未过只按观察展示。'
    ]
  }
}

/* ------------------------------------------------------------------ *
 * 隔夜计划
 * ------------------------------------------------------------------ */

function amountText(v) {
  if (v == null || !Number.isFinite(v)) return '--'
  if (Math.abs(v) >= 1e8) return `${round(v / 1e8, 2)}亿`
  if (Math.abs(v) >= 1e4) return `${round(v / 1e4, 0)}万`
  return `${round(v, 0)}`
}

function overnightMode(market) {
  if (market.key === 'closed') {
    return { key: 'final', label: '盘后定稿', note: '收盘数据已定，按计划挂条件单；不追高、不满仓。' }
  }
  if (market.key === 'preopen' || market.key === 'auction' || market.key === 'waiting') {
    return { key: 'locked', label: '盘前不追加', note: '竞价已经开始，隔夜计划应在前一晚完成；现在只做验证，不临时加单。' }
  }
  return { key: 'preview', label: '盘中预演', note: '收盘前数据仍会变化，本页只作预演；15:00 后重新生成才可作为隔夜计划。' }
}

function buildOvernight({ dashboard, profile = null, now = beijingNow() }) {
  const market = marketStatus(now)
  const mode = overnightMode(market)
  const phaseKey = dashboard.sentiment ? dashboard.sentiment.phaseKey : null
  const phase = dashboard.sentiment ? dashboard.sentiment.phase : null
  const dataReady = (dashboard.sectors && dashboard.sectors.counts && dashboard.sectors.counts.dataReady) || 0
  const sectors = (dashboard.sectors && dashboard.sectors.all) || []

  let status = 'empty'
  let statusLabel = '不挂隔夜单'
  let reason = ''
  if (!dataReady) {
    status = 'empty'
    statusLabel = '不挂隔夜单'
    reason = dashboard.gate && dashboard.gate.detail
      ? dashboard.gate.detail
      : '没有板块同时通过连续性、梯队与资金三关。'
  } else if (phaseKey === 'ice' || phaseKey === 'ebb') {
    status = 'defend'
    statusLabel = '降频观察'
    reason = `虽有 ${dataReady} 个板块数据达标，但情绪处于「${phase ? phase.label : '退潮'}」，隔夜风险偏高。`
  } else if (phaseKey !== 'repair' && phaseKey !== 'feast') {
    status = 'wait'
    statusLabel = '等情绪确认'
    reason = `已有 ${dataReady} 个板块数据达标，但情绪仍在混沌区，隔夜单只做观察。`
  } else if (mode.key === 'locked') {
    status = 'locked'
    statusLabel = '盘前不追加'
    reason = '竞价已经开始，隔夜计划应在前一晚完成；现在只验证，不临时加单。'
  } else if (mode.key === 'preview') {
    status = 'preview'
    statusLabel = '盘中预演'
    reason = `数据与情绪支持 ${dataReady} 个板块，但收盘前仍会变化；15:00 后重算才可作为计划。`
  } else {
    status = 'ready'
    statusLabel = '可制定隔夜计划'
    reason = `${dataReady} 个板块通过三关，情绪处于「${phase ? phase.label : '修复'}」。只做通过画像核验的核心，催化仍须你人工确认后才能挂条件单。`
  }

  const basePlan = {
    gapLow: 1,
    gapHigh: 4,
    cancelAbove: 6,
    abandonBelow: -2,
    trigger: [
      '竞价高开 1%–4%，且 9:20 后价格不回落',
      '同板块至少 1 只核心同步高开，不能孤军',
      '竞价额不低于今日成交额 3%，且不是一字无量',
      '催化已核验（政策 / 产业 / 事件），纯传闻直接放弃'
    ],
    invalid: [
      '低开超过 -2%，或高开后 9:25 前跌回平盘',
      '板块无共振、核心股竞价集体走弱',
      '开盘 10 分钟跌破分时均线且无承接',
      '触发高位爆量或炸板不回封'
    ],
    stop: '跌破昨收 -3% 或分时均线持续走弱，先退出再复盘。',
    position: '单票 ≤ 10%，隔夜总仓 ≤ 30%；没有催化核验则不下单。'
  }

  function toOvernightItem(stock, sector, geneIn = null, rankInfo = null) {
    const sectorObj = sector || null
    const gene =
      stock.gene ||
      geneIn ||
      geneScore({
        stock,
        sector: sectorObj,
        weak: stock.weak,
        sentiment: dashboard.sentiment,
        profile
      })
    const node =
      rankInfo && rankInfo.node
        ? rankInfo.node
        : nodeModelOf(
            { ...stock, weak: stock.weak || (gene && gene.weak) || null },
            sectorObj,
            dashboard.sentiment
          )
    const close = num(stock.price, null)
    if (close == null) return null
    const limitRatio = limitRatioFor(stock.code)
    const limitUp = round(close * (1 + limitRatio), 2)
    const baseScore = num(
      stock.baseScore != null ? stock.baseScore : stock.score,
      gene.fit && gene.fit.staticScore != null ? gene.fit.staticScore : 60
    )
    const heat = sectorObj && sectorObj.heat != null ? sectorObj.heat : 40
    const overnightScore = Math.round(
      clamp(0.5 * baseScore + 0.3 * gene.score + 0.2 * heat, 0, 99)
    )
    const sectorReady = !!(sectorObj && sectorObj.dataReady)
    const acceptable =
      sectorReady &&
      gene.fit.score >= 55 &&
      overnightScore >= 65 &&
      stock.lbc >= 2 &&
      stock.lbc <= 5 &&
      !(stock.blowCount > 0) &&
      node.score >= 50 &&
      node.tone !== 'risk'
    const core = coreAdjustOf(stock, sectorObj)

    const tags = []
    if (acceptable) tags.push('隔夜候选')
    if (gene.fit.score >= 70) tags.push('画像匹配')
    if (gene.weak && gene.weak.score >= 66) tags.push(gene.weak.label)
    if (heat >= 65) tags.push('主线热度')
    if (stock.lbc === 2) tags.push('二板确认')
    if (stock.lbc >= 4) tags.push('高位加速')
    if (stock.blowCount > 0) tags.push('炸板瑕疵')
    tags.push(core.label)
    if (node.tone === 'risk') tags.push('节点风险')
    if (core.strongSeal) tags.push('强封核心')

    const basePrep =
      rankInfo && rankInfo.basePrep != null
        ? rankInfo.basePrep
        : prepBaseScore({
            gene: gene.score,
            base: baseScore,
            heat,
            weak: gene.weak && gene.weak.score != null ? gene.weak.score : 50,
            sentimentFit: node.sentimentFit,
            node: node.score,
            heightFit: node.heightFit,
            capFit: node.capFit
          })
    const prepScore =
      rankInfo && rankInfo.prepScore != null
        ? rankInfo.prepScore
        : Math.round(clamp(basePrep - core.total, 0, 99))
    const coreWhy =
      core.total > 0
        ? `核心修正 -${core.total}：${core.penalties.join(' · ')}`
        : `核心校验：无炸板/过热/薄封扣分，${core.label}`
    const nodeLine =
      `节点 ${node.label} ${node.score}：${node.why[0] || '节点中性'}` +
      ` · 情绪适配 ${node.sentimentFit} / 高度适配 ${node.heightFit} / 市值适配 ${node.capFit}`
    const why = Array.from(
      new Set([
        `准备池 ${prepScore} 分（修正前 ${basePrep}）：基因 ${gene.score} / 基础分 ${baseScore} / 板块热度 ${heat} / 弱转强 ${gene.weak ? gene.weak.label : '--'}`,
        nodeLine,
        coreWhy,
        ...(stock.fromSectorLeader
          ? [`${sectorObj ? sectorObj.name : stock.sector || '板块'} ${stock.lbc} 板龙头，被炸板 / 换手惩罚后仍纳入核验`]
          : []),
        ...(stock.fromCoreScan
          ? [`板块内${core.strongSeal ? '强封核心' : '连板补充'}（非最高板）：${stock.lbc} 板 · ${stock.blowCount === 0 ? '0 炸板' : `炸 ${stock.blowCount} 次`} · 换手 ${round(stock.turnover, 1)}%`]
          : []),
        ...(gene.why || []),
        `隔夜评分 ${overnightScore}：基础 ${baseScore} / 基因 ${gene.score} / 板块热度 ${heat}`,
        ...(acceptable ? ['三关 + 画像 + 情绪条件同时满足，进入严格候选'] : [])
      ])
    )
    const risks = Array.from(
      new Set([
        ...(gene.risks || []),
        ...(node.risks || []),
        ...(stock.blowCount > 0 ? [`昨日炸板 ${stock.blowCount} 次`] : []),
        ...(stock.lbc >= 5 ? ['高位连板，分歧波动放大'] : []),
        ...(core.mid ? ['容量中军，短线弹性弱于小盘核心'] : []),
        ...(core.label === '高位分歧' ? ['高位分歧，次日只观察不接力'] : []),
        ...(stock.fromCoreScan ? ['非板块最高板，需同板块龙头同步走强'] : []),
        ...(sectorReady ? [] : ['板块三关未过或缺失，只能观察']),
        '隔夜存在跳空风险，条件单不是保本工具'
      ])
    )

    return {
      code: stock.code,
      name: stock.name,
      sector: sectorObj ? sectorObj.name : stock.sector,
      sectorKey: stock.sectorKey,
      role: stock.role,
      roleLabel: stock.roleLabel,
      coreLabel: core.label,
      coreAdjust: core.total,
      corePenalties: core.penalties,
      coreWhy,
      strongSeal: !!core.strongSeal,
      fromCoreScan: !!stock.fromCoreScan,
      node,
      nodeScore: node.score,
      nodeLabel: node.label,
      nodeTone: node.tone,
      nodeWhy: node.why,
      nodeRisks: node.risks,
      nodeSummary: node.summary,
      sentimentFit: node.sentimentFit,
      capFit: node.capFit,
      heightFit: node.heightFit,
      marketMax: node.maxBoard,
      nodeGap: node.gap,
      lbc: stock.lbc,
      close,
      limitRatio,
      boardRule: boardRuleLabel(stock.code),
      limitUp,
      score: overnightScore,
      baseScore,
      basePrep,
      prepScore,
      geneScore: gene.score,
      fit: gene.fit,
      factors: gene.factors,
      sectorHeat: heat,
      dataReady: sectorReady,
      observation: !acceptable,
      acceptable,
      weak: stock.weak || gene.weak || null,
      weakLabel: gene.weakLabel,
      firstSealLabel: stock.firstSealLabel || '--:--',
      sealRatio: round(stock.sealRatio, 2),
      turnover: stock.turnover != null ? round(stock.turnover, 2) : null,
      floatCap: stock.floatCap == null ? null : stock.floatCap,
      tags: Array.from(new Set(tags)).slice(0, 6),
      why: why.slice(0, 7),
      reasons: why.slice(0, 7),
      risks: risks.slice(0, 5),
      plan: basePlan,
      requiresCatalyst: true
    }
  }

  const ranked = prepRank(candidateUniverse(dashboard).entries, dashboard.sentiment, profile)
  const allItems = ranked
    .map((e) => toOvernightItem(e.stock, e.sector, e.gene, e))
    .filter(Boolean)
    .sort(
      (a, b) =>
        b.prepScore - a.prepScore ||
        a.coreAdjust - b.coreAdjust ||
        b.nodeScore - a.nodeScore
    )

  const recommendations = allItems.filter((x) => x.acceptable).slice(0, 5)
  const preparation = allItems
    .filter((x) => x.prepScore >= 40)
    .slice(0, 5)
    .map((x, i) => ({ ...x, rank: i + 1 }))
  const watchlist = allItems
    .filter((x) => !x.acceptable && !preparation.some((p) => p.code === x.code))
    .slice(0, 8)
    .map((x, i) => ({ ...x, rank: i + 1 }))

  const watchSectors = sectors
    .filter((s) => !s.dataReady)
    .sort((a, b) => b.heat - a.heat)
    .slice(0, 4)
    .map((s) => ({
      name: s.name,
      heat: s.heat,
      missing: s.missing,
      todayCount: s.todayCount,
      prevCount: s.prevCount
    }))

  const rules = [
    '只在三关通过 + 情绪修复/主升时制定隔夜计划；冰点、退潮、混沌都不挂。',
    '资金承接按四项证据核对：主力两日净流入、量能、封单、溢价/晋级；不是只看一条资金线。',
    '节点优先：空间板 / 卡位 / 转势板 > 梯队跟随；但高位空间板炸板多、换手过热时只验证不接力。',
    '流通市值看 50–120 亿的短线弹性区；200 亿以上按中军处理，500 亿以上降权。',
    '弱转强优先：跌停反包 / 炸板回封 / 烂板转强 > 连板晋级 > 新晋首板。',
    '只做板块核心，不做杂毛补涨；没有催化核验的标的不进入计划。',
    '剔除科创板 688/689、创业板 300/301 的 20cm；它们不进入隔夜推荐与准备池，避免和 10cm 打板纪律混用。',
    '竞价高开 1%–4% 才执行；高开超过 6% 放弃，低开超过 -2% 放弃。',
    '单票 ≤ 10%，隔夜总仓 ≤ 30%；次日竞价不及预期先撤单，不摊低成本。',
    '所有价格都是条件区间，不是预测；跳空、滑点、停牌都可能让计划失效。'
  ]

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    market,
    mode,
    status,
    statusLabel,
    reason,
    gate: dashboard.gate,
    sentiment: {
      phaseKey,
      phase,
      score: dashboard.sentiment ? dashboard.sentiment.score : null
    },
    nodeBoard: buildNodeBoard(dashboard.sentiment),
    dataReady,
    recommendations,
    preparation,
    watchlist,
    watchSectors,
    rules,
    profile: profileSummary(profile),
    profilePending: !profile,
    notes: [
      mode.note,
      '“隔夜单”是高风险计划：本页只提供条件与纪律，不保证成交价，也不保证次日溢价。',
      '准备池按节点、情绪适配、连板高度、流通市值、弱转强、封板质量与历史画像综合排序；未满足三关 + 情绪 + 画像 + 节点的，只进观察池。',
      '20cm（科创板 688/689、创业板 300/301）已从推荐、准备池与观察池剔除；涨停统计和复盘事实仍保留。',
      '节点票模型参考公开的情绪周期、空间板、弱转强、中小流通盘与连板晋级思路；没有可验证的高胜率开源短线项目，分数是过滤器不是胜率。',
      '历史画像来自样本统计，不是准确率；样本外失效、风格切换都可能导致亏损。'
    ],
    source: '东方财富涨停池 / 板块资金 + 腾讯行情 + 历史样本统计'
  }
}

module.exports = {
  limitRatioFor,
  boardRuleLabel,
  auctionStage,
  buildAuction,
  buildAuctionAlerts,
  buildOvernight,
  buildReviewPlan,
  getDragonProfile,
  warmDragonProfile,
  peekDragonProfile,
  profileSummary,
  fitDragonCandidate,
  amountText
}