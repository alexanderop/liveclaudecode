import type { DiagnosticIncident } from '#shared/types/run'
import type { RunNodeWire } from '#shared/schemas/api'
import { parseTimestamp } from './format'

export type AgentDisplayState =
  | 'running'
  | 'thinking'
  | 'waiting'
  | 'completed'
  | 'warning'
  | 'failed'
  | 'inactive'

export interface AgentStateSummary {
  state: AgentDisplayState
  label: string
  detail: string
  issueCount: number
}

/** Icon shown next to an agent's display state. */
export function agentStateIcon(state: AgentDisplayState): string {
  return {
    running: 'i-lucide-hammer',
    thinking: 'i-lucide-brain',
    waiting: 'i-lucide-clock-3',
    completed: 'i-lucide-circle-check',
    warning: 'i-lucide-triangle-alert',
    failed: 'i-lucide-circle-x',
    inactive: 'i-lucide-circle-check',
  }[state]
}

export function agentDisplayStateLabel(state: AgentDisplayState): string {
  return {
    running: 'Running',
    thinking: 'Thinking',
    waiting: 'Waiting',
    completed: 'Completed',
    warning: 'Completed with warnings',
    failed: 'Failed',
    inactive: 'Inactive',
  }[state]
}

export function incidentsForAgent(
  key: string,
  incidents: readonly DiagnosticIncident[] = [],
): DiagnosticIncident[] {
  return incidents.filter(incident => incident.key === key && incident.severity !== 'info')
}

export function canonicalIssueCount(
  nodeErrors: number,
  incidents: readonly DiagnosticIncident[] = [],
): number {
  const incidentErrors = incidents.filter(incident => incident.severity === 'error').length
  const warnings = incidents.filter(incident => incident.severity === 'warning').length
  return Math.max(nodeErrors, incidentErrors) + warnings
}

export function agentState(
  node: RunNodeWire | null | undefined,
  incidents: readonly DiagnosticIncident[] = [],
): AgentStateSummary {
  if (!node) return { state: 'inactive', label: 'Inactive', detail: 'No activity recorded', issueCount: 0 }

  const relevant = incidentsForAgent(node.key, incidents)
  const issueCount = canonicalIssueCount(node.errors, relevant)
  const current = node.current?.summary.replace(/\s+/g, ' ').trim()

  if (node.live && node.current) {
    return {
      state: 'running',
      label: 'Running',
      detail: `${node.current.tool}${current ? ` · ${current}` : ''}`,
      issueCount,
    }
  }
  if (node.live) {
    return {
      state: 'thinking',
      label: 'Thinking',
      detail: node.tools ? `Preparing the next action · ${node.tools} tools run` : 'Preparing the next action',
      issueCount,
    }
  }
  if (node.spawnState === 'running') {
    return {
      state: 'waiting',
      label: 'Waiting',
      detail: current || 'Waiting for a child result or parent coordination',
      issueCount,
    }
  }
  if (node.stoppedByUser) {
    return { state: 'failed', label: 'Stopped', detail: 'Stopped by the user', issueCount }
  }
  if (node.finalText) {
    return issueCount
      ? { state: 'warning', label: 'Completed with warnings', detail: `${issueCount} recovered ${issueCount === 1 ? 'issue' : 'issues'}`, issueCount }
      : { state: 'completed', label: 'Completed', detail: 'Returned a final result', issueCount }
  }
  if (issueCount) {
    return { state: 'failed', label: 'Failed', detail: `${issueCount} unrecovered ${issueCount === 1 ? 'issue' : 'issues'}`, issueCount }
  }
  if (!node.firstTs && !node.lastTs && !node.tools) {
    return { state: 'inactive', label: 'Inactive', detail: 'No activity recorded', issueCount }
  }
  return { state: 'completed', label: 'Completed', detail: 'Work ended without a recorded final message', issueCount }
}

export function lastActivityTime(node: RunNodeWire): number | null {
  return parseTimestamp(node.current?.ts || node.lastTs || node.firstTs)
}

export type SessionDisplayKind =
  | 'inactive'
  | 'running'
  | 'stopped'
  | 'failed'
  | 'warning'
  | 'completed'

export interface SessionDisplayState {
  kind: SessionDisplayKind
  icon: string
}

/** The root fields the session status ladder depends on. */
export type SessionDisplayRoot = Pick<
  RunNodeWire,
  'subLive' | 'stoppedByUser' | 'subErrors' | 'finalText' | 'lastTs'
>

export interface SessionDisplayStateOptions {
  /**
   * Diagnostic error incidents recorded for the session; folded into the
   * failed check alongside the root's own error count.
   *
   * @default 0
   */
  errorCount?: number
  /**
   * Warning or error incidents that need review; folded into the warning
   * check alongside the root's own error count.
   *
   * @default 0
   */
  attentionCount?: number
  /**
   * Kind reported for a root that recorded neither a final result nor any
   * activity.
   *
   * @default 'inactive'
   */
  emptyKind?: SessionDisplayKind
}

/**
 * Shared running/stopped/failed/warning/completed ladder for a session root.
 * Components map the returned kind to their own labels and tone classes.
 */
export function sessionDisplayState(
  root: SessionDisplayRoot | null | undefined,
  options: SessionDisplayStateOptions = {},
): SessionDisplayState {
  const { errorCount = 0, attentionCount = 0, emptyKind = 'inactive' } = options
  if (!root) return { kind: 'inactive', icon: 'i-lucide-circle' }
  if (root.subLive) return { kind: 'running', icon: 'i-lucide-radio' }
  if (root.stoppedByUser) return { kind: 'stopped', icon: 'i-lucide-circle-stop' }
  if ((errorCount || root.subErrors) && !root.finalText) {
    return { kind: 'failed', icon: 'i-lucide-circle-x' }
  }
  if (attentionCount || root.subErrors) {
    return { kind: 'warning', icon: 'i-lucide-triangle-alert' }
  }
  if (root.finalText || root.lastTs) return { kind: 'completed', icon: 'i-lucide-circle-check' }
  return emptyKind === 'completed'
    ? { kind: 'completed', icon: 'i-lucide-circle-check' }
    : { kind: emptyKind, icon: 'i-lucide-circle' }
}
