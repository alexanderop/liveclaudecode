import { DateTime, Option } from 'effect'
import type {
  ContextUsageSample,
  CostEstimate,
  CostSummary,
  Usage,
} from '#shared/types/run'

interface CostRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface ClaudeCostSample {
  ts: string | null
  model: string
  usd: number | null
}

const MTOK = 1_000_000
const SONNET_5_STANDARD_PRICING_START = DateTime.makeUnsafe('2026-09-01T00:00:00.000Z')

function rates(
  input: number,
  output: number,
  cacheRead = input * 0.1,
  cacheWrite = input * 1.25,
): CostRates {
  return { input, output, cacheRead, cacheWrite }
}

function isAtOrAfter(timestamp: string | null, boundary: DateTime.Utc): boolean {
  const parsed = DateTime.make(timestamp || '')
  return Option.isSome(parsed)
    && DateTime.toEpochMillis(parsed.value) >= DateTime.toEpochMillis(boundary)
}

/**
 * Standard first-party Claude API rates in USD per million tokens.
 *
 * Claude transcript model ids use both `claude-opus-4-5` and legacy
 * `claude-3-5-sonnet` ordering, so the matcher intentionally handles both.
 */
export function claudeCostRates(model: string, timestamp: string | null): CostRates | null {
  const id = model.toLowerCase()

  if (id.includes('fable-5') || id.includes('mythos-5')) return rates(10, 50)

  if (id.includes('opus')) {
    if (id.includes('opus-5')) return rates(5, 25)
    if (/opus-4-(?:5|6|7|8)(?:-|$)/.test(id)) return rates(5, 25)
    if (/opus-4(?:-1)?(?:-|$)/.test(id)) return rates(15, 75)
    if (/claude-3-opus(?:-|$)/.test(id)) return rates(15, 75)
  }

  if (id.includes('sonnet')) {
    if (id.includes('sonnet-5')) {
      return isAtOrAfter(timestamp, SONNET_5_STANDARD_PRICING_START)
        ? rates(3, 15)
        : rates(2, 10)
    }
    if (/sonnet-4(?:-[456])?(?:-|$)/.test(id)) return rates(3, 15)
    if (/claude-3-(?:5|7)-sonnet(?:-|$)/.test(id)) return rates(3, 15)
    if (/claude-3-sonnet(?:-|$)/.test(id)) return rates(3, 15)
  }

  if (id.includes('haiku')) {
    if (/haiku-4-5(?:-|$)/.test(id)) return rates(1, 5)
    if (/claude-3-5-haiku(?:-|$)/.test(id)) return rates(0.8, 4)
    if (/claude-3-haiku(?:-|$)/.test(id)) return rates(0.25, 1.25, 0.03, 0.3)
  }

  return null
}

export function estimateClaudeUsageCost(
  model: string,
  usage: Usage,
  timestamp: string | null,
): number | null {
  const price = claudeCostRates(model, timestamp)
  if (!price) return null
  return (
    usage.in * price.input
    + usage.out * price.output
    + usage.cr * price.cacheRead
    + usage.cw * price.cacheWrite
  ) / MTOK
}

export function claudeCostSample(sample: ContextUsageSample): ClaudeCostSample {
  return {
    ts: sample.ts,
    model: sample.model,
    usd: estimateClaudeUsageCost(sample.model, sample.usage, sample.ts),
  }
}

export function estimateCosts(samples: ReadonlyArray<ClaudeCostSample>): CostEstimate {
  return samples.reduce<CostEstimate>((total, sample) => {
    if (sample.usd === null) total.unpricedRequests += 1
    else {
      total.usd += sample.usd
      total.pricedRequests += 1
    }
    return total
  }, { usd: 0, pricedRequests: 0, unpricedRequests: 0, estimated: true })
}

function sampleMillis(sample: ClaudeCostSample): number | null {
  const parsed = DateTime.make(sample.ts || '')
  return Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) : null
}

export function summarizeCosts(
  samples: ReadonlyArray<ClaudeCostSample>,
  nowMillis: number,
  coverageHours: number,
  timeZone: DateTime.TimeZone = DateTime.zoneMakeLocal(),
): CostSummary {
  const now = DateTime.setZone(DateTime.makeUnsafe(nowMillis), timeZone)
  const coverageStart = coverageHours <= 0
    ? Number.NEGATIVE_INFINITY
    : nowMillis - coverageHours * 3_600_000
  const coveredSamples = samples.filter((sample) => {
    const timestamp = sampleMillis(sample)
    return timestamp !== null && timestamp >= coverageStart && timestamp <= nowMillis
  })
  const estimate = estimateCosts(coveredSamples)
  const todayStart = DateTime.toEpochMillis(DateTime.startOf(now, 'day'))
  const sevenDayStart = DateTime.toEpochMillis(
    DateTime.startOf(DateTime.subtract(now, { days: 6 }), 'day'),
  )
  let todayUsd = 0
  let last7DaysUsd = 0

  for (const sample of coveredSamples) {
    if (sample.usd === null) continue
    const timestamp = sampleMillis(sample)
    if (timestamp === null || timestamp > nowMillis) continue
    if (timestamp >= todayStart) todayUsd += sample.usd
    if (timestamp >= sevenDayStart) last7DaysUsd += sample.usd
  }

  return {
    ...estimate,
    currency: 'USD',
    todayUsd,
    last7DaysUsd: coverageHours === 0 || coverageHours >= 168 ? last7DaysUsd : null,
    coverageHours,
  }
}
