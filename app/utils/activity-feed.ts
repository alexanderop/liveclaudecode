import type { DiagnosticIncident, RunNode, TranscriptEvent } from '#shared/types/run'

export interface MergeActivityEventsOptions {
  /** Session-wide transcript events already attributed to their agents. */
  base: readonly TranscriptEvent[]
  /** Diagnostic incidents to synthesize into system events. */
  incidents: readonly DiagnosticIncident[]
  /** Flattened session agents, used to label synthesized incident events. */
  agents: readonly Pick<RunNode, 'key' | 'label' | 'agentType'>[]
  /**
   * Agent key to filter the merged feed down to, or `'all'` for the whole
   * session.
   *
   * @default 'all'
   */
  agentKey?: string
}

/**
 * Merges the session's transcript events with warning/error incidents that
 * have no matching error event (deduplicated by `agentKey:line`), filters by
 * agent, and sorts chronologically with the line number as tiebreaker.
 */
export function mergeActivityEvents(options: MergeActivityEventsOptions): TranscriptEvent[] {
  const { base, incidents, agents, agentKey = 'all' } = options
  const agentByKey = new Map(agents.map(agent => [agent.key, agent]))
  const eventKeys = new Set(
    base.filter(event => event.error).map(event => `${event.agentKey || ''}:${event.line}`),
  )
  const incidentEvents: TranscriptEvent[] = incidents
    .filter(incident => incident.severity !== 'info' && !eventKeys.has(`${incident.key || ''}:${incident.line}`))
    .map(incident => ({
      role: 'system',
      kind: 'system',
      ts: incident.ts,
      line: incident.line,
      body: incident.detail,
      summary: incident.title,
      tool: incident.tool,
      error: incident.severity === 'error',
      agentKey: incident.key,
      agentLabel: (incident.key && agentByKey.get(incident.key)?.label) || incident.who || 'Session',
      agentType: (incident.key && agentByKey.get(incident.key)?.agentType) || 'Diagnostic incident',
    }))
  return [...base, ...incidentEvents]
    .filter(event => agentKey === 'all' || event.agentKey === agentKey)
    .sort((left, right) => (left.ts || '').localeCompare(right.ts || '') || left.line - right.line)
}
