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
  stripLevel
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
 * 准备池候选：选股结果 + 各主线板块龙头
 * 选股分会被炸板 / 过热换手重罚，龙头可能因此掉出前 8；
 * 准备池必须把板块最高板龙头找回来，并把罚分原因明示，而不是静默消失。
 * ------------------------------------------------------------------ */

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
        baseScore: Math.round(clamp(0.5 * (sector.heat || 40) + 38, 30, 92)),
        fromSectorLeader: true
      },
      sector
    })
  }
  return { entries: Array.from(entries.values()), sectorByKey }
}

/* 准备池排序：基因 42% + 基础分 22% + 板块热度 14% + 高度 10% + 弱转强 12% */
function prepRank(entries, sentiment, profile) {
  return entries
    .filter((e) => e.stock && num(e.stock.price, null) != null)
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
      const base = num(e.stock.baseScore != null ? e.stock.baseScore : e.stock.score, 60)
      const heat = sector && sector.heat != null ? sector.heat : 40
      const height = clamp((num(e.stock.lbc, 1) / 5) * 100, 0, 100)
      const weakScore = gene.weak && gene.weak.score != null ? gene.weak.score : 50
      const prepScore = Math.round(
        clamp(
          0.42 * gene.score + 0.22 * base + 0.14 * heat + 0.1 * height + 0.12 * weakScore,
          0,
          99
        )
      )
      return { ...e, gene, prepScore }
    })
    .sort((a, b) => b.prepScore - a.prepScore)
}

/* 下一场竞价准备池：取最强 5 只，逐只解释入选原因与风险 */
function buildPreview(dashboard, profile) {
  const sentiment = dashboard.sentiment
  const ranked = prepRank(candidateUniverse(dashboard).entries, sentiment, profile)
  return ranked.slice(0, 5).map(({ stock: p, sector, gene, prepScore }, i) => {
    const fit = gene.fit
    const close = num(p.price, null)
    const limitRatio = limitRatioFor(p.code)
    const limitUp = close == null ? null : round(close * (1 + limitRatio), 2)
    const base = num(p.baseScore != null ? p.baseScore : p.score, 60)
    const heat = sector && sector.heat != null ? sector.heat : null
    const acceptable =
      !!(sector && sector.dataReady) &&
      fit.score >= 55 &&
      num(p.score, 0) >= 65 &&
      p.lbc >= 2 &&
      p.lbc <= 5 &&
      !(p.blowCount > 0)
    const why = [
      `准备池 ${prepScore} 分：基因 ${gene.score} / 基础 ${base} / 热度 ${heat == null ? '--' : heat} / 弱转强 ${gene.weak ? gene.weak.label : '--'}`,
      ...(p.fromSectorLeader
        ? [`${sector ? sector.name : p.sector || '板块'} ${p.lbc} 板龙头，选股分被炸板 / 换手惩罚后仍纳入准备池核验`]
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
      lbc: p.lbc,
      price: close,
      limitRatio,
      boardRule: boardRuleLabel(p.code),
      limitUp,
      score: num(p.score, 0),
      baseScore: base,
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
        ...(gene.tags || []),
        ...(p.roleLabel ? [p.roleLabel] : [])
      ]
        .filter((v, idx, arr) => arr.indexOf(v) === idx)
        .slice(0, 5),
      factors: gene.factors,
      why: why.slice(0, 7),
      risks: gene.risks,
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
        '下方准备池按弱转强、板块地位、封板质量与历史画像选最强 5 只，用于下一场竞价前准备。',
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
    if (stage.intraday) {
      if (sealedNow && (c.fromPool || c.sectorReady || gene.score >= 60)) {
        status = 'confirm'
      } else if (nearLimit || (pct >= 5 && gene.score >= 55)) {
        status = 'watch'
      }
    } else {
      const auctionHard =
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
        `「${c.sector}」${c.sectorTodayCount != null ? `今 ${c.sectorTodayCount} 家涨停` : '板块候选'}` +
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
    if (liveStrong < 2) risks.push('同板块共振不足 2 只，可能只是孤军')
    if (!c.sectorReady) risks.push('板块三关未过，只能观察，不构成隔夜依据')
    if (c.lbc >= 5) risks.push('高位股，分歧时波动放大')
    if (c.blowCount > 0) risks.push(`昨日炸板 ${c.blowCount} 次`)
    if (!c.fromPool) risks.push('非涨停池成员，缺少昨日封板质量数据')
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
    tags.push(...(gene.tags || []))

    strong.push({
      code: c.code,
      secid: c.secid,
      name: c.name,
      sector: c.sector,
      sectorKey: c.sectorKey,
      sectorHeat: c.sectorHeat,
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
      status,
      statusLabel: auctionLabel(status, stage.key),
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

  strong.sort((a, b) => b.score - a.score)
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
  if (stage.frozen) notes.push('午间冻结：价格不再变化，13:00 后再看资金是否继续。')
  if (quoteResult.stale) notes.push('行情返回了缓存快照，请留意时间戳。')

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

  function toOvernightItem(stock, sector, geneIn = null, prepScoreIn = null) {
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
    const close = num(stock.price, null)
    if (close == null) return null
    const limitRatio = limitRatioFor(stock.code)
    const limitUp = round(close * (1 + limitRatio), 2)
    const baseScore = num(stock.baseScore != null ? stock.baseScore : stock.score, 60)
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
      !(stock.blowCount > 0)

    const tags = []
    if (acceptable) tags.push('隔夜候选')
    if (gene.fit.score >= 70) tags.push('画像匹配')
    if (gene.weak && gene.weak.score >= 66) tags.push(gene.weak.label)
    if (heat >= 65) tags.push('主线热度')
    if (stock.lbc === 2) tags.push('二板确认')
    if (stock.lbc >= 4) tags.push('高位加速')
    if (stock.blowCount > 0) tags.push('炸板瑕疵')

    const prepScore =
      prepScoreIn != null
        ? prepScoreIn
        : Math.round(
            clamp(
              0.42 * gene.score +
                0.22 * baseScore +
                0.14 * heat +
                0.1 * clamp((num(stock.lbc, 1) / 5) * 100, 0, 100) +
                0.12 * (gene.weak && gene.weak.score != null ? gene.weak.score : 50),
              0,
              99
            )
          )
    const why = Array.from(
      new Set([
        `准备池 ${prepScore} 分：基因 ${gene.score} / 基础 ${baseScore} / 板块热度 ${heat} / 弱转强 ${gene.weak ? gene.weak.label : '--'}`,
        ...(stock.fromSectorLeader
          ? [`${sectorObj ? sectorObj.name : stock.sector || '板块'} ${stock.lbc} 板龙头，选股分被炸板 / 换手惩罚后仍纳入准备池核验`]
          : []),
        ...(gene.why || []),
        `隔夜评分 ${overnightScore}：基础 ${baseScore} / 基因 ${gene.score} / 板块热度 ${heat}`,
        ...(acceptable ? ['三关 + 画像 + 情绪条件同时满足，进入严格候选'] : [])
      ])
    )
    const risks = Array.from(
      new Set([
        ...(gene.risks || []),
        ...(stock.blowCount > 0 ? [`昨日炸板 ${stock.blowCount} 次`] : []),
        ...(stock.lbc >= 5 ? ['高位连板，分歧波动放大'] : []),
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
      lbc: stock.lbc,
      close,
      limitRatio,
      boardRule: boardRuleLabel(stock.code),
      limitUp,
      score: overnightScore,
      baseScore,
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
      tags: Array.from(new Set(tags)).slice(0, 5),
      why: why.slice(0, 6),
      reasons: why.slice(0, 6),
      risks: risks.slice(0, 5),
      plan: basePlan,
      requiresCatalyst: true
    }
  }

  const ranked = prepRank(candidateUniverse(dashboard).entries, dashboard.sentiment, profile)
  const allItems = ranked
    .map((e) => toOvernightItem(e.stock, e.sector, e.gene, e.prepScore))
    .filter(Boolean)
    .sort((a, b) => b.prepScore - a.prepScore)

  const recommendations = allItems.filter((x) => x.acceptable).slice(0, 5)
  const preparation = allItems.slice(0, 5).map((x, i) => ({ ...x, rank: i + 1 }))
  const watchlist = allItems
    .filter((x) => !x.acceptable)
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
    '弱转强优先：跌停反包 / 炸板回封 / 烂板转强 > 连板晋级 > 新晋首板。',
    '只做板块核心，不做杂毛补涨；没有催化核验的标的不进入计划。',
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
      '准备池按弱转强、板块地位、封板质量、筹码与历史画像综合排序；未满足三关 + 情绪 + 画像的，只进观察池。',
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
  buildOvernight,
  getDragonProfile,
  warmDragonProfile,
  peekDragonProfile,
  profileSummary,
  fitDragonCandidate,
  amountText
}