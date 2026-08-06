import { flushPromises, type VueWrapper } from '@vue/test-utils'
import { Effect } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'
import { USelect } from '#components'
import type { CostOverviewResponseWire } from '#shared/schemas/api'
import { ApiUnreachable } from '~/api/errors'
import CostsPage from '~/pages/costs.vue'
import { deferred } from '../fixtures/deferred'
import { costOverviewGroup, costOverviewResponse } from '../fixtures/runs'
import { mountWithAtoms, type MountedAtoms } from '../fixtures/mount-atoms'
import { recordedCalls, type StubApiHandlers } from '../fixtures/stub-api'

let mounted: MountedAtoms | null = null

afterEach(() => {
  mounted?.wrapper.unmount()
  // The registry owns the poll loop; unmounting only releases the subscription.
  mounted?.registry.dispose()
  mounted = null
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

/** The usual case: `/api/costs` answers, everything else is a defect. */
const answering = (
  response: Parameters<typeof costOverviewResponse>[0] = {},
): StubApiHandlers => ({ costs: () => Effect.succeed(costOverviewResponse(response)) })

const mountCosts = async (options: {
  readonly api?: StubApiHandlers
  readonly route?: string
} = {}) => {
  mounted = await mountWithAtoms(CostsPage, {
    api: options.api ?? answering(),
    route: options.route,
    global: { stubs },
  })
  await flushPromises()
  return mounted.wrapper
}

/** Every `hours` the page asked `/api/costs` for, oldest request first. */
const requestedHours = () =>
  recordedCalls(mounted!.api.calls.costs).map(query => query.hours)

/**
 * Lets the atom's forked poll fiber run and Vue re-render.
 *
 * One `flushPromises` is not enough for a refresh: the click writes the pulse,
 * the merged stream picks it up on a later scheduler turn, the request runs, and
 * only then does the atom publish.
 */
const settle = async () => {
  for (let round = 0; round < 4; round++) await flushPromises()
}

const clickRefresh = async (wrapper: VueWrapper) => {
  await wrapper.get('[aria-label="Refresh costs"]').trigger('click')
  await settle()
}

/** Succeeds on the first call, fails on every one after it. */
const failsAfterFirst = (): StubApiHandlers => {
  let calls = 0
  return {
    costs: () =>
      ++calls === 1
        ? Effect.succeed(costOverviewResponse({
          sessions: 5,
          sources: [
            { source: 'claude', state: 'ready', sessions: 4, malformed: 0, message: '' },
            { source: 'codex', state: 'degraded', sessions: 1, malformed: 3, message: '3 unreadable files' },
          ],
        }))
        : Effect.fail(new ApiUnreachable({ url: '/api/costs', detail: 'connect refused' })),
  }
}

describe('costs page', () => {
  it('summarises spend, harnesses, and every recorded model', async () => {
    const wrapper = await mountCosts({
      api: answering({
        estimatedUsd: 2,
        sessions: 5,
        usage: { in: 3_000, out: 600, cr: 6_000, cw: 100 },
        harnesses: [claude, codex],
        models: [opus, codexModel],
      }),
    })

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
    const wrapper = await mountCosts({
      api: answering({ harnesses: [claude, codex], models: [opus, codexModel] }),
    })

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
    await mountCosts()
    expect(requestedHours()).toEqual([720])
  })

  it.each([['24', 24], ['0', 0], ['nonsense', 720], ['13', 720]])(
    'requests %s hours from the route as %i',
    async (query, expected) => {
      await mountCosts({ route: `/costs?hours=${query}` })
      // `0` means all time and has to reach the server as a value, not as an
      // omitted parameter that lets the server apply its own default.
      expect(requestedHours()[0]).toBe(expected)
    },
  )

  it('names the sources whose transcripts were only partly readable', async () => {
    const wrapper = await mountCosts({
      api: answering({
        sources: [
          { source: 'claude', state: 'ready', sessions: 4, malformed: 0, message: '' },
          { source: 'codex', state: 'degraded', sessions: 1, malformed: 3, message: '3 unreadable files' },
        ],
      }),
    })

    const alert = wrapper.get('.state-alert')
    expect(alert.text()).toContain('Some transcript data was skipped')
    expect(alert.text()).toContain('3 unreadable files')
    // A ready source is not something to warn about.
    expect(alert.text()).not.toContain('Claude')
  })

  it('offers nothing to export and says so when the range holds no models', async () => {
    const wrapper = await mountCosts({
      api: answering({
        estimatedUsd: 0,
        pricedRequests: 0,
        sessions: 0,
        usage: { in: 0, out: 0, cr: 0, cw: 0 },
        harnesses: [],
        models: [],
      }),
    })

    expect(wrapper.get('.empty-models').text()).toContain('No model usage in this range')
    expect(wrapper.findAll('.harness-card')).toHaveLength(0)
    expect(wrapper.get('.summary-grid').text()).toContain('0.0%')
    const exportButton = wrapper.findAll('button').find(button => button.text().includes('Export CSV'))
    expect(exportButton?.attributes('disabled')).toBeDefined()
  })

  it('shows skeletons until the first response lands', async () => {
    const pending = deferred<CostOverviewResponseWire>()
    mounted = await mountWithAtoms(CostsPage, {
      api: { costs: () => Effect.promise(() => pending.promise) },
      global: { stubs },
    })
    await flushPromises()

    expect(mounted.wrapper.findAll('[aria-label="Loading cost overview"]')).toHaveLength(1)
    expect(mounted.wrapper.findAll('.harness-card')).toHaveLength(0)

    pending.resolve(costOverviewResponse({ harnesses: [claude] }))
    await settle()

    expect(mounted.wrapper.findAll('[aria-label="Loading cost overview"]')).toHaveLength(0)
    expect(mounted.wrapper.findAll('.harness-card')).toHaveLength(1)
  })

  it('keeps the data on screen when a manual refresh cannot reach the server', async () => {
    const wrapper = await mountCosts({ api: failsAfterFirst() })
    expect(wrapper.get('.summary-grid').text()).toContain('5')

    await clickRefresh(wrapper)

    // The regression this pins: `registry.refresh` would rebuild the feed and
    // reset its accumulator, so the click would blank the page into the hard
    // error state. A pulse into the running stream keeps the last good data.
    const alerts = wrapper.findAll('.state-alert')
    expect(alerts[0]!.text()).toContain('Showing the last cost data read')
    expect(alerts[0]!.text()).toContain('/api/costs is unreachable: connect refused')
    expect(wrapper.get('.summary-grid').text()).toContain('5')

    // And the stale banner does not retract what we know about the data itself.
    expect(alerts[1]!.text()).toContain('3 unreadable files')
  })

  it('spins the refresh button until the request it started comes back', async () => {
    const pending = deferred<CostOverviewResponseWire>()
    let calls = 0
    const wrapper = await mountCosts({
      api: {
        costs: () =>
          ++calls === 1
            ? Effect.succeed(costOverviewResponse({}))
            : Effect.promise(() => pending.promise),
      },
    })
    const button = () => wrapper.get('[aria-label="Refresh costs"]')
    expect(button().attributes('disabled')).toBeUndefined()

    await wrapper.get('[aria-label="Refresh costs"]').trigger('click')
    await flushPromises()
    expect(button().find('.animate-spin').exists()).toBe(true)

    pending.resolve(costOverviewResponse({}))
    await settle()
    expect(button().find('.animate-spin').exists()).toBe(false)
  })

  it('follows the range the user picks, not the one it mounted with', async () => {
    const wrapper = await mountCosts({ route: '/costs?hours=720' })
    expect(requestedHours()).toEqual([720])

    await wrapper.findComponent(USelect).setValue(24)
    await settle()

    // A thunk frozen at setup would keep rendering the 30-day feed forever.
    expect(requestedHours()).toEqual([720, 24])
  })

  it('says the server could not be reached, and shows the reason', async () => {
    const wrapper = await mountCosts({
      api: {
        costs: () =>
          Effect.fail(new ApiUnreachable({ url: '/api/costs', detail: 'connect refused' })),
      },
    })

    const alert = wrapper.get('.state-alert')
    expect(alert.text()).toContain('Could not read cost data')
    expect(alert.text()).toContain('/api/costs is unreachable: connect refused')
    // No data ever arrived, so there is nothing to keep on screen and no
    // skeleton pretending a request is still in flight.
    expect(wrapper.findAll('.summary-grid')).toHaveLength(0)
  })
})

function assertSummary(wrapper: VueWrapper): void {
  const summary = wrapper.get('.summary-grid').text()
  expect(summary).toContain('$2.00')
  expect(summary).toContain('12 priced usage records')
  expect(summary).toContain('5')
}
