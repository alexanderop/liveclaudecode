import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import CostsPage from '~/pages/costs.vue'
import { costOverviewGroup, costOverviewResponse, runNode } from '../fixtures/runs'
import { mockLiveApi } from '../fixtures/live-api'

let component: VueWrapper | null = null

afterEach(() => {
  component?.unmount()
  component = null
})

const stubs = { UTooltip: { template: '<slot />' } }

const claude = costOverviewGroup({
  source: 'claude',
  label: 'Claude Code',
  model: null,
  sessions: 4,
  estimatedUsd: 2,
  usage: { in: 2_000, out: 500, cr: 6_000, cw: 100 },
})
const codex = costOverviewGroup({
  source: 'codex',
  label: 'Codex',
  model: null,
  sessions: 1,
  estimatedUsd: null,
  pricedRequests: 0,
  unpricedRequests: 5,
  usage: { in: 1_000, out: 100, cr: 0, cw: 0 },
})
const opus = costOverviewGroup({
  source: 'claude',
  label: 'claude-opus-5',
  sessions: 4,
  estimatedUsd: 2,
})
const codexModel = costOverviewGroup({
  source: 'codex',
  label: 'gpt-5-codex',
  sessions: 1,
  estimatedUsd: null,
  pricedRequests: 0,
  unpricedRequests: 5,
})

const mountCosts = async (route?: string) => {
  const wrapper = component = await mountSuspended(CostsPage, { global: { stubs }, route })
  await flushPromises()
  return wrapper
}

describe('costs page', () => {
  it('summarises spend, harnesses, and every recorded model', async () => {
    mockLiveApi(runNode(), {
      costs: () => costOverviewResponse({
        estimatedUsd: 2,
        sessions: 5,
        usage: { in: 3_000, out: 600, cr: 6_000, cw: 100 },
        harnesses: [claude, codex],
        models: [opus, codexModel],
      }),
    })
    const wrapper = await mountCosts()

    assertSummary(wrapper)
    // Cache read share is cr / (in + cr): 6000 / 9000.
    expect(wrapper.get('.summary-grid').text()).toContain('66.7%')

    const cards = wrapper.findAll('.harness-card')
    expect(cards).toHaveLength(2)
    expect(cards[0]!.text()).toContain('Claude Code')
    // A harness with no priced request cannot claim an estimate.
    expect(cards[1]!.text()).toContain('UNPRICED')
    expect(cards[1]!.text()).toContain('Rate unavailable')

    expect(wrapper.findAll('.contributors li')).toHaveLength(2)
    expect(wrapper.findAll('.efficiency-section tbody tr')).toHaveLength(2)
  })

  it('filters models to the harness the user selects, and back again', async () => {
    mockLiveApi(runNode(), {
      costs: () => costOverviewResponse({
        harnesses: [claude, codex],
        models: [opus, codexModel],
      }),
    })
    const wrapper = await mountCosts()

    await wrapper.findAll('.harness-card')[1]!.trigger('click')
    expect(wrapper.findAll('.contributors li')).toHaveLength(1)
    expect(wrapper.get('.contributors').text()).toContain('gpt-5-codex')
    expect(wrapper.get('.filter-state').text()).toContain('Codex')
    expect(wrapper.findAll('.harness-card')[1]!.attributes('aria-pressed')).toBe('true')

    // Clicking the selected harness again clears the filter.
    await wrapper.findAll('.harness-card')[1]!.trigger('click')
    expect(wrapper.findAll('.contributors li')).toHaveLength(2)
    expect(wrapper.get('.filter-state').text()).toContain('All harnesses')
  })

  it('takes its range from the route query, defaulting to 30 days', async () => {
    const fetch = mockLiveApi(runNode(), { costs: () => costOverviewResponse() })
    const requestedHours = () => fetch.mock.calls
      .filter(([url]) => String(url).startsWith('/api/costs'))
      .map(([, options]) => options?.query?.hours)

    await mountCosts()
    expect(requestedHours()).toEqual([720])
  })

  it.each([['24', 24], ['0', 0], ['nonsense', 720], ['13', 720]])(
    'requests %s hours from the route as %i',
    async (query, expected) => {
      const fetch = mockLiveApi(runNode(), { costs: () => costOverviewResponse() })
      await mountCosts(`/costs?hours=${query}`)

      const call = fetch.mock.calls.find(([url]) => String(url).startsWith('/api/costs'))
      expect(call?.[1]?.query?.hours).toBe(expected)
    },
  )

  it('names the sources whose transcripts were only partly readable', async () => {
    mockLiveApi(runNode(), {
      costs: () => costOverviewResponse({
        sources: [
          { source: 'claude', state: 'ready', sessions: 4, malformed: 0, message: '' },
          { source: 'codex', state: 'degraded', sessions: 1, malformed: 3, message: '3 unreadable files' },
        ],
      }),
    })
    const wrapper = await mountCosts()

    const alert = wrapper.get('.state-alert')
    expect(alert.text()).toContain('Some transcript data was skipped')
    expect(alert.text()).toContain('3 unreadable files')
    // A ready source is not something to warn about.
    expect(alert.text()).not.toContain('Claude')
  })

  it('offers nothing to export and says so when the range holds no models', async () => {
    mockLiveApi(runNode(), {
      costs: () => costOverviewResponse({
        estimatedUsd: 0,
        pricedRequests: 0,
        sessions: 0,
        usage: { in: 0, out: 0, cr: 0, cw: 0 },
        harnesses: [],
        models: [],
      }),
    })
    const wrapper = await mountCosts()

    expect(wrapper.get('.empty-models').text()).toContain('No model usage in this range')
    expect(wrapper.findAll('.harness-card')).toHaveLength(0)
    expect(wrapper.get('.summary-grid').text()).toContain('0.0%')
    const exportButton = wrapper.findAll('button').find(button => button.text().includes('Export CSV'))
    expect(exportButton?.attributes('disabled')).toBeDefined()
  })
})

function assertSummary(wrapper: VueWrapper): void {
  const summary = wrapper.get('.summary-grid').text()
  expect(summary).toContain('$2.00')
  expect(summary).toContain('12 priced usage records')
  expect(summary).toContain('5')
}
