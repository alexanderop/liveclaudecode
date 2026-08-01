import { assert, describe, it } from '@effect/vitest'
import type { CostOverviewGroup } from '#shared/types/run'
import {
  MODEL_PALETTE,
  modelColor,
  modelMetric,
  pricingLabel,
  serializeCostCsv,
  seriesKey,
  sparkline,
  usageTotal,
} from '~/utils/cost-view'

function costGroup(overrides: Partial<CostOverviewGroup> = {}): CostOverviewGroup {
  return {
    source: 'claude',
    label: 'Claude Sonnet 5',
    model: 'claude-sonnet-5',
    sessions: 3,
    usage: { in: 100, out: 40, cr: 800, cw: 60 },
    estimatedUsd: 1.25,
    pricedRequests: 12,
    unpricedRequests: 0,
    days: [
      { date: '2026-07-24', usage: { in: 60, out: 20, cr: 500, cw: 30 }, estimatedUsd: 0.75 },
      { date: '2026-07-25', usage: { in: 40, out: 20, cr: 300, cw: 30 }, estimatedUsd: 0.5 },
    ],
    ...overrides,
  }
}

describe('cost view helpers', () => {
  it('totals recorded usage across all token kinds', () => {
    assert.strictEqual(usageTotal({ in: 1, out: 2, cr: 3, cw: 4 }), 10)
    assert.strictEqual(usageTotal(undefined), 0)
  })

  it('derives a stable slug series key per source and label', () => {
    assert.strictEqual(seriesKey(costGroup()), 'claude-claude-sonnet-5')
    assert.strictEqual(
      seriesKey(costGroup({ source: 'codex', label: 'GPT 6 (high)' })),
      'codex-gpt-6-high-',
    )
  })

  it('rotates palette shades by the model position within its source', () => {
    const first = costGroup()
    const second = costGroup({ label: 'Claude Haiku' })
    const other = costGroup({ source: 'codex', label: 'GPT 6' })
    const visible = [first, other, second]

    assert.strictEqual(modelColor(first, visible), MODEL_PALETTE.claude[0])
    assert.strictEqual(modelColor(second, visible), MODEL_PALETTE.claude[1])
    assert.strictEqual(modelColor(other, visible), MODEL_PALETTE.codex[0])
    // Unknown model falls back to the caller-provided index.
    assert.strictEqual(modelColor(costGroup({ label: 'Ghost' }), [], 2), MODEL_PALETTE.claude[2])
  })

  it('compares models by cost only when the model was actually priced', () => {
    assert.strictEqual(modelMetric(costGroup(), true), 1.25)
    assert.strictEqual(modelMetric(costGroup({ pricedRequests: 0 }), true), 1_000)
    assert.strictEqual(modelMetric(costGroup(), false), 1_000)
  })

  it('labels the pricing basis per source and unpriced groups', () => {
    assert.strictEqual(pricingLabel(costGroup()), 'Claude API estimate')
    assert.strictEqual(pricingLabel(costGroup({ source: 'codex' })), 'OpenAI API equivalent')
    assert.strictEqual(pricingLabel(costGroup({ source: 'copilot' })), 'GitHub AI Credits')
    assert.strictEqual(pricingLabel(costGroup({ estimatedUsd: null })), 'Rate unavailable')
  })

  it('builds sparklines from daily cost, or token totals when unpriced', () => {
    assert.deepStrictEqual(sparkline(costGroup()), [0.75, 0.5])
    assert.deepStrictEqual(sparkline(costGroup({ estimatedUsd: null })), [610, 390])
  })
})

describe('serializeCostCsv', () => {
  it('serializes one quoted row per model with a header', () => {
    const csv = serializeCostCsv([costGroup()])

    assert.deepStrictEqual(csv.split('\n'), [
      '"Harness","Model","Estimated USD","Pricing","Sessions","Input","Output","Cache read","Cache write"',
      '"Claude","Claude Sonnet 5","1.25","Claude API estimate","3","100","40","800","60"',
    ])
  })

  it('escapes embedded quotes and preserves commas inside quoted values', () => {
    const csv = serializeCostCsv([
      costGroup({ label: 'Claude "Sonnet", tuned', estimatedUsd: null, pricedRequests: 0 }),
    ])

    assert.strictEqual(
      csv.split('\n')[1],
      '"Claude","Claude ""Sonnet"", tuned","","Rate unavailable","3","100","40","800","60"',
    )
  })
})
