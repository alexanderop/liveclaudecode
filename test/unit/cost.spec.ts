import { DateTime } from 'effect'
import { assert, describe, it } from '@effect/vitest'
import {
  claudeCostSample,
  estimateClaudeUsageCost,
  summarizeCosts,
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

  it('leaves unknown models unpriced instead of inventing a rate', () => {
    assert.strictEqual(
      estimateClaudeUsageCost('claude-future-unknown', { in: 10, out: 5, cr: 0, cw: 0 }, null),
      null,
    )
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
})
