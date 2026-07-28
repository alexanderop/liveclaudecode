import { mountSuspended } from '@nuxt/test-utils/runtime'
import { describe, expect, it } from 'vitest'
import RunDiagnostics from '~/components/RunDiagnostics.vue'
import type { RunResponse } from '#shared/types/run'

const run = {
  diagnostics: {
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
    compactions: [],
    outcomes: [],
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
    environment: {
      cwd: '/repo',
      gitBranch: 'feature',
      version: '2.1.220',
      entrypoint: 'cli',
      permissionMode: 'default',
    },
    causal: { records: 20, recordsWithUuid: 18, branchPoints: 2, sidechainRecords: 14, interruptions: 0 },
    usage: { in: 10, out: 20, cr: 100, cw: 30 },
  },
} as unknown as RunResponse

describe('RunDiagnostics', () => {
  it('shows native incidents and timing and can select their agent', async () => {
    const component = await mountSuspended(RunDiagnostics, {
      props: { run, selectedKey: null },
    })

    expect(component.text()).toContain('Claude API rate_limit')
    expect(component.text()).toContain('1m5s')
    expect(component.text()).toContain('claude-sonnet-5')

    await component.get('.incident-row').trigger('click')
    expect(component.emitted('select')).toContainEqual(['session/worker'])

    await component.setProps({ selectedKey: 'session/worker' })
    expect(component.get('.incident-row').attributes('aria-current')).toBe('true')
    expect(component.get('.turn-row').attributes('aria-current')).toBe('true')
    expect(component.get('.context-row').attributes('aria-current')).toBe('true')
  })
})
