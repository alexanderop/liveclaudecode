export type PrimaryWorkspaceKind =
  | 'overview'
  | 'map'
  | 'activity'
  | 'changes'
  | 'diagnostics'

export type ContextPanelState =
  | { kind: 'closed' }
  | { kind: 'agent-details', agentKey: string, origin: PrimaryWorkspaceKind }
  | { kind: 'ask', sessionId: string }

export type LauncherState =
  | { kind: 'closed' }
  | { kind: 'compact' }
  | {
      kind: 'expanded'
      previousWorkspace: PrimaryWorkspaceKind
      suspendedContext: ContextPanelState
    }

export type InvestigationFocus = {
  agentKey?: string
  eventLine?: number
  timestamp?: number
  filePath?: string
  incidentId?: string
}

export type WorkspaceState = {
  primary: PrimaryWorkspaceKind
  context: ContextPanelState
  launcher: LauncherState
  investigation: InvestigationFocus
}

export function initialWorkspaceState(): WorkspaceState {
  return {
    primary: 'overview',
    context: { kind: 'closed' },
    launcher: { kind: 'closed' },
    investigation: {},
  }
}

export function openPrimary(
  state: WorkspaceState,
  primary: PrimaryWorkspaceKind,
): WorkspaceState {
  return {
    ...state,
    primary,
    context: state.context.kind === 'agent-details' ? { kind: 'closed' } : state.context,
    launcher: { kind: 'closed' },
  }
}

export function openAsk(state: WorkspaceState, sessionId: string): WorkspaceState {
  return {
    ...state,
    context: { kind: 'ask', sessionId },
    launcher: { kind: 'closed' },
  }
}

export function openAgentDetails(
  state: WorkspaceState,
  agentKey: string,
): WorkspaceState {
  return {
    ...state,
    context: { kind: 'agent-details', agentKey, origin: state.primary },
    launcher: { kind: 'closed' },
    investigation: { ...state.investigation, agentKey },
  }
}

export function openCompactLauncher(state: WorkspaceState): WorkspaceState {
  return { ...state, launcher: { kind: 'compact' } }
}

export function expandLauncher(state: WorkspaceState): WorkspaceState {
  return {
    ...state,
    launcher: {
      kind: 'expanded',
      previousWorkspace: state.primary,
      suspendedContext: state.context,
    },
  }
}

export function cancelExpandedLauncher(state: WorkspaceState): WorkspaceState {
  if (state.launcher.kind !== 'expanded') return state
  return {
    ...state,
    primary: state.launcher.previousWorkspace,
    context: state.launcher.suspendedContext,
    launcher: { kind: 'closed' },
  }
}

export function closeContext(state: WorkspaceState): WorkspaceState {
  return {
    ...state,
    context: { kind: 'closed' },
    investigation: state.context.kind === 'agent-details'
      ? { ...state.investigation, agentKey: undefined }
      : state.investigation,
  }
}

export function focusIncident(
  state: WorkspaceState,
  incidentId: string | undefined,
): WorkspaceState {
  return { ...state, investigation: { ...state.investigation, incidentId } }
}

export function focusFile(
  state: WorkspaceState,
  filePath: string | undefined,
): WorkspaceState {
  return { ...state, investigation: { ...state.investigation, filePath } }
}

export function switchSelectedSession(state: WorkspaceState): WorkspaceState {
  return {
    ...state,
    context: { kind: 'closed' },
    launcher: { kind: 'closed' },
    investigation: {},
  }
}
