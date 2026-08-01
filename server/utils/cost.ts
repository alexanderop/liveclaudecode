import { DateTime, Option, Predicate } from 'effect'
import { addUsage, emptyUsage } from './run-shared'
import type {
  ContextUsageSample,
  CostEstimate,
  CostOverviewGroup,
  CostOverviewResponse,
  CostSummary,
  SessionSource,
  SessionSourceStatus,
  Usage,
} from '#shared/types/run'

interface CostRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
}

interface ProviderTokenRates {
  input: number
  cachedInput: number
  output: number
  cacheWrite?: number
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

export interface CostUsageSample extends ClaudeCostSample {
  source: SessionSource
  sessionKey: string
  usage: Usage
  requests: number
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
  return Option.isSome(parsed) && DateTime.isGreaterThanOrEqualTo(parsed.value, boundary)
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
    Predicate.isNumber(value) && Number.isFinite(value) && value > 0 ? value : 0
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

export function claudeCostSample(
  sample: ContextUsageSample,
  sessionKey = '',
): CostUsageSample {
  return {
    ts: sample.ts,
    model: sample.model,
    usd: estimateClaudeUsageCost(sample.model, sample.usage, sample.ts, sample),
    source: 'claude',
    sessionKey,
    usage: { ...sample.usage },
    requests: 1,
    ...(sample.messageId || sample.requestId
      ? { id: sample.messageId || sample.requestId }
      : {}),
  }
}

export function providerCostSample(
  source: Exclude<SessionSource, 'claude'>,
  sessionKey: string,
  sample: Pick<ContextUsageSample, 'ts' | 'model' | 'usage'>,
): CostUsageSample {
  const usd = source === 'codex'
    ? estimateCodexUsageCost(sample.model, sample.usage)
    : estimateCopilotUsageCost(sample.model, sample.usage, sample.ts)
  return {
    source,
    sessionKey,
    ts: sample.ts,
    model: sample.model,
    usage: { ...sample.usage },
    usd,
    requests: Object.values(sample.usage).some(value => value > 0) ? 1 : 0,
  }
}

function providerTokenCost(
  usage: Usage,
  price: ProviderTokenRates | null,
  cachedIncludedInInput: boolean,
): number | null {
  if (!price) return null
  const tokens = (value: number): number =>
    Number.isFinite(value) && value > 0 ? value : 0
  const cached = tokens(usage.cr)
  const input = Math.max(0, tokens(usage.in) - (cachedIncludedInInput ? cached : 0))
  return (
    input * price.input
    + cached * price.cachedInput
    + tokens(usage.out) * price.output
    + tokens(usage.cw) * (price.cacheWrite ?? price.input)
  ) / MTOK
}

/** Public OpenAI API-equivalent rates for models recorded by Codex. */
export function codexCostRates(model: string): ProviderTokenRates | null {
  const id = model.toLowerCase()
  if (id.includes('gpt-5.3-codex-spark')) return null
  if (id.includes('gpt-5.6-sol')) return { input: 5, cachedInput: 0.5, output: 30 }
  if (id.includes('gpt-5.6-terra')) return { input: 2.5, cachedInput: 0.25, output: 15 }
  if (id.includes('gpt-5.6-luna')) return { input: 1, cachedInput: 0.1, output: 6 }
  if (id.includes('gpt-5.5')) return { input: 5, cachedInput: 0.5, output: 30 }
  if (id.includes('gpt-5.4-mini')) return { input: 0.75, cachedInput: 0.075, output: 4.5 }
  if (id.includes('gpt-5.4-nano')) return { input: 0.2, cachedInput: 0.02, output: 1.25 }
  if (id.includes('gpt-5.4')) return { input: 2.5, cachedInput: 0.25, output: 15 }
  if (id.includes('gpt-5.3-codex') || id.includes('gpt-5.2')) {
    return { input: 1.75, cachedInput: 0.175, output: 14 }
  }
  if (id.includes('gpt-5-mini')) return { input: 0.25, cachedInput: 0.025, output: 2 }
  return null
}

export function estimateCodexUsageCost(model: string, usage: Usage): number | null {
  // Codex reports cached input as a subset of total input tokens.
  return providerTokenCost(usage, codexCostRates(model), true)
}

/** Current GitHub AI-credit token rates, expressed as their USD equivalent. */
export function copilotCostRates(
  model: string,
  timestamp: string | null,
): ProviderTokenRates | null {
  const id = model.toLowerCase().replaceAll('_', '-')
  if (id.includes('gpt-5.6-sol')) return { input: 5, cachedInput: 0.5, output: 30 }
  if (id.includes('gpt-5.6-terra')) return { input: 2, cachedInput: 0.2, output: 12 }
  if (id.includes('gpt-5.6-luna')) return { input: 0.2, cachedInput: 0.02, output: 1.2 }
  if (id.includes('gpt-5.5')) return { input: 5, cachedInput: 0.5, output: 30 }
  if (id.includes('gpt-5.4-mini')) return { input: 0.75, cachedInput: 0.075, output: 4.5 }
  if (id.includes('gpt-5.4-nano')) return { input: 0.2, cachedInput: 0.02, output: 1.25 }
  if (id.includes('gpt-5.4')) return { input: 2.5, cachedInput: 0.25, output: 15 }
  if (id.includes('gpt-5.3-codex')) return { input: 1.75, cachedInput: 0.175, output: 14 }
  if (id.includes('gpt-5-mini')) return { input: 0.25, cachedInput: 0.025, output: 2 }

  if (id.includes('claude-sonnet-5')) {
    const introductory = !isAtOrAfter(timestamp, SONNET_5_STANDARD_PRICING_START)
    return introductory
      ? { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 }
      : { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 }
  }
  if (/claude-sonnet-4(?:[.-](?:5|6))?(?:-|$)/.test(id)) {
    return { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 }
  }
  if (/claude-opus-(?:4[.-](?:5|6|7|8)|5)(?:-|$)/.test(id)) {
    return { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 }
  }
  if (id.includes('claude-haiku-4.5')) {
    return { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 5 }
  }
  if (id.includes('claude-fable-5')) {
    return { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 }
  }
  if (id.includes('gemini-2.5-pro')) return { input: 1.25, cachedInput: 0.125, output: 10 }
  if (id.includes('gemini-3.1-pro')) return { input: 2, cachedInput: 0.2, output: 12 }
  if (id.includes('gemini-3-flash')) return { input: 0.5, cachedInput: 0.05, output: 3 }
  if (id.includes('gemini-3.5-flash')) return { input: 1.5, cachedInput: 0.15, output: 9 }
  if (id.includes('gemini-3.6-flash')) return { input: 1.5, cachedInput: 0.15, output: 7.5 }
  if (id.includes('raptor-mini')) return { input: 0.25, cachedInput: 0.025, output: 2 }
  if (id.includes('mai-code-1-flash')) return { input: 0.75, cachedInput: 0.075, output: 4.5 }
  if (id.includes('grok-4.5')) return { input: 2, cachedInput: 0.5, output: 6 }
  if (id.includes('kimi-k2.7-code')) return { input: 0.95, cachedInput: 0.19, output: 4 }
  return null
}

export function estimateCopilotUsageCost(
  model: string,
  usage: Usage,
  timestamp: string | null,
): number | null {
  return providerTokenCost(usage, copilotCostRates(model, timestamp), false)
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

const SOURCE_LABELS: Record<SessionSource, string> = {
  claude: 'Claude Code',
  codex: 'OpenAI Codex',
  copilot: 'GitHub Copilot',
}

function overviewGroup(
  samples: ReadonlyArray<CostUsageSample>,
  source: SessionSource,
  model: string | null,
  sessionsFallback = 0,
): CostOverviewGroup {
  const usage = emptyUsage()
  const sessions = new Set<string>()
  const days = new Map<string, { estimatedUsd: number, usage: Usage }>()
  let estimatedUsd = 0
  let pricedRequests = 0
  let unpricedRequests = 0

  for (const sample of samples) {
    addUsage(usage, sample.usage)
    if (sample.sessionKey) sessions.add(sample.sessionKey)
    if (sample.usd === null) unpricedRequests += sample.requests
    else {
      estimatedUsd += sample.usd
      pricedRequests += sample.requests
    }
    const date = sample.ts?.slice(0, 10)
    if (!date) continue
    const day = days.get(date) || { estimatedUsd: 0, usage: emptyUsage() }
    if (sample.usd !== null) day.estimatedUsd += sample.usd
    addUsage(day.usage, sample.usage)
    days.set(date, day)
  }

  return {
    source,
    label: model || SOURCE_LABELS[source],
    model,
    sessions: sessionsFallback || sessions.size,
    usage,
    estimatedUsd: pricedRequests ? estimatedUsd : null,
    pricedRequests,
    unpricedRequests,
    days: [...days.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, day]) => ({ date, ...day })),
  }
}

export function buildCostOverview(
  inputSamples: ReadonlyArray<CostUsageSample>,
  sources: ReadonlyArray<SessionSourceStatus>,
  nowMillis: number,
  hours: number,
): CostOverviewResponse {
  const coverageStart = hours <= 0
    ? Number.NEGATIVE_INFINITY
    : nowMillis - hours * 3_600_000
  const samples = dedupeCostSamples(inputSamples).filter((sample): sample is CostUsageSample => {
    const timestamp = sampleMillis(sample)
    return 'source' in sample
      && timestamp !== null
      && timestamp >= coverageStart
      && timestamp <= nowMillis
  })
  const harnesses = (['claude', 'codex', 'copilot'] as const).map((source) => {
    const sourceSamples = samples.filter(sample => sample.source === source)
    return overviewGroup(
      sourceSamples,
      source,
      null,
      sources.find(status => status.source === source)?.sessions || 0,
    )
  })
  const modelSamples = new Map<string, CostUsageSample[]>()
  for (const sample of samples) {
    const model = sample.model.trim() || 'Unknown model'
    const key = `${sample.source}\0${model}`
    const group = modelSamples.get(key) || []
    group.push({ ...sample, model })
    modelSamples.set(key, group)
  }
  const models = [...modelSamples.values()]
    .map(group => overviewGroup(group, group[0]!.source, group[0]!.model))
    .sort((left, right) =>
      (right.estimatedUsd || 0) - (left.estimatedUsd || 0)
      || (right.usage.in + right.usage.out + right.usage.cr + right.usage.cw)
      - (left.usage.in + left.usage.out + left.usage.cr + left.usage.cw)
      || left.label.localeCompare(right.label),
    )
  const usage = emptyUsage()
  harnesses.forEach(group => addUsage(usage, group.usage))

  return {
    now: nowMillis / 1_000,
    hours,
    currency: 'USD',
    estimated: true,
    estimatedUsd: harnesses.reduce((total, group) => total + (group.estimatedUsd || 0), 0),
    pricedRequests: harnesses.reduce((total, group) => total + group.pricedRequests, 0),
    unpricedRequests: harnesses.reduce((total, group) => total + group.unpricedRequests, 0),
    sessions: sources.reduce((total, source) => total + source.sessions, 0),
    usage,
    harnesses,
    models,
    sources: [...sources],
  }
}
