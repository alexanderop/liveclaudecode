import { assert, describe, it } from '@effect/vitest'
import {
  compactionMarkers,
  contextPoints,
  contextSummary,
  promptTokens,
} from '~/utils/context-pressure'
import type { CompactionEvent, ContextUsageSample, Usage } from '#shared/types/run'

function usage(overrides: Partial<Usage> = {}): Usage {
  return { in: 0, out: 0, cr: 0, cw: 0, ...overrides }
}

function sample(
  ts: string | null,
  overrides: Partial<ContextUsageSample> = {},
): ContextUsageSample {
  return {
    ts,
    model: 'claude-opus-5',
    effort: 'medium',
    usage: usage({ in: 100, cr: 300, cw: 100, out: 50 }),
    stopReason: 'tool_use',
    ...overrides,
  }
}

function compaction(ts: string | null, trigger = ''): CompactionEvent {
  return {
    ts,
    durationMs: 0,
    preTokens: 0,
    postTokens: 0,
    droppedTokens: 0,
    preservedMessages: 0,
    trigger,
  }
}

describe('promptTokens', () => {
  it('counts every path that fills the context window', () => {
    assert.strictEqual(promptTokens(sample('2026-08-01T10:00:00.000Z')), 500)
  })

  it('ignores output tokens, which do not occupy the prompt', () => {
    const only = sample('2026-08-01T10:00:00.000Z', { usage: usage({ out: 9_000 }) })
    assert.strictEqual(promptTokens(only), 0)
  })
})

describe('contextPoints', () => {
  it('emits one point per request, numbered in order', () => {
    const points = contextPoints([
      sample('2026-08-01T10:00:00.000Z'),
      sample('2026-08-01T10:01:00.000Z', { usage: usage({ in: 1, cr: 2, cw: 3 }) }),
    ])
    assert.deepStrictEqual(points.map(point => point.label), ['1', '2'])
    assert.deepStrictEqual(points.map(point => point.context), [500, 6])
    assert.deepStrictEqual(points.map(point => point.cacheRead), [300, 2])
    assert.deepStrictEqual(points.map(point => point.cacheWrite), [100, 3])
  })

  it('substitutes an empty string for a missing timestamp', () => {
    assert.strictEqual(contextPoints([sample(null)])[0]?.ts, '')
  })
})

describe('compactionMarkers', () => {
  const samples = [
    sample('2026-08-01T10:00:00.000Z'),
    sample('2026-08-01T10:05:00.000Z'),
    sample('2026-08-01T10:10:00.000Z'),
  ]

  it('marks the first request that ran after the compaction', () => {
    const markers = compactionMarkers(samples, [compaction('2026-08-01T10:02:00.000Z', 'auto')])
    assert.deepStrictEqual(markers, [{ index: 1, label: 'Compaction · auto' }])
  })

  it('names an untriggered compaction automatic', () => {
    const markers = compactionMarkers(samples, [compaction('2026-08-01T10:02:00.000Z')])
    assert.strictEqual(markers[0]?.label, 'Compaction · automatic')
  })

  it('drops a compaction with no request after it rather than pinning it to the end', () => {
    assert.deepStrictEqual(
      compactionMarkers(samples, [compaction('2026-08-01T11:00:00.000Z')]),
      [],
    )
  })

  it('drops a compaction with no usable timestamp', () => {
    assert.deepStrictEqual(compactionMarkers(samples, [compaction(null)]), [])
  })
})

describe('contextSummary', () => {
  it('reports peak prompt size and the cache share of all prompt tokens', () => {
    const summary = contextSummary([
      sample('2026-08-01T10:00:00.000Z', { usage: usage({ in: 100, cr: 0, cw: 100 }) }),
      sample('2026-08-01T10:01:00.000Z', { usage: usage({ in: 100, cr: 600, cw: 0 }) }),
    ])
    assert.strictEqual(summary.requests, 2)
    assert.strictEqual(summary.peakContext, 700)
    assert.strictEqual(summary.cacheHitRate, 600 / 900)
  })

  it('has no cache hit rate to report when nothing was sent', () => {
    assert.strictEqual(contextSummary([]).cacheHitRate, 0)
  })

  it('totals the cache TTL split, which is priced differently per tier', () => {
    const summary = contextSummary([
      sample('2026-08-01T10:00:00.000Z', { cacheWrite5m: 10, cacheWrite1h: 4 }),
      sample('2026-08-01T10:01:00.000Z', { cacheWrite5m: 5 }),
    ])
    assert.strictEqual(summary.cacheWrite5m, 15)
    assert.strictEqual(summary.cacheWrite1h, 4)
  })

  it('keeps distinct tiers and speeds in first-seen order', () => {
    const summary = contextSummary([
      sample('2026-08-01T10:00:00.000Z', { serviceTier: 'standard', speed: 'fast' }),
      sample('2026-08-01T10:01:00.000Z', { serviceTier: 'priority', speed: 'fast' }),
      sample('2026-08-01T10:02:00.000Z', { serviceTier: 'standard' }),
    ])
    assert.deepStrictEqual(summary.tiers, ['standard', 'priority'])
    assert.deepStrictEqual(summary.speeds, ['fast'])
  })

  it('counts only stop reasons that mean the reply did not finish normally', () => {
    const summary = contextSummary([
      sample('2026-08-01T10:00:00.000Z', { stopReason: 'end_turn' }),
      sample('2026-08-01T10:01:00.000Z', { stopReason: 'tool_use' }),
      sample('2026-08-01T10:02:00.000Z', { stopReason: null }),
      sample('2026-08-01T10:03:00.000Z', { stopReason: 'max_tokens' }),
      sample('2026-08-01T10:04:00.000Z', { stopReason: 'max_tokens' }),
    ])
    assert.deepStrictEqual(summary.abnormalStops, [{ reason: 'max_tokens', count: 2 }])
  })
})
