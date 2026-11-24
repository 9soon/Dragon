'use strict'

/**
 * 龙头基因引擎 v2
 * 把公开短线交易里反复验证的四类信号落到可计算字段上：
 *  1) 情绪周期：涨停家数、连板高度、炸板率、溢价、晋级率（buildSentiment 已算）
 *  2) 弱转强：昨日炸板 / 跌停 / 烂板，今日回封或盘中转强
 *  3) 龙头特征：封板时间、封单占流通、换手、流通市值、板块地位
 *  4) 历史画像：老龙头六维分桶的样本延续率
 * 所有分数都是可解释的加权，不承诺胜率，也不替代人工催化核验。
 */

const { clamp, round, num, is20cmCode } = require('./util')
const { sealMinutesFromOpen, sealTimeLabel, flowText } = require('./scoring')

const PHASE_GENE = { ice: 34, ebb: 48, mixed: 66, repair: 84, feast: 94 }

function limitRatioFor(code) {
  if (is20cmCode(code)) return 0.2
  if (/^[48]/.test(String(code))) return 0.3
  return 0.1
}

function findBucket(list, value) {
  if (!Array.isArray(list) || value == null) return null
  return list.find((b) => value >= b.min && value <= b.max) || null
}

/* ------------------------------------------------------------------ *
 * 弱转强识别
 * ------------------------------------------------------------------ */

function weakOf({ code, today, prevMap, blowSet, downSet }) {
  const p = prevMap.get(code) || null
  const isDown = downSet.has(code)
  const isBlow = blowSet.has(code)
  const lbc = today && today.lbc ? today.lbc : 0

  if (isDown) {
    return {
      kind: 'downReversal',
      label: '跌停反包',
      score: 92,
      detail: `昨日跌停，今日${lbc ? `回封 ${lbc} 板` : '盘中转强'}`
    }
  }
  if (isBlow) {
    return {
      kind: 'blowReversal',
      label: '炸板回封',
      score: 86,
      detail: `昨日炸板未封，今日${lbc ? '重新封板' : '盘中转强'}`
    }
  }
  if (p && p.blowCount > 0) {
    return {
      kind: 'lame',
      label: '烂板转强',
      score: 78,
      detail: `昨日 ${p.lbc} 板炸 ${p.blowCount} 次，今日${lbc ? `封 ${lbc} 板` : '转强'}`
    }
  }
  if (p && today && lbc > p.lbc) {
    return {
      kind: 'promote',
      label: '连板晋级',
      score: 66,
      detail: `${p.lbc} 板 → ${lbc} 板`
    }
  }
  if (p && today && p.firstSeal && today.firstSeal) {
    const gap = sealMinutesFromOpen(p.firstSeal) - sealMinutesFromOpen(today.firstSeal)
    if (gap >= 30) {
      return {
        kind: 'faster',
        label: '封板提速',
        score: 64,
        detail: `首封比昨日提前 ${gap} 分钟`
      }
    }
  }
  if (p) {
    return {
      kind: 'steady',
      label: '强转强',
      score: 56,
      detail: today && lbc ? `昨日涨停，今日继续封 ${lbc} 板` : '昨日涨停，今日延续强势'
    }
  }
  return {
    kind: 'fresh',
    label: '新晋涨停',
    score: 48,
    detail: today && lbc ? `新晋 ${lbc} 板，缺少昨日弱转强证据` : '新进入强势区，缺少昨日样本'
  }
}

function buildWeakContext({ prevPool = [], prevBlow = [], prevDown = [] } = {}) {
  const prevMap = new Map((prevPool || []).map((s) => [s.code, s]))
  const blowSet = new Set((prevBlow || []).map((s) => s.code))
  const downSet = new Set((prevDown || []).map((s) => s.code))
  return { prevMap, blowSet, downSet }
}

function weakMapFor(todayPool = [], ctx = buildWeakContext()) {
  const map = new Map()
  for (const t of todayPool || []) {
    if (!t || !t.code) continue
    map.set(t.code, weakOf({ code: t.code, today: t, ...ctx }))
  }
  return map
}

function weakForCode(code, ctx, today = null) {
  return weakOf({ code, today, ...ctx })
}

/* ------------------------------------------------------------------ *
 * 历史画像匹配（原 edge.js 的静态 + 样本合成）
 * ------------------------------------------------------------------ */

function fitDragonCandidate({ stock, sector, profile, sentiment }) {
  const s = stock || {}
  const lbc = num(s.lbc, 0)
  const minutes = sealMinutesFromOpen(s.firstSeal)
  const sealRatio = num(s.sealRatio, 0)
  const turnover = num(s.turnover, 0)
  const capYi = num(s.floatCap, 0) / 1e8
  const blowCount = num(s.blowCount, 0)
  const todayCount = num(sector && sector.todayCount, 0)
  const prevCount = num(sector && sector.prevCount, 0)

  let score = 100
  const hits = []
  const misses = []
  function rule(ok, hit, miss, penalty) {
    if (ok) hits.push(hit)
    else {
      misses.push(miss)
      score -= penalty
    }
  }

  rule(lbc >= 3 && lbc <= 5, `高度 ${lbc} 板在 3–5 板区间`, lbc < 3 ? `高度 ${lbc} 板偏低` : `高度 ${lbc} 板偏高`, lbc < 3 ? 12 : 15)
  rule(minutes <= 60, '首封在 10:30 前', '首封偏晚，主动性不足', 12)
  rule(sealRatio >= 1, `封单占流通 ${round(sealRatio, 2)}%`, '封单偏薄，低于 1%', sealRatio < 0.5 ? 24 : 14)
  rule(turnover >= 3 && turnover <= 20, `换手 ${round(turnover, 1)}% 处于良性区间`, turnover < 3 ? '换手过低，缺少分歧' : '换手过高，兑现压力大', turnover > 30 ? 24 : 12)
  rule(capYi >= 50 && capYi <= 300, `流通 ${round(capYi, 0)} 亿适配`, capYi < 50 ? '流通盘偏小，波动与操控风险高' : '流通盘偏大，短线弹性弱', 10)
  rule(blowCount === 0, '昨日无炸板', `昨日炸板 ${blowCount} 次`, Math.min(20, 8 + blowCount * 6))
  rule(todayCount >= 3, `板块 ${todayCount} 家涨停`, `板块仅 ${todayCount} 家涨停，梯队不足`, 10)
  rule(prevCount >= 2, `昨日板块 ${prevCount} 家涨停`, '昨日板块效应不足', 10)

  if (sentiment && sentiment.phaseKey === 'ice') {
    misses.push('市场情绪冰点，龙头也容易补跌')
    score -= 12
  } else if (sentiment && sentiment.phaseKey === 'ebb') {
    misses.push('市场处于分歧退潮')
    score -= 6
  }

  const staticScore = Math.round(clamp(score, 0, 100))
  const evidence = []
  const rates = []
  if (profile && profile.buckets && profile.stats && profile.stats.continuedRate != null) {
    const checks = [
      { key: 'height', label: '高度', bucket: findBucket(profile.buckets.height, lbc), value: `${lbc} 板` },
      { key: 'sealTime', label: '首封', bucket: findBucket(profile.buckets.sealTime, minutes), value: sealTimeLabel(s.firstSeal) },
      { key: 'sealRatio', label: '封单', bucket: findBucket(profile.buckets.sealRatio, sealRatio), value: `${round(sealRatio, 2)}%` },
      { key: 'turnover', label: '换手', bucket: findBucket(profile.buckets.turnover, turnover), value: `${round(turnover, 1)}%` },
      { key: 'floatCap', label: '流通', bucket: findBucket(profile.buckets.floatCap, capYi), value: `${round(capYi, 0)} 亿` },
      { key: 'sectorCount', label: '板块家数', bucket: findBucket(profile.buckets.sectorCount, todayCount), value: `${todayCount} 家` }
    ]
    for (const c of checks) {
      if (!c.bucket || c.bucket.samples < 3 || c.bucket.rate == null) continue
      evidence.push({
        dimension: c.label,
        value: c.value,
        bucket: c.bucket.label,
        samples: c.bucket.samples,
        rate: c.bucket.rate,
        avgGap: c.bucket.avgGap
      })
      rates.push(c.bucket.rate)
    }
  }
  const avgRate = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null
  const empiricalScore =
    avgRate == null
      ? null
      : Math.round(clamp(50 + (avgRate - profile.stats.continuedRate) * 1.8, 0, 100))
  const finalScore =
    empiricalScore == null
      ? staticScore
      : Math.round(clamp(staticScore * 0.62 + empiricalScore * 0.38, 0, 100))

  return {
    score: finalScore,
    staticScore,
    empiricalScore,
    sampleEvidence: evidence.slice(0, 6),
    hits,
    misses: misses.slice(0, 5)
  }
}

/* ------------------------------------------------------------------ *
 * 龙头基因评分
 * ------------------------------------------------------------------ */

function phaseValue(sentiment) {
  const key = sentiment && sentiment.phaseKey ? sentiment.phaseKey : 'mixed'
  let value = PHASE_GENE[key] != null ? PHASE_GENE[key] : 65
  const signal = sentiment && sentiment.signal
  if (signal && signal.attack) value = Math.min(100, value + 6)
  if (signal && signal.defense) value = Math.max(10, value - 10)
  return value
}

function geneScore({ stock, sector, weak, sentiment, profile, context = {} }) {
  const s = stock || {}
  const lbc = num(s.lbc, 0)
  const pct = context.pct != null ? num(context.pct, null) : num(s.pct, null)
  const limitPct = context.limitPct != null ? context.limitPct : limitRatioFor(s.code) * 100
  const amountRatio = context.amountRatio != null ? num(context.amountRatio, null) : null
  const turnover = num(s.turnover, null)
  const capYi = num(s.floatCap, 0) / 1e8
  const blow = num(s.blowCount, 0)
  const minutes = sealMinutesFromOpen(s.firstSeal)
  const sealRatio = num(s.sealRatio, 0)
  const sealed =
    context.sealed != null
      ? !!context.sealed
      : !context.intraday && s.fromPool !== false

  const sentimentVal = phaseValue(sentiment)

  const passed =
    sector && sector.gatesPassed != null
      ? sector.gatesPassed
      : sector && sector.checks
        ? sector.checks.filter((c) => c.pass).length
        : 0
  let sectorVal = sector
    ? sector.dataReady
      ? 96
      : sector.group === 'main'
        ? 72
        : sector.group === 'new'
          ? 54
          : 40
    : 36
  sectorVal += passed * 2
  if (sector && sector.leader && stock && stock.code === sector.leader.code) sectorVal += 8
  if (sector && sector.maxBoard && lbc >= sector.maxBoard) sectorVal += 6
  sectorVal = clamp(sectorVal, 0, 100)

  let weakVal = weak && weak.score != null ? weak.score : 50
  if (context.intraday && !sealed && pct != null) {
    const gap = Math.max(0, limitPct - pct)
    const near = clamp(100 - gap * 18, 0, 100)
    weakVal = clamp(weakVal * 0.55 + near * 0.45, 0, 100)
  }

  let sealVal
  if (sealed) {
    const timeScore = s.firstSeal ? clamp(100 - minutes * 0.55, 0, 100) : 62
    const ratioScore = clamp((sealRatio / 2) * 100, 0, 100)
    sealVal = clamp(
      timeScore * 0.5 + ratioScore * 0.4 + (blow === 0 ? 10 : Math.max(0, 10 - blow * 5)),
      0,
      100
    )
  } else {
    const gap = pct == null ? 10 : Math.max(0, limitPct - Math.abs(pct))
    const near = clamp(100 - gap * 20, 0, 100)
    const amt = amountRatio == null ? 48 : clamp(amountRatio * 4, 20, 100)
    sealVal = clamp(near * 0.65 + amt * 0.35, 0, 100)
  }

  let chipVal = 50
  if (turnover != null) {
    chipVal = turnover >= 3 && turnover <= 20 ? 96 : turnover < 3 ? 70 : turnover <= 30 ? 58 : 30
  }
  if (capYi > 0) {
    const capScore = capYi >= 50 && capYi <= 300 ? 100 : capYi < 50 ? 58 : 55
    chipVal = clamp(chipVal * 0.7 + capScore * 0.3, 0, 100)
  }

  const fit = fitDragonCandidate({
    stock: { ...s, sealRatio, turnover: turnover == null ? 0 : turnover },
    sector,
    profile,
    sentiment
  })

  const phaseLabel =
    sentiment && sentiment.phase && sentiment.phase.label ? sentiment.phase.label : '混沌'
  const factors = [
    {
      key: 'sentiment',
      label: '情绪环境',
      value: Math.round(sentimentVal),
      weight: 15,
      text:
        `「${phaseLabel}」` +
        (sentiment && sentiment.signal && sentiment.signal.label
          ? ` · ${sentiment.signal.label}`
          : '')
    },
    {
      key: 'sector',
      label: '板块地位',
      value: Math.round(sectorVal),
      weight: 18,
      text: sector
        ? `${sector.name} · ${sector.dataReady ? '三关通过' : `过 ${passed}/3 关`} · 今 ${sector.todayCount} 家`
        : '板块缺失'
    },
    {
      key: 'weak',
      label: '弱转强',
      value: Math.round(weakVal),
      weight: 22,
      text: weak ? weak.label : sealed ? '强转强' : '近板强度'
    },
    {
      key: 'seal',
      label: '封板质量',
      value: Math.round(sealVal),
      weight: 20,
      text: sealed
        ? `${s.fromPool || s.firstSeal ? sealTimeLabel(s.firstSeal) : '--:--'} 首封 · ${round(sealRatio, 2)}% 流通`
        : '未封 · 看近板与量能'
    },
    {
      key: 'chip',
      label: '筹码结构',
      value: Math.round(chipVal),
      weight: 10,
      text:
        turnover == null
          ? '换手待更新'
          : `换手 ${round(turnover, 1)}% · 流通 ${round(capYi, 0)} 亿`
    },
    {
      key: 'profile',
      label: '历史画像',
      value: Math.round(fit.score),
      weight: 15,
      text: fit.sampleEvidence.length ? `${fit.sampleEvidence.length} 条样本桶` : '基础规则'
    }
  ]
  const score = Math.round(
    clamp(
      factors.reduce((sum, f) => sum + f.value * f.weight, 0) / 100,
      0,
      99
    )
  )

  const why = []
  if (weak && weak.score >= 60) why.push(weak.detail)
  if (sector) {
    why.push(
      `「${sector.name}」${sector.dataReady ? '三关通过' : `过 ${passed}/3 关`}` +
        `，今 ${sector.todayCount == null ? '--' : sector.todayCount} 家涨停` +
        (sector.maxBoard ? `，最高 ${sector.maxBoard} 板` : '')
    )
  }
  if (sealed) {
    why.push(
      `${sealTimeLabel(s.firstSeal)} 首封 · 封单占流通 ${round(sealRatio, 2)}%` +
        (blow ? ` · 炸板 ${blow} 次` : ' · 无炸板')
    )
  } else if (pct != null) {
    why.push(
      `实时 ${pct > 0 ? '+' : ''}${round(pct, 2)}%，距涨停 ${round(Math.max(0, limitPct - pct), 1)} 个点`
    )
  }
  if (turnover != null && turnover >= 3 && turnover <= 20) {
    why.push(`换手 ${round(turnover, 1)}% 处于良性区间，流通 ${round(capYi, 0)} 亿`)
  }
  const best = fit.sampleEvidence.slice().sort((a, b) => b.rate - a.rate)[0]
  if (best) {
    why.push(
      `历史画像 ${fit.score} 分：${best.dimension} ${best.bucket} 样本延续率 ${best.rate}%（${best.samples} 条）`
    )
  }
  if (sentiment && sentiment.signal && sentiment.signal.label) {
    why.push(`市场${sentiment.signal.label}：${sentiment.signal.note || '按纪律执行'}`)
  }
  if (s.mainInflow != null && s.mainInflow > 0) {
    why.push(`个股主力净流入 ${flowText(s.mainInflow)}`)
  }

  const risks = []
  if (sentiment && sentiment.phaseKey === 'ice') risks.push('情绪冰点，强转弱概率高')
  if (sentiment && sentiment.phaseKey === 'ebb') risks.push('分歧退潮期，高位股补跌风险')
  if (!sealed) risks.push('尚未封板，冲板失败回落风险')
  if (lbc >= 5) risks.push('高位连板，分歧时波动放大')
  if (blow > 0) risks.push(`炸板 ${blow} 次，封板稳定性待确认`)
  if (sealRatio > 0 && sealRatio < 0.5) risks.push(`封单偏薄（${round(sealRatio, 2)}% 流通）`)
  if (turnover != null && turnover > 30) risks.push(`换手 ${round(turnover, 1)}% 过热`)
  if (capYi > 0 && capYi < 40) risks.push('流通盘偏小，波动与操控风险高')
  risks.push(...fit.misses.slice(0, 2))

  const tags = []
  if (weak && weak.score >= 78) tags.push(weak.label)
  if (sealed && minutes <= 30) tags.push('早盘封板')
  if (sealRatio >= 2) tags.push('封单强')
  if (!sealed && pct != null && pct >= limitPct - 2) tags.push('临近涨停')
  if (fit.score >= 70) tags.push('画像匹配')
  if (sector && sector.dataReady) tags.push('三关通过')

  return {
    score,
    factors,
    why: why.slice(0, 7),
    risks: Array.from(new Set(risks)).slice(0, 5),
    fit,
    weak: weak || null,
    weakLabel: weak ? weak.label : '',
    tags
  }
}

/**
 * 把基因分并入选股分：72% 原角色分 + 28% 基因分，再按三关封顶。
 * 弱转强、情绪、画像因此会进入最终排序，而不是只在详情里展示。
 */
function enrichPicks(picks, { sectors = [], profile = null, sentiment = null } = {}) {
  const map = new Map((sectors || []).map((s) => [s.key, s]))
  const out = []
  for (const pick of picks || []) {
    const sector = map.get(pick.sectorKey) || null
    const gene = geneScore({
      stock: pick,
      sector,
      weak: pick.weak,
      sentiment,
      profile
    })
    let score = Math.round(clamp(num(pick.score, 60) * 0.72 + gene.score * 0.28, 0, 99))
    if (!sector || !sector.dataReady) score = Math.min(score, 68)
    if (sector && sector.group === 'new') score = Math.min(score, 60)
    out.push({
      ...pick,
      baseScore: pick.score,
      score,
      gene,
      why: gene.why,
      tags: Array.from(new Set([...(pick.tags || []), ...gene.tags])),
      risks: Array.from(new Set([...(pick.risks || []), ...gene.risks])).slice(0, 5),
      weak: pick.weak || gene.weak || null
    })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 8)
}

module.exports = {
  limitRatioFor,
  findBucket,
  fitDragonCandidate,
  buildWeakContext,
  weakMapFor,
  weakForCode,
  geneScore,
  enrichPicks,
  PHASE_GENE
}