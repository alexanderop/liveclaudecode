import type { DiagnosticIncidentWire, RunNodeWire, TranscriptEventWire } from '#shared/schemas/api'

export interface ActivityBaseOptions {
  /** The session-wide merge, when the server has answered with one. */
  sessionEvents: readonly TranscriptEventWire[]
  /** The selected agent's own transcript, used when the merge is empty. */
  agentEvents: readonly TranscriptEventWire[]
  /** Session root, which is who the fallback events are attributed to. */
  root: Pick<RunNodeWire, 'key' | 'label' | 'agentType'> | null
}

/**
 * What the activity view shows before incidents are merged in.
 *
 * The session-wide feed when there is one, and otherwise the selected agent's
 * transcript wearing the session root's identity — because those events arrive
 * from `/api/events`, which does not attribute them to an agent, and the
 * activity view groups by agent. The fallback matters on the first paint of a
 * session and whenever the merged feed is still empty.
 */
export function activityBase(options: ActivityBaseOptions): readonly TranscriptEventWire[] {
  const { sessionEvents, agentEvents, root } = options
  if (sessionEvents.length) return sessionEvents
  return agentEvents.map(event => ({
    ...event,
    agentKey: root?.key,
    agentLabel: root?.label,
    agentType: root?.agentType || 'Main session',
    agentDepth: 0,
  }))
}

export interface MergeActivityEventsOptions {
  /** Session-wide transcript events already attributed to their agents. */
  base: readonly TranscriptEventWire[]
  /** Diagnostic incidents to synthesize into system events. */
  incidents: readonly DiagnosticIncidentWire[]
  /** Flattened session agents, used to label synthesized incident events. */
  agents: readonly Pick<RunNodeWire, 'key' | 'label' | 'agentType'>[]
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
export function mergeActivityEvents(options: MergeActivityEventsOptions): TranscriptEventWire[] {
  const { base, incidents, agents, agentKey = 'all' } = options
  const agentByKey = new Map(agents.map(agent => [agent.key, agent]))
  const eventKeys = new Set(
    base.filter(event => event.error).map(event => `${event.agentKey || ''}:${event.line}`),
  )
  const incidentEvents: TranscriptEventWire[] = incidents
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
