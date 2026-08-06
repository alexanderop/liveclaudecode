import type { CompactionEventWire, ContextUsageSampleWire } from '#shared/schemas/api'
import type { ChartMarker } from '~/components/charts/chart'
import { parseTimestamp } from './format'

/**
 * Derivations for the context-pressure chart. Every model request carries its
 * own token counts, so the session's context growth, its cache behavior, and
 * the effect of each compaction are all recoverable from the sample list
 * without any further server work.
 */

/** One plotted request. Keys double as chart series names. */
export interface ContextPoint extends Record<string, string | number | undefined> {
  /** Total prompt tokens for the request: uncached input plus both cache paths. */
  context: number
  cacheRead: number
  cacheWrite: number
  label: string
  model: string
  ts: string
}

/** A chart needs at least two points before a line says anything about a trend. */
export const MIN_CHART_POINTS = 2

/** Total prompt tokens a request sent, which is what fills the context window. */
export function promptTokens(sample: ContextUsageSampleWire): number {
  return sample.usage.in + sample.usage.cr + sample.usage.cw
}

export function contextPoints(samples: readonly ContextUsageSampleWire[]): ContextPoint[] {
  return samples.map((sample, index) => ({
    context: promptTokens(sample),
    cacheRead: sample.usage.cr,
    cacheWrite: sample.usage.cw,
    label: String(index + 1),
    model: sample.model,
    ts: sample.ts ?? '',
  }))
}

/**
 * Place each compaction on the request that follows it, which is the first one
 * to run with the reduced context. A compaction after the last request has no
 * point to sit on and is dropped rather than pinned to the end.
 */
export function compactionMarkers(
  samples: readonly ContextUsageSampleWire[],
  compactions: readonly CompactionEventWire[],
): ChartMarker[] {
  const markers: ChartMarker[] = []
  for (const compaction of compactions) {
    const at = parseTimestamp(compaction.ts)
    if (at === null) continue
    const index = samples.findIndex((sample) => {
      const sampleAt = parseTimestamp(sample.ts)
      return sampleAt !== null && sampleAt >= at
    })
    if (index < 0) continue
    markers.push({
      index,
      label: `Compaction · ${compaction.trigger || 'automatic'}`,
    })
  }
  return markers
}

export interface ContextSummary {
  requests: number
  /** The largest prompt the session sent, i.e. how full the context window got. */
  peakContext: number
  /** Share of prompt tokens served from cache, between 0 and 1. */
  cacheHitRate: number
  cacheWrite5m: number
  cacheWrite1h: number
  webSearchRequests: number
  /** Distinct service tiers seen, in first-seen order; usually one. */
  tiers: string[]
  /** Distinct response speeds seen, in first-seen order. */
  speeds: string[]
  /**
   * Stop reasons other than a normal turn or tool call, counted by reason.
   * `max_tokens` here means the model's reply was cut off mid-sentence.
   */
  abnormalStops: Array<{ reason: string, count: number }>
}

const EXPECTED_STOP_REASONS = new Set(['end_turn', 'tool_use', null])

export function contextSummary(samples: readonly ContextUsageSampleWire[]): ContextSummary {
  const tiers: string[] = []
  const speeds: string[] = []
  const stops = new Map<string, number>()
  let peakContext = 0
  let promptTotal = 0
  let cacheRead = 0
  let cacheWrite5m = 0
  let cacheWrite1h = 0
  let webSearchRequests = 0

  for (const sample of samples) {
    const prompt = promptTokens(sample)
    peakContext = Math.max(peakContext, prompt)
    promptTotal += prompt
    cacheRead += sample.usage.cr
    cacheWrite5m += sample.cacheWrite5m ?? 0
    cacheWrite1h += sample.cacheWrite1h ?? 0
    webSearchRequests += sample.webSearchRequests ?? 0
    if (sample.serviceTier && !tiers.includes(sample.serviceTier)) tiers.push(sample.serviceTier)
    if (sample.speed && !speeds.includes(sample.speed)) speeds.push(sample.speed)
    if (!EXPECTED_STOP_REASONS.has(sample.stopReason)) {
      const reason = sample.stopReason ?? 'unknown'
      stops.set(reason, (stops.get(reason) ?? 0) + 1)
    }
  }

  return {
    requests: samples.length,
    peakContext,
    cacheHitRate: promptTotal ? cacheRead / promptTotal : 0,
    cacheWrite5m,
    cacheWrite1h,
    webSearchRequests,
    tiers,
    speeds,
    abnormalStops: [...stops].map(([reason, count]) => ({ reason, count })),
  }
}
