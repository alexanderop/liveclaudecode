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
  cacheWrite5m: number
  cacheWrite1h: number
}

export interface ClaudePricingContext {
  cacheWrite5m?: number
  cacheWrite1h?: number
  webSearchRequests?: number
  serviceTier?: string
  inferenceGeo?: string
  speed?: string
}

export interface ClaudeCostSample {
  ts: string | null
  model: string
  usd: number | null
  id?: string
}

const MTOK = 1_000_000
const SONNET_5_STANDARD_PRICING_START = DateTime.makeUnsafe('2026-09-01T00:00:00.000Z')

function rates(
  input: number,
  output: number,
  cacheRead = input * 0.1,
  cacheWrite5m = input * 1.25,
): CostRates {
  return { input, output, cacheRead, cacheWrite5m, cacheWrite1h: input * 2 }
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
export function claudeCostRates(
  model: string,
  timestamp: string | null,
  speed = 'standard',
): CostRates | null {
  const id = model.toLowerCase()

  if (speed === 'fast') {
    if (id.includes('opus-5') || /opus-4-8(?:-|$)/.test(id)) return rates(10, 50)
    return null
  }
  if (speed && speed !== 'standard') return null

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
  context: ClaudePricingContext = {},
): number | null {
  if (context.serviceTier
    && !['standard', 'auto', 'standard_only'].includes(context.serviceTier)) return null
  if (context.inferenceGeo
    && !['global', 'not_available', 'us'].includes(context.inferenceGeo)) return null

  const price = claudeCostRates(model, timestamp, context.speed)
  if (!price) return null

  const tokens = (value: number | undefined): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
  const cacheWrite1h = tokens(context.cacheWrite1h)
  const reportedCacheWrite5m = tokens(context.cacheWrite5m)
  const totalCacheWrite = Math.max(
    tokens(usage.cw),
    cacheWrite1h + reportedCacheWrite5m,
  )
  // Older transcripts only contain the aggregate. Treat the unexplained
  // remainder as a five-minute write, the least surprising legacy behavior.
  const cacheWrite5m = Math.max(0, totalCacheWrite - cacheWrite1h)
  const tokenCost = (
    tokens(usage.in) * price.input
    + tokens(usage.out) * price.output
    + tokens(usage.cr) * price.cacheRead
    + cacheWrite5m * price.cacheWrite5m
    + cacheWrite1h * price.cacheWrite1h
  ) / MTOK
  const geoMultiplier = context.inferenceGeo === 'us' ? 1.1 : 1
  const webSearchCost = tokens(context.webSearchRequests) * 0.01
  return tokenCost * geoMultiplier + webSearchCost
}

export function claudeCostSample(sample: ContextUsageSample): ClaudeCostSample {
  return {
    ts: sample.ts,
    model: sample.model,
    usd: estimateClaudeUsageCost(sample.model, sample.usage, sample.ts, sample),
    ...(sample.messageId || sample.requestId
      ? { id: sample.messageId || sample.requestId }
      : {}),
  }
}

/**
 * Claude Code can persist multiple snapshots of one assistant message. Its SDK
 * cost guidance says to count a message id once and keep the final/highest
 * usage snapshot.
 */
export function dedupeCostSamples(
  samples: ReadonlyArray<ClaudeCostSample>,
): ClaudeCostSample[] {
  const unkeyed: ClaudeCostSample[] = []
  const keyed = new Map<string, ClaudeCostSample>()
  for (const sample of samples) {
    if (!sample.id) {
      unkeyed.push(sample)
      continue
    }
    const previous = keyed.get(sample.id)
    if (!previous
      || (sample.usd ?? -1) > (previous.usd ?? -1)
      || (sample.usd === previous.usd && (sample.ts || '') > (previous.ts || ''))) {
      keyed.set(sample.id, sample)
    }
  }
  return [...unkeyed, ...keyed.values()]
}

export function estimateCosts(samples: ReadonlyArray<ClaudeCostSample>): CostEstimate {
  return dedupeCostSamples(samples).reduce<CostEstimate>((total, sample) => {
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
  const coveredSamples = dedupeCostSamples(samples).filter((sample) => {
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
