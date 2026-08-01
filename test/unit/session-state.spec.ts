import { describe, expect, it } from 'vitest'
import {
  agentState,
  agentStateIcon,
  canonicalIssueCount,
  sessionDisplayState,
} from '../../app/utils/session-state'
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

  it('maps every display state to an icon', () => {
    expect(agentStateIcon('running')).toBe('i-lucide-hammer')
    expect(agentStateIcon('waiting')).toBe('i-lucide-clock-3')
    expect(agentStateIcon('failed')).toBe('i-lucide-circle-x')
    expect(agentStateIcon('completed')).toBe('i-lucide-circle-check')
  })
})

describe('session display state', () => {
  it('walks the running, stopped, failed, warning, completed ladder in order', () => {
    expect(sessionDisplayState(null).kind).toBe('inactive')
    expect(sessionDisplayState(runNode({ subLive: true, subErrors: 3 })).kind).toBe('running')
    expect(sessionDisplayState(runNode({ stoppedByUser: true, subErrors: 1 })).kind).toBe('stopped')
    expect(sessionDisplayState(runNode({ subErrors: 1, finalText: '' })))
      .toEqual({ kind: 'failed', icon: 'i-lucide-circle-x' })
    expect(sessionDisplayState(runNode({ subErrors: 1 })).kind).toBe('warning')
    expect(sessionDisplayState(runNode({ subErrors: 0 })).kind).toBe('completed')
  })

  it('folds diagnostic incident counts into the failed and warning checks', () => {
    expect(sessionDisplayState(runNode({ subErrors: 0, finalText: '' }), { errorCount: 1 }).kind)
      .toBe('failed')
    expect(sessionDisplayState(runNode({ subErrors: 0 }), { attentionCount: 2 }).kind)
      .toBe('warning')
  })

  it('reports a root without any recorded outcome using the configured empty kind', () => {
    const empty = runNode({ subErrors: 0, finalText: '', lastTs: null })

    expect(sessionDisplayState(empty).kind).toBe('inactive')
    expect(sessionDisplayState(empty, { emptyKind: 'completed' }).kind).toBe('completed')
  })
})
