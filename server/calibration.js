/* ------------------------------------------------------------------ *
 * 晋级概率历史校准
 *
 * 只做一件事：用最近可取的涨停池，构造“T 日收盘特征 -> T+1 是否晋级”
 * 的样本，做按日走样本外（walk-forward）检验，再决定是否给现有规则概率
 * 加一个保守的校准权重。没有历史优势就明确关闭，不拿“模型”当卖点。
 *
 * 借鉴：
 * - Qlib 的横截面标准化 / 走样本外验证 / IC 思路；
 * - Shadowell/Alpha 的 first_limit_alpha：Point-in-Time、缺失不填 0、
 *   可成交性过滤、按日 walk-forward；
 * - 公开涨停复盘常用的封成比、封流比、首封时间、连续板/断板重来拆分。
 *
 * 数据限制：东方财富涨停池只能回溯约 15 个交易日，首次样本很薄；
 * 本地按 date|code 累积，随每日复盘逐步变厚，不伪造历史。
 * ------------------------------------------------------------------ */

const fs = require('fs')
const path = require('path')
const { getPool, getLatestTradingPool, getPrevTradingPool } = require('./eastmoney')
const { clamp, round, num, dateStamp, is20cmCode } = require('./util')

const CALIBRATION_FILE = path.join(__dirname, '..', '.cache', 'promotion-calibration.json')
const CALIBRATION_VERSION = 1
const CALIBRATION_TTL = 1000 * 60 * 60 * 6
const CALIBRATION_DAYS = 24
const CALIBRATION_MAX_DAYS = 120
const CALIBRATION_MAX_SAMPLES = 12000

const FEATURE_DEFS = [
  { key: 'isFirst', label: '首板', note: '首板与连板分开，首板→二板单独定价' },
  { key: 'boardNorm', label: '板位', note: '连板越高，晋级难度通常越大' },
  { key: 'earlySealNorm', label: '首封时间', note: '越早封板，主动性越强；尾盘板折价' },
  { key: 'sealRatioNorm', label: '封单/流通', note: '封流比，封单相对流通盘越厚越强' },
  { key: 'sealAmountNorm', label: '封成比', note: '封单/成交额，衡量板上买盘相对当日换手' },
  { key: 'blowNorm', label: '炸板次数', note: '开板越多，封板稳定性越差' },
  { key: 'floatCapNorm', label: '流通盘', note: '小盘易被控盘，大盘需要更多资金' },
  { key: 'sectorCountNorm', label: '板块涨停家数', note: '同板块涨停越多，越有梯队效应' },
  { key: 'sectorLeader', label: '板块龙一', note: '同板块最高板 / 最早封板的龙一溢价' },
  { key: 'marketPromoRate', label: '市场晋级率', note: '昨日涨停今日晋级比例，代表接力环境' }
]

let calibrationMemory = null
let calibrationDiskLoaded = false
let calibrationBuilding = null
let calibrationLastAttempt = 0

function sealMinutesFromOpen(v) {
  if (!v) return 240
  const s = String(v).padStart(6, '0')
  const h = Number(s.slice(0, 2))
  const m = Number(s.slice(2, 4))
  let mins = h * 60 + m - (9 * 60 + 30)
  if (mins < 0) mins = 0
  if (h >= 13) mins = Math.max(0, mins - 90)
  return clamp(mins, 0, 330)
}

function isMainboard(code) {
  return /^(00|60)/.test(String(code || '')) && !is20cmCode(code)
}

function isTradableBoard(stock) {
  const minutes = sealMinutesFromOpen(stock.firstSeal)
  const blow = num(stock.blowCount, 0)
  /* 9:25 / 9:30 一字或秒板，普通资金基本买不到；不把它们算进“可成交”指标 */
  return !(minutes <= 1 && blow === 0)
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0
}

function median(arr) {
  if (!arr.length) return null
  const sorted = arr.slice().sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function sigmoid(z) {
  if (z >= 35) return 1
  if (z <= -35) return 0
  return 1 / (1 + Math.exp(-z))
}

function aucOf(pairs) {
  const pos = pairs.filter((x) => x.y === 1)
  const neg = pairs.filter((x) => x.y === 0)
  if (!pos.length || !neg.length) return null
  let wins = 0
  let ties = 0
  for (const p of pos) {
    for (const n of neg) {
      if (p.p > n.p) wins++
      else if (p.p === n.p) ties++
    }
  }
  return (wins + ties * 0.5) / (pos.length * neg.length)
}

function brierOf(pairs) {
  if (!pairs.length) return null
  return mean(pairs.map((x) => (x.p - x.y) ** 2))
}

/* 分层 bootstrap：小样本 AUC 的点估计不够，必须把不确定性也亮出来 */
function bootstrapAucCI(pairs, reps = 300) {
  if (!pairs || pairs.length < 30) return null
  const pos = pairs.filter((x) => x.y === 1)
  const neg = pairs.filter((x) => x.y === 0)
  if (pos.length < 5 || neg.length < 5) return null
  const out = []
  for (let r = 0; r < reps; r++) {
    const sample = []
    for (let i = 0; i < pos.length; i++) {
      sample.push(pos[Math.floor(Math.random() * pos.length)])
    }
    for (let i = 0; i < neg.length; i++) {
      sample.push(neg[Math.floor(Math.random() * neg.length)])
    }
    const auc = aucOf(sample)
    if (auc != null) out.push(auc)
  }
  if (out.length < 50) return null
  out.sort((a, b) => a - b)
  return {
    low: round(out[Math.floor(out.length * 0.05)], 3),
    high: round(out[Math.floor(out.length * 0.95)], 3),
    reps: out.length
  }
}

function topShareOf(pairs, share = 0.1) {
  if (!pairs.length) return null
  const sorted = pairs.slice().sort((a, b) => b.p - a.p)
  const k = Math.max(1, Math.round(sorted.length * share))
  const top = sorted.slice(0, k)
  return {
    n: top.length,
    rate: round((top.filter((x) => x.y === 1).length / top.length) * 100, 1),
    avgP: round(mean(top.map((x) => x.p)) * 100, 1)
  }
}

function calibrationCurve(pairs, bins = 5) {
  if (!pairs.length) return []
  const sorted = pairs.slice().sort((a, b) => a.p - b.p)
  const out = []
  for (let i = 0; i < bins; i++) {
    const start = Math.floor((i * sorted.length) / bins)
    const end = Math.floor(((i + 1) * sorted.length) / bins)
    const part = sorted.slice(start, end)
    if (!part.length) continue
    out.push({
      bucket: `${i + 1}/${bins}`,
      n: part.length,
      predicted: round(mean(part.map((x) => x.p)) * 100, 1),
      actual: round((part.filter((x) => x.y === 1).length / part.length) * 100, 1)
    })
  }
  return out
}

function contextOf(pool) {
  const sameHeight = new Map()
  const sectorGroups = new Map()
  for (const s of pool.items || []) {
    const h = Math.max(1, num(s.lbc, 1))
    sameHeight.set(h, (sameHeight.get(h) || 0) + 1)
    const key = s.sector || '未分类'
    if (!sectorGroups.has(key)) sectorGroups.set(key, [])
    sectorGroups.get(key).push(s)
  }
  const leaders = new Set()
  const sectorCounts = new Map()
  for (const [key, list] of sectorGroups) {
    sectorCounts.set(key, list.length)
    const sorted = list
      .slice()
      .sort(
        (a, b) =>
          num(b.lbc, 0) - num(a.lbc, 0) ||
          (num(a.firstSeal, 999999) || 999999) - (num(b.firstSeal, 999999) || 999999) ||
          num(b.sealFund, 0) - num(a.sealFund, 0)
      )
    if (sorted[0] && num(sorted[0].lbc, 0) >= 2) leaders.add(sorted[0].code)
  }
  return { sameHeight, sectorCounts, leaders }
}

function promotionRateBetween(dayPool, nextPool) {
  if (!dayPool || !nextPool) return null
  const nextMap = new Map((nextPool.items || []).map((s) => [s.code, s]))
  let total = 0
  let promoted = 0
  for (const s of dayPool.items || []) {
    if (!isMainboard(s.code) || /ST|退/i.test(s.name || '')) continue
    total++
    const n = nextMap.get(s.code)
    if (n && num(n.lbc, 0) > num(s.lbc, 0)) promoted++
  }
  return total ? (promoted / total) * 100 : null
}

function featuresOf(stock, ctx, market) {
  const lbc = Math.max(1, num(stock.lbc, 1))
  const minutes = sealMinutesFromOpen(stock.firstSeal)
  const floatCap = num(stock.floatCap, 0)
  const amount = num(stock.amount, 0)
  const sealFund = num(stock.sealFund, 0)
  const sealRatio = floatCap > 0 ? (sealFund / floatCap) * 100 : 0
  const sealAmount = amount > 0 ? sealFund / amount : 0
  const capYi = floatCap / 1e8
  const sectorCount = ctx.sectorCounts.get(stock.sector || '未分类') || 1
  const sameHeight = ctx.sameHeight.get(lbc) || 1
  return {
    isFirst: lbc <= 1 ? 1 : 0,
    boardNorm: clamp((lbc - 1) / 4, 0, 1),
    earlySealNorm: clamp(1 - minutes / 240, 0, 1),
    sealRatioNorm: clamp(sealRatio / 5, 0, 1),
    sealAmountNorm: clamp(sealAmount / 5, 0, 1),
    blowNorm: clamp(num(stock.blowCount, 0) / 5, 0, 1),
    floatCapNorm: clamp((Math.log10(Math.max(capYi, 1)) - 0.7) / 2, 0, 1),
    sectorCountNorm: clamp((sectorCount - 1) / 6, 0, 1),
    sectorLeader: lbc >= 2 && ctx.leaders.has(stock.code) ? 1 : 0,
    marketPromoRate: clamp(num(market.promoRate, 25) / 100, 0, 1),
    sameHeightNorm: clamp((sameHeight - 1) / 10, 0, 1),
    ztDensityNorm: clamp(
      (num(stock.ztDays, 0) > 0 ? num(stock.ztCount, 0) / num(stock.ztDays, 0) : 0.3) - 0.2,
      0,
      1
    )
  }
}

function rowsOf(pools, blowPools) {
  const rows = []
  for (let i = 0; i < pools.length - 1; i++) {
    const day = pools[i]
    const next = pools[i + 1]
    const ctx = contextOf(day)
    const nextMap = new Map((next.items || []).map((s) => [s.code, s]))
    const promoRate = i > 0 ? promotionRateBetween(pools[i - 1], day) : null
    const zb = blowPools[i] || { items: [] }
    const ztCount = (day.items || []).length
    const zbCount = (zb.items || []).length
    const marketBlowRate = ztCount + zbCount > 0 ? (zbCount / (ztCount + zbCount)) * 100 : null
    const maxBoard = Math.max(1, ...(day.items || []).map((s) => num(s.lbc, 0)))
    const market = {
      promoRate,
      blowRate: marketBlowRate,
      maxBoard
    }
    for (const stock of day.items || []) {
      if (!isMainboard(stock.code)) continue
      if (/ST|退/i.test(stock.name || '')) continue
      const n = nextMap.get(stock.code)
      const promoted = !!(n && num(n.lbc, 0) > num(stock.lbc, 0))
      const features = featuresOf(stock, ctx, market)
      rows.push({
        date: day.date,
        code: stock.code,
        name: stock.name,
        sector: stock.sector || '',
        lbc: Math.max(1, num(stock.lbc, 1)),
        promoted,
        tradable: isTradableBoard(stock),
        oneWord: sealMinutesFromOpen(stock.firstSeal) <= 1 && num(stock.blowCount, 0) === 0,
        marketPromoRate: promoRate,
        marketBlowRate,
        maxBoard,
        features
      })
    }
  }
  return rows
}

function fitLogistic(rows, { l2 = 0.12, lr = 0.2, epochs = 900 } = {}) {
  const keys = FEATURE_DEFS.map((f) => f.key)
  if (!rows.length) return null
  const means = keys.map((k) => mean(rows.map((r) => num(r.features[k], 0))))
  const stds = keys.map((k, j) => {
    const m = means[j]
    const v = mean(rows.map((r) => (num(r.features[k], 0) - m) ** 2))
    return Math.sqrt(v) || 1
  })
  const X = rows.map((r) =>
    keys.map((k, j) => (num(r.features[k], 0) - means[j]) / (stds[j] || 1))
  )
  const y = rows.map((r) => (r.promoted ? 1 : 0))
  const pos = y.filter((v) => v === 1).length
  const neg = y.length - pos
  let bias = Math.log((pos + 1) / (neg + 1))
  const weights = new Array(keys.length).fill(0)
  const n = rows.length
  for (let epoch = 0; epoch < epochs; epoch++) {
    const grad = new Array(keys.length).fill(0)
    let gb = 0
    for (let i = 0; i < n; i++) {
      let z = bias
      for (let j = 0; j < keys.length; j++) z += weights[j] * X[i][j]
      const err = sigmoid(z) - y[i]
      for (let j = 0; j < keys.length; j++) grad[j] += err * X[i][j]
      gb += err
    }
    for (let j = 0; j < keys.length; j++) {
      weights[j] -= lr * (grad[j] / n + l2 * weights[j])
    }
    bias -= lr * (gb / n)
  }
  return { keys, weights, bias, means, stds }
}

function predictOne(model, features) {
  if (!model) return null
  let z = model.bias
  for (let j = 0; j < model.keys.length; j++) {
    const k = model.keys[j]
    const x = (num(features[k], 0) - model.means[j]) / (model.stds[j] || 1)
    z += model.weights[j] * x
  }
  return sigmoid(z) * 100
}

function publicModel(model) {
  if (!model) return null
  return {
    keys: model.keys.slice(),
    weights: model.weights.map((w) => round(w, 4)),
    bias: round(model.bias, 4),
    means: model.means.map((v) => round(v, 4)),
    stds: model.stds.map((v) => round(v, 4))
  }
}

/* 同型样本口径：板位 × 封板强度 × 板块梯队，三条都能被普通打板客复核 */
function bucketKeyOf(stock, features) {
  const lbc = Math.max(1, num(stock && stock.lbc, 1))
  const boardGroup = lbc >= 4 ? '4板+' : lbc === 3 ? '3板' : lbc === 2 ? '2板' : '首板'
  const sealStrong =
    num(features && features.earlySealNorm, 0) >= 0.875 &&
    num(features && features.sealRatioNorm, 0) >= 0.2
  const sectorStrong =
    num(features && features.sectorCountNorm, 0) >= 0.333 ||
    num(features && features.sectorLeader, 0) === 1
  return `${boardGroup}|${sealStrong ? '强封' : '弱封'}|${sectorStrong ? '有梯队' : '孤立'}`
}

function bucketTable(rows) {
  const globalRate = rows.length ? (rows.filter((r) => r.promoted).length / rows.length) * 100 : 0
  const map = new Map()
  for (const r of rows) {
    const key = bucketKeyOf(r, r.features)
    if (!map.has(key)) map.set(key, { key, n: 0, promoted: 0 })
    const b = map.get(key)
    b.n++
    if (r.promoted) b.promoted++
  }
  return Array.from(map.values())
    .map((b) => {
      const raw = b.n ? (b.promoted / b.n) * 100 : 0
      /* Beta 平滑：小样本向全局基准收缩，避免 1/1=100% 的假精确 */
      const k = 8
      const smoothed = ((b.promoted + (globalRate / 100) * k) / (b.n + k)) * 100
      return {
        key: b.key,
        n: b.n,
        promoted: b.promoted,
        rawRate: round(raw, 1),
        rate: round(smoothed, 1)
      }
    })
    .sort((a, b) => b.n - a.n)
}

function walkForward(rows) {
  const days = Array.from(new Set(rows.map((r) => r.date))).sort()
  const minTrain = 5
  const test = []
  const byDay = []
  for (let t = minTrain; t < days.length; t++) {
    const train = rows.filter((r) => r.date < days[t])
    const part = rows.filter((r) => r.date === days[t])
    if (!train.length || !part.length) continue
    const model = fitLogistic(train)
    const dayBase = train.filter((r) => r.promoted).length / train.length
    const dayRows = part.map((r) => {
      const p = predictOne(model, r.features) / 100
      return { p, y: r.promoted ? 1 : 0, base: dayBase, tradable: r.tradable, lbc: r.lbc }
    })
    test.push(...dayRows)
    byDay.push({
      date: days[t],
      n: dayRows.length,
      actual: round((dayRows.filter((x) => x.y === 1).length / dayRows.length) * 100, 1),
      modelTop: topShareOf(dayRows, 0.2),
      base: round(dayBase * 100, 1)
    })
  }
  const basePairs = test.map((x) => ({ p: x.base, y: x.y }))
  const modelPairs = test.map((x) => ({ p: x.p, y: x.y }))
  const tradablePairs = test.filter((x) => x.tradable)
  const contPairs = test.filter((x) => x.lbc >= 2)
  const metrics = {
    testDays: byDay.length,
    testSamples: test.length,
    baseRate: round(mean(test.map((x) => x.y)) * 100, 1),
    baselineBrier: round(brierOf(basePairs), 4),
    modelBrier: round(brierOf(modelPairs), 4),
    brierImprovement: round(
      ((brierOf(basePairs) - brierOf(modelPairs)) / (brierOf(basePairs) || 1)) * 100,
      1
    ),
    auc: round(aucOf(modelPairs), 3),
    aucCI: bootstrapAucCI(modelPairs),
    modelTopDecile: topShareOf(modelPairs, 0.1),
    baselineTopDecile: topShareOf(basePairs, 0.1),
    calibration: calibrationCurve(modelPairs, 5),
    tradable: {
      samples: tradablePairs.length,
      baseRate: tradablePairs.length
        ? round(mean(tradablePairs.map((x) => x.y)) * 100, 1)
        : null,
      modelBrier: round(brierOf(tradablePairs), 4),
      auc: round(aucOf(tradablePairs), 3),
      aucCI: bootstrapAucCI(tradablePairs),
      modelTopDecile: topShareOf(tradablePairs, 0.1)
    },
    /* 复盘晋级榜只排 2 板+，单独看这一子集，避免用首板样本把指标冲好看 */
    continuation: {
      samples: contPairs.length,
      baseRate: contPairs.length
        ? round(mean(contPairs.map((x) => x.y)) * 100, 1)
        : null,
      baselineBrier: round(
        brierOf(contPairs.map((x) => ({ p: x.base, y: x.y }))),
        4
      ),
      modelBrier: round(brierOf(contPairs), 4),
      auc: round(aucOf(contPairs), 3),
      aucCI: bootstrapAucCI(contPairs),
      modelTopDecile: topShareOf(contPairs, 0.2)
    },
    byDay
  }
  return metrics
}

function decideBlend(metrics, sampleCount) {
  if (!metrics || !sampleCount) return 0
  if (metrics.testDays < 5 || metrics.testSamples < 200) return 0
  if (metrics.auc == null || metrics.auc < 0.55) return 0
  if (metrics.modelBrier >= metrics.baselineBrier) return 0
  /* 晋级榜只排 2 板+；若模型只对首板有效，就不能拿来给连板加权重 */
  const cont = metrics.continuation || {}
  if (num(cont.samples, 0) >= 50 && (cont.auc == null || cont.auc < 0.55)) return 0
  const lift =
    metrics.modelTopDecile && metrics.baseRate != null
      ? metrics.modelTopDecile.rate - metrics.baseRate
      : 0
  let weight = 0
  if (metrics.brierImprovement >= 3 && lift >= 8) weight = 0.45
  else if (metrics.brierImprovement >= 1 && lift >= 4) weight = 0.3
  if (!weight) return 0
  /* 连板子样本的 AUC 置信区间若跨过 0.5，说明增量可能只是噪声：把权重压到 30% */
  const contCI = cont.aucCI
  if (num(cont.samples, 0) >= 50 && contCI && num(contCI.low, 1) < 0.5 && weight > 0.3) {
    return 0.3
  }
  return weight
}

async function fetchPools(days) {
  let cursor = await getLatestTradingPool(dateStamp(new Date()))
  const pools = []
  for (let i = 0; i < days && cursor; i++) {
    pools.unshift({ date: cursor.date, items: cursor.items })
    cursor = await getPrevTradingPool(cursor.date)
  }
  return pools
}

async function buildPromotionCalibration({ days = CALIBRATION_DAYS, persist = true } = {}) {
  const pools = await fetchPools(days)
  if (pools.length < 4) throw new Error('历史涨停池不足，至少需要 4 个交易日')
  const blowPools = await Promise.all(
    pools.map((p) => getPool(p.date, 'zb').catch(() => ({ date: p.date, items: [] })))
  )
  const fresh = rowsOf(pools, blowPools)

  const previous = loadCalibrationDisk()
  const mergedMap = new Map()
  for (const r of fresh) mergedMap.set(`${r.date}|${r.code}`, r)
  let carried = 0
  if (previous && previous.version === CALIBRATION_VERSION && Array.isArray(previous.rawSamples)) {
    for (const r of previous.rawSamples) {
      const key = `${r.date}|${r.code}`
      if (!mergedMap.has(key)) {
        mergedMap.set(key, r)
        carried++
      }
    }
  }
  let merged = Array.from(mergedMap.values()).sort((a, b) =>
    a.date === b.date ? a.code.localeCompare(b.code) : a.date.localeCompare(b.date)
  )
  const dates = Array.from(new Set(merged.map((r) => r.date))).sort()
  const allowed = new Set(dates.slice(-CALIBRATION_MAX_DAYS))
  merged = merged.filter((r) => allowed.has(r.date)).slice(-CALIBRATION_MAX_SAMPLES)

  const labeled = merged.filter((r) => typeof r.promoted === 'boolean')
  const model = fitLogistic(labeled)
  const metrics = walkForward(labeled)
  const blendWeight = decideBlend(metrics, labeled.length)
  const globalRate = labeled.length
    ? (labeled.filter((r) => r.promoted).length / labeled.length) * 100
    : null
  const tradableRows = labeled.filter((r) => r.tradable)
  const tradableRate = tradableRows.length
    ? (tradableRows.filter((r) => r.promoted).length / tradableRows.length) * 100
    : null
  const contCI = metrics.continuation && metrics.continuation.aucCI
  const ciCapNote =
    contCI &&
    num(contCI.low, 1) < 0.5 &&
    num(metrics.continuation.samples, 0) >= 50 &&
    blendWeight > 0
      ? `2 板+ 子样本 AUC 的 95% 区间 ${contCI.low}–${contCI.high} 跨过 0.5，说明增量可能是噪声：模型权重已压到 ${Math.round(blendWeight * 100)}%，只用于排序，不做概率放大。`
      : null

  const output = {
    ok: true,
    version: CALIBRATION_VERSION,
    builtAt: new Date().toISOString(),
    days: dates.length,
    fromDate: dates[0],
    toDate: dates[dates.length - 1],
    samples: labeled.length,
    tradableSamples: tradableRows.length,
    baseRate: round(globalRate, 1),
    tradableBaseRate: round(tradableRate, 1),
    model: {
      ...publicModel(model),
      enabled: blendWeight > 0,
      blendWeight,
      metrics,
      featureDefs: FEATURE_DEFS
    },
    buckets: bucketTable(labeled),
    notes: [
      '样本为 00/60 主板涨停股，剔除 ST / 退市 / 双创 20cm；标签是次日连板数继续抬升。',
      '走样本外：每个测试日只用它之前的样本训练，标签是次日结果；没有用未来数据。',
      '一字 / 秒板（9:25–9:30 且 0 炸板）在“可成交”指标中剔除，避免用买不到的票刷高命中。',
      '东方财富涨停池只能回溯约 15 个交易日；样本会按 date|code 在本地累积，最多 120 个交易日。',
      '校准只在样本外同时满足 Brier 改善、AUC ≥ 0.55、Top10% 有增量时才启用；否则权重为 0。',
      'AUC 用分层 bootstrap 估计 95% 区间；2 板+ 区间跨 0.5 时权重上限压到 30%，避免把噪声当优势。',
      ...(ciCapNote ? [ciCapNote] : []),
      '这是排序与风险过滤，不是胜率承诺；风格切换、流动性变化和拥挤交易都会让模型失效。'
    ],
    rawSamples: merged
  }
  if (persist) saveCalibration(output)
  return output
}

function loadCalibrationDisk() {
  if (calibrationDiskLoaded) return calibrationMemory
  calibrationDiskLoaded = true
  try {
    const raw = fs.readFileSync(CALIBRATION_FILE, 'utf8')
    const data = JSON.parse(raw)
    if (data && data.ok && data.builtAt && data.version === CALIBRATION_VERSION) {
      calibrationMemory = data
    }
  } catch (err) {
    /* 首次运行没有校准缓存 */
  }
  return calibrationMemory
}

function peekPromotionCalibration() {
  return calibrationMemory || loadCalibrationDisk()
}

function saveCalibration(data) {
  calibrationMemory = data
  try {
    fs.mkdirSync(path.dirname(CALIBRATION_FILE), { recursive: true })
    const { rawSamples, ...publicData } = data
    fs.writeFileSync(CALIBRATION_FILE, JSON.stringify({ ...publicData, rawSamples }, 'utf8'))
  } catch (err) {
    /* 缓存写入失败不影响本次使用 */
  }
}

async function ensurePromotionCalibration({ force = false, days = CALIBRATION_DAYS } = {}) {
  const cached = peekPromotionCalibration()
  const fresh =
    cached &&
    cached.builtAt &&
    Date.now() - Date.parse(cached.builtAt) < CALIBRATION_TTL &&
    cached.version === CALIBRATION_VERSION
  if (!force && fresh) return cached
  if (calibrationBuilding) return calibrationBuilding
  if (!force && calibrationLastAttempt && Date.now() - calibrationLastAttempt < 1000 * 60 * 2) {
    return cached
  }
  calibrationLastAttempt = Date.now()
  calibrationBuilding = buildPromotionCalibration({ days })
    .catch((err) => {
      console.error('[calibration]', err && err.message)
      return cached || null
    })
    .finally(() => {
      calibrationBuilding = null
    })
  return calibrationBuilding
}

function publicCalibration(cal) {
  if (!cal) return null
  const { rawSamples, ...rest } = cal
  return rest
}

/* 给 dashboard / 复盘页的紧凑摘要：不暴露权重向量和逐日样本，只保留可核验指标 */
function calibrationSummary(cal) {
  if (!cal) return null
  const model = cal.model || {}
  const metrics = model.metrics || {}
  const top = metrics.modelTopDecile || null
  const cont = metrics.continuation || null
  const tradable = metrics.tradable || null
  return {
    ok: !!cal.ok,
    enabled: !!model.enabled && num(model.blendWeight, 0) > 0,
    blendWeight: num(model.blendWeight, 0),
    builtAt: cal.builtAt,
    days: cal.days,
    fromDate: cal.fromDate,
    toDate: cal.toDate,
    samples: cal.samples,
    tradableSamples: cal.tradableSamples,
    baseRate: cal.baseRate,
    tradableBaseRate: cal.tradableBaseRate,
    testDays: metrics.testDays,
    testSamples: metrics.testSamples,
    testBaseRate: metrics.baseRate,
    auc: metrics.auc,
    aucCI: metrics.aucCI || null,
    brier: metrics.modelBrier,
    baselineBrier: metrics.baselineBrier,
    brierImprovement: metrics.brierImprovement,
    topDecile: top,
    continuation: cont
      ? {
          samples: cont.samples,
          baseRate: cont.baseRate,
          auc: cont.auc,
          aucCI: cont.aucCI || null,
          brier: cont.modelBrier,
          baselineBrier: cont.baselineBrier,
          topQuintile: cont.modelTopDecile
        }
      : null,
    tradable: tradable
      ? {
          samples: tradable.samples,
          baseRate: tradable.baseRate,
          auc: tradable.auc,
          aucCI: tradable.aucCI || null,
          topDecile: tradable.modelTopDecile
        }
      : null,
    buckets: Array.isArray(cal.buckets) ? cal.buckets.slice(0, 8) : [],
    notes: Array.isArray(cal.notes) ? cal.notes : []
  }
}

module.exports = {
  CALIBRATION_FILE,
  CALIBRATION_VERSION,
  FEATURE_DEFS,
  buildPromotionCalibration,
  ensurePromotionCalibration,
  peekPromotionCalibration,
  publicCalibration,
  calibrationSummary,
  predictOne,
  featuresOf,
  contextOf,
  bucketKeyOf,
  isMainboard,
  isTradableBoard
}

if (require.main === module) {
  buildPromotionCalibration({ persist: process.argv.includes('--persist') })
    .then((data) => {
      const { rawSamples, ...rest } = data
      console.log(JSON.stringify(rest, null, 2))
    })
    .catch((err) => {
      console.error('CALIBRATION FAILED', err)
      process.exit(1)
    })
}