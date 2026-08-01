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
})
