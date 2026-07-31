import { DateTime } from 'effect'
import { assert, describe, it } from '@effect/vitest'
import {
  claudeCostSample,
  buildCostOverview,
  estimateCodexUsageCost,
  estimateCopilotUsageCost,
  dedupeCostSamples,
  estimateClaudeUsageCost,
  estimateCosts,
  summarizeCosts,
  providerCostSample,
} from '../../server/utils/cost'

describe('Claude cost estimates', () => {
  it('prices all four token classes using the recorded model', () => {
    const cost = estimateClaudeUsageCost('claude-opus-5', {
      in: 1_000_000,
      out: 1_000_000,
      cr: 1_000_000,
      cw: 1_000_000,
    }, '2026-07-31T12:00:00.000Z')

    assert.strictEqual(cost, 36.75)
  })

  it('applies the dated introductory Sonnet 5 rate', () => {
    const usage = { in: 1_000_000, out: 1_000_000, cr: 0, cw: 0 }
    assert.strictEqual(
      estimateClaudeUsageCost('claude-sonnet-5', usage, '2026-08-31T23:59:59.000Z'),
      12,
    )
    assert.strictEqual(
      estimateClaudeUsageCost('claude-sonnet-5', usage, '2026-09-01T00:00:00.000Z'),
      18,
    )
  })

  it('reconciles the recorded Sonnet 5 request using its one-hour cache write', () => {
    const cost = estimateClaudeUsageCost(
      'claude-sonnet-5',
      { in: 2, out: 11, cr: 3_289, cw: 1_507 },
      '2026-07-31T12:00:00.000Z',
      {
        cacheWrite5m: 0,
        cacheWrite1h: 1_507,
        serviceTier: 'standard',
        inferenceGeo: 'not_available',
        speed: 'standard',
      },
    )

    assert.strictEqual(cost, 0.0067998)
  })

  it('prices five-minute and one-hour cache writes at their distinct multipliers', () => {
    const cost = estimateClaudeUsageCost(
      'claude-opus-5',
      { in: 0, out: 0, cr: 0, cw: 2_000_000 },
      '2026-07-31T12:00:00.000Z',
      { cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000 },
    )

    assert.strictEqual(cost, 16.25)
  })

  it('normalizes invalid token counts and does not drop a valid cache breakdown', () => {
    const cost = estimateClaudeUsageCost(
      'claude-opus-5',
      { in: -1, out: Number.NaN, cr: Number.POSITIVE_INFINITY, cw: 5 },
      '2026-07-31T12:00:00.000Z',
      { cacheWrite5m: 10, cacheWrite1h: 20 },
    )

    assert.strictEqual(cost, (10 * 6.25 + 20 * 10) / 1_000_000)
  })

  it('applies supported pricing modifiers and tool charges', () => {
    assert.strictEqual(
      estimateClaudeUsageCost(
        'claude-opus-5',
        { in: 1_000_000, out: 1_000_000, cr: 0, cw: 0 },
        '2026-07-31T12:00:00.000Z',
        { speed: 'fast', inferenceGeo: 'us', webSearchRequests: 2 },
      ),
      66.02,
    )
  })

  it('leaves non-public service tiers and unknown modifiers unpriced', () => {
    const usage = { in: 10, out: 5, cr: 0, cw: 0 }
    assert.strictEqual(
      estimateClaudeUsageCost('claude-opus-5', usage, null, { serviceTier: 'priority' }),
      null,
    )
    assert.strictEqual(
      estimateClaudeUsageCost('claude-opus-5', usage, null, { speed: 'turbo' }),
      null,
    )
  })

  it('leaves unknown models unpriced instead of inventing a rate', () => {
    assert.strictEqual(
      estimateClaudeUsageCost('claude-future-unknown', { in: 10, out: 5, cr: 0, cw: 0 }, null),
      null,
    )
  })

  it('estimates Codex at the equivalent OpenAI API rate without double-counting cached input', () => {
    assert.strictEqual(
      estimateCodexUsageCost('gpt-5.6-sol', {
        in: 1_000_000,
        out: 100_000,
        cr: 500_000,
        cw: 0,
      }),
      5.75,
    )
    assert.strictEqual(
      estimateCodexUsageCost('gpt-5.3-codex-spark', {
        in: 1_000_000,
        out: 100_000,
        cr: 0,
        cw: 0,
      }),
      null,
    )
  })

  it('uses GitHub AI-credit token rates for Copilot models', () => {
    assert.strictEqual(
      estimateCopilotUsageCost(
        'claude-sonnet-5',
        { in: 1_000_000, out: 1_000_000, cr: 1_000_000, cw: 1_000_000 },
        '2026-07-31T12:00:00.000Z',
      ),
      14.7,
    )
    assert.strictEqual(
      estimateCopilotUsageCost(
        'gpt-5.6-terra',
        { in: 1_000_000, out: 1_000_000, cr: 0, cw: 0 },
        '2026-07-31T12:00:00.000Z',
      ),
      14,
    )
  })

  it('deduplicates repeated assistant message snapshots by their highest cost', () => {
    const samples = [
      { id: 'msg-1', ts: '2026-07-31T01:00:00.000Z', model: 'claude-opus-5', usd: 0.01 },
      { id: 'msg-1', ts: '2026-07-31T01:00:01.000Z', model: 'claude-opus-5', usd: 0.03 },
      { id: 'msg-2', ts: '2026-07-31T01:00:02.000Z', model: 'future', usd: null },
      { ts: '2026-07-31T01:00:03.000Z', model: 'claude-opus-5', usd: 0.02 },
    ]

    assert.deepStrictEqual(dedupeCostSamples(samples), [samples[3], samples[1], samples[2]])
    assert.deepStrictEqual(estimateCosts(samples), {
      usd: 0.05,
      pricedRequests: 2,
      unpricedRequests: 1,
      estimated: true,
    })
  })

  it('summarizes UTC today and the last seven calendar days', () => {
    const sample = (ts: string, model = 'claude-sonnet-4-6') => claudeCostSample({
      ts,
      model,
      effort: '',
      usage: { in: 1_000_000, out: 0, cr: 0, cw: 0 },
      stopReason: null,
    })
    const result = summarizeCosts([
      sample('2026-07-31T01:00:00.000Z'),
      sample('2026-07-25T23:00:00.000Z'),
      sample('2026-07-24T23:00:00.000Z'),
      sample('2026-07-31T02:00:00.000Z', 'claude-future-unknown'),
    ], Date.parse('2026-07-31T12:00:00.000Z'), 168, DateTime.zoneMakeOffset(0))

    assert.strictEqual(result.todayUsd, 3)
    assert.strictEqual(result.last7DaysUsd, 6)
    assert.strictEqual(result.usd, 9)
    assert.strictEqual(result.pricedRequests, 3)
    assert.strictEqual(result.unpricedRequests, 1)
  })

  it('marks a seven-day total unavailable when the scan covers less time', () => {
    const result = summarizeCosts(
      [],
      Date.parse('2026-07-31T12:00:00.000Z'),
      24,
      DateTime.zoneMakeOffset(0),
    )
    assert.strictEqual(result.last7DaysUsd, null)
  })

  it('builds a model and harness overview without inventing plan-billed prices', () => {
    const claude = claudeCostSample({
      ts: '2026-07-31T10:00:00.000Z',
      model: 'claude-sonnet-4-6',
      effort: '',
      usage: { in: 1_000_000, out: 0, cr: 0, cw: 0 },
      stopReason: null,
    }, 'claude-session')
    const codex = providerCostSample('codex', 'codex-session', {
      ts: '2026-07-31T11:00:00.000Z',
      model: 'gpt-5-codex',
      usage: { in: 2_000, out: 500, cr: 1_000, cw: 0 },
    })
    const result = buildCostOverview([
      claude,
      codex,
      providerCostSample('copilot', 'empty-session', {
        ts: '2026-07-31T11:30:00.000Z',
        model: 'unknown',
        usage: { in: 0, out: 0, cr: 0, cw: 0 },
      }),
    ], [
      { source: 'claude', state: 'ready', sessions: 1, malformed: 0, message: '' },
      { source: 'codex', state: 'ready', sessions: 1, malformed: 0, message: '' },
      { source: 'copilot', state: 'ready', sessions: 1, malformed: 0, message: '' },
    ], Date.parse('2026-07-31T12:00:00.000Z'), 24)

    assert.strictEqual(result.estimatedUsd, 3)
    assert.strictEqual(result.sessions, 3)
    assert.deepStrictEqual(result.usage, { in: 1_002_000, out: 500, cr: 1_000, cw: 0 })
    assert.deepStrictEqual(result.harnesses.map(group => ({
      source: group.source,
      sessions: group.sessions,
      estimatedUsd: group.estimatedUsd,
      unpricedRequests: group.unpricedRequests,
    })), [
      { source: 'claude', sessions: 1, estimatedUsd: 3, unpricedRequests: 0 },
      { source: 'codex', sessions: 1, estimatedUsd: null, unpricedRequests: 1 },
      { source: 'copilot', sessions: 1, estimatedUsd: null, unpricedRequests: 0 },
    ])
    assert.deepStrictEqual(result.models.map(model => [model.source, model.label]), [
      ['claude', 'claude-sonnet-4-6'],
      ['codex', 'gpt-5-codex'],
      ['copilot', 'unknown'],
    ])
  })
})
