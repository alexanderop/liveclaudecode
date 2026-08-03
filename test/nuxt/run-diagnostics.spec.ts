import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import RunDiagnostics from '~/components/RunDiagnostics.vue'
import { runDiagnostics, runResponse } from '../fixtures/runs'

let component: VueWrapper | null = null

afterEach(() => {
  component?.unmount()
  component = null
})

const run = runResponse({
  diagnostics: runDiagnostics({
    incidents: [{
      id: '1:api',
      severity: 'error',
      category: 'api',
      title: 'Claude API rate_limit',
      detail: 'HTTP 429',
      ts: '2026-07-25T18:00:02.000Z',
      line: 1,
      who: 'worker',
      key: 'session/worker',
    }],
    turns: [{
      ts: '2026-07-25T18:00:03.000Z',
      durationMs: 65_000,
      messageCount: 4,
      pendingAgents: 1,
      pendingWorkflows: 0,
      who: 'worker',
      key: 'session/worker',
    }],
    changes: [],
    git: [],
    agents: [{
      key: 'session/worker',
      label: 'worker',
      agentType: 'implementation-worker',
      models: ['claude-sonnet-5'],
      efforts: ['high'],
      usage: { in: 10, out: 20, cr: 100, cw: 30 },
      turns: 1,
      turnDurationMs: 65_000,
      compactions: 0,
      branchPoints: 2,
      sidechainRecords: 14,
    }],
    causal: { records: 20, recordsWithUuid: 18, branchPoints: 2, sidechainRecords: 14, interruptions: 0 },
    usage: { in: 10, out: 20, cr: 100, cw: 30 },
  }),
})

describe('RunDiagnostics', () => {
  it('shows native incidents and timing and can select their agent', async () => {
    const wrapper = component = await mountSuspended(RunDiagnostics, {
      props: { run, selectedKey: null },
    })

    expect(wrapper.get('.incident-row').text()).toContain('Claude API rate_limit')
    expect(wrapper.get('.turn-row').text()).toContain('1m5s')
    expect(wrapper.get('.context-row').text()).toContain('claude-sonnet-5')

    await wrapper.get('.incident-row').trigger('click')
    expect(wrapper.emitted('select')).toContainEqual(['session/worker'])

    await wrapper.setProps({ selectedKey: 'session/worker' })
    expect(wrapper.get('.incident-row').attributes('aria-current')).toBe('true')
    expect(wrapper.get('.turn-row').attributes('aria-current')).toBe('true')
    expect(wrapper.get('.context-row').attributes('aria-current')).toBe('true')
  })

  it('charts context pressure from the per-request samples', async () => {
    const wrapper = component = await mountSuspended(RunDiagnostics, {
      props: { run, selectedKey: null },
    })

    const section = wrapper.get('.pressure-section')
    expect(section.text()).toContain('2 requests')
    // The fixture's larger prompt is 100 in + 10 cr + 200 cw; of the 550
    // prompt tokens across both requests, 50 came from cache.
    const stats = section.get('.pressure-stats').text()
    expect(stats).toContain('310')
    expect(stats).toContain('9%')
    expect(section.findAll('svg path[fill="none"]')).toHaveLength(3)
  })

  it('charts one agent at a time, since each has its own context window', async () => {
    const scoped = runResponse({
      diagnostics: runDiagnostics({
        agents: [
          {
            key: 'session/worker',
            label: 'worker',
            agentType: 'Explore',
            models: [],
            efforts: [],
            usage: { in: 0, out: 0, cr: 0, cw: 0 },
            turns: 0,
            turnDurationMs: 0,
            compactions: 0,
            branchPoints: 0,
            sidechainRecords: 0,
          },
        ],
        context: [
          {
            ts: '2026-07-25T18:00:00.000Z',
            model: 'm',
            effort: '',
            usage: { in: 900, out: 0, cr: 0, cw: 0 },
            stopReason: null,
            who: 'Main session',
            key: 'session',
          },
          {
            ts: '2026-07-25T18:00:01.000Z',
            model: 'm',
            effort: '',
            usage: { in: 5, out: 0, cr: 0, cw: 0 },
            stopReason: null,
            who: 'worker',
            key: 'session/worker',
          },
          {
            ts: '2026-07-25T18:00:02.000Z',
            model: 'm',
            effort: '',
            usage: { in: 7, out: 0, cr: 0, cw: 0 },
            stopReason: null,
            who: 'worker',
            key: 'session/worker',
          },
        ],
      }),
    })
    const wrapper = component = await mountSuspended(RunDiagnostics, {
      props: { run: scoped, selectedKey: 'session/worker' },
    })

    const section = wrapper.get('.pressure-section')
    expect(section.text()).toContain('for worker')
    expect(section.text()).toContain('2 requests')
    // The main session's far larger prompt must not raise the worker's peak.
    expect(section.get('.pressure-stats').text()).toContain('7')
    expect(section.get('.pressure-stats').text()).not.toContain('900')
  })

  it('omits the chart when a session has too few requests to show a trend', async () => {
    const wrapper = component = await mountSuspended(RunDiagnostics, {
      props: {
        run: runResponse({ diagnostics: runDiagnostics({ context: [] }) }),
        selectedKey: null,
      },
    })

    expect(wrapper.find('.pressure-section').exists()).toBe(false)
  })

  it('reports the session mode alongside the permission mode', async () => {
    const wrapper = component = await mountSuspended(RunDiagnostics, {
      props: { run, selectedKey: null },
    })

    expect(wrapper.get('.environment-list').text()).toContain('normal')
  })
})
