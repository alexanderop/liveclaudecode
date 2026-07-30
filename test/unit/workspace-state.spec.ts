import { describe, expect, it } from 'vitest'
import {
  cancelExpandedLauncher,
  expandLauncher,
  initialWorkspaceState,
  openAgentDetails,
  openAsk,
  openPrimary,
  switchSelectedSession,
} from '~/utils/workspace-state'

describe('progressive disclosure workspace state', () => {
  it('opens Overview with no temporary or contextual layer', () => {
    expect(initialWorkspaceState()).toEqual({
      primary: 'overview',
      context: { kind: 'closed' },
      launcher: { kind: 'closed' },
      investigation: {},
    })
  })

  it('keeps Ask beside a primary destination but closes agent details', () => {
    const withAsk = openAsk(initialWorkspaceState(), '/repo/session')
    expect(openPrimary(withAsk, 'activity').context).toEqual(withAsk.context)

    const withAgent = openAgentDetails(withAsk, 'session/worker')
    expect(openPrimary(withAgent, 'diagnostics').context).toEqual({ kind: 'closed' })
  })

  it('suspends eligible context while expanded and restores it on cancel', () => {
    const original = openAgentDetails(
      openPrimary(initialWorkspaceState(), 'map'),
      'session/worker',
    )
    const expanded = expandLauncher(original)

    expect(expanded.launcher).toMatchObject({
      kind: 'expanded',
      previousWorkspace: 'map',
      suspendedContext: original.context,
    })
    expect(cancelExpandedLauncher(expanded)).toEqual({
      ...original,
      launcher: { kind: 'closed' },
    })
  })

  it('preserves an explicit primary workspace across a session switch', () => {
    const previous = openAgentDetails(
      openPrimary(initialWorkspaceState(), 'changes'),
      'session/worker',
    )

    expect(switchSelectedSession(previous)).toMatchObject({
      primary: 'changes',
      context: { kind: 'closed' },
      launcher: { kind: 'closed' },
      investigation: {},
    })
  })
})
