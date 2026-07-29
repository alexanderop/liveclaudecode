import { describe, expect, it } from 'vitest'
import { agentState, canonicalIssueCount } from '../../app/utils/session-state'
import { runNode } from '../fixtures/runs'

describe('agent display state', () => {
  it('treats a returned result with tool errors as completed with warnings', () => {
    const state = agentState(runNode({ errors: 2, finalText: 'Recovered and completed.', live: false }))

    expect(state).toMatchObject({
      state: 'warning',
      label: 'Completed with warnings',
      issueCount: 2,
    })
  })

  it('only calls an ended agent failed when it has no final result', () => {
    expect(agentState(runNode({ errors: 1, finalText: '', live: false })).state).toBe('failed')
  })

  it('does not double count a tool error that also has a diagnostic incident', () => {
    expect(canonicalIssueCount(4, [
      { id: '1', severity: 'error', category: 'tool', title: 'Failed', detail: '', ts: null, line: 1 },
      { id: '2', severity: 'error', category: 'tool', title: 'Failed', detail: '', ts: null, line: 2 },
      { id: '3', severity: 'error', category: 'tool', title: 'Failed', detail: '', ts: null, line: 3 },
      { id: '4', severity: 'error', category: 'tool', title: 'Failed', detail: '', ts: null, line: 4 },
    ])).toBe(4)
  })
})
