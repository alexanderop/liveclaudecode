import type { DiagnosticIncident, RunNode } from '#shared/types/run'

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
  node: RunNode | null | undefined,
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

export function lastActivityTime(node: RunNode): number | null {
  const value = node.current?.ts || node.lastTs || node.firstTs
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}
