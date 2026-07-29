import { MarkerType, type Edge, type Node, type XYPosition } from '@vue-flow/core'
import type {
  DiagnosticIncident,
  RunDiagnostics,
  RunNode,
  TimelineLane,
} from '#shared/types/run'
import { normalizeSessionLabel } from '#shared/utils/session-label'
import type { CoordinationAnalysis } from '~/utils/execution-analysis'
import { flattenRunTree } from '~/utils/execution-analysis'

export type ExecutionNodeState = 'active' | 'blocked' | 'completed' | 'failed' | 'inactive'
export type ExecutionDirection = 'left-to-right' | 'top-to-bottom'
export type ExecutionDetail = 'overview' | 'all-agents'
export type ExecutionLens = 'all' | 'active' | 'problems' | 'files' | 'coordination'
export const DEFAULT_EXECUTION_DETAIL: ExecutionDetail = 'all-agents'

export interface ExecutionNodeData {
  label: string
  agentType: string
  tools: number
  files: number
  tokens: number
  firstTs: TimelineLane['firstTs']
  lastTs: TimelineLane['lastTs']
  depth: number
  root: boolean
  state: ExecutionNodeState
  overview: boolean
  agents: number
  errors: number
  incidents: number
  changes: number
  workstream: number
  memberKeys: string[]
  summary: string
  currentTool: string
  idleMs: number
  pendingChildren: number
  collapsed: boolean
  collapsible: boolean
  muted: boolean
  onPath: boolean
  collision: boolean
  critical: boolean
  bottleneck: boolean
  focusedFile: boolean
}

export interface ExecutionEdgeData {
  durationMs: number
  relation: 'spawned' | 'running' | 'waiting' | 'returned' | 'interrupted'
  onPath: boolean
}

export interface ExecutionGraph {
  nodes: Array<Node<ExecutionNodeData>>
  edges: Array<Edge<ExecutionEdgeData>>
}

export interface ExecutionGraphContext {
  root?: RunNode | null
  diagnostics?: RunDiagnostics | null
  lens?: ExecutionLens
  asOf?: number | null
  now?: number
  query?: string
  selectedKey?: string | null
  focusedFile?: string | null
  collapsedKeys?: ReadonlySet<string>
  coordination?: CoordinationAnalysis | null
}

interface LayoutEntry {
  lane: TimelineLane
  children: LayoutEntry[]
  parent: LayoutEntry | null
  y: number
}

interface AggregateStats {
  agents: number
  blocked: boolean
  completed: boolean
  errors: number
  incidents: number
  changes: number
  files: number
  firstTs: TimelineLane['firstTs']
  lastTs: TimelineLane['lastTs']
  live: boolean
  memberKeys: string[]
  tools: number
  tokens: number
}

const HORIZONTAL_GAP = 300
const VERTICAL_GAP = 136
const TOP_DOWN_LEVEL_GAP = 180
const TOP_DOWN_BRANCH_GAP = 270

function time(value: string | null): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function duration(first: string | null, last: string | null, end: number): number {
  const start = time(first)
  if (start === null) return 0
  return Math.max(0, (time(last) ?? end) - start)
}

function relevantIncidents(
  key: string,
  incidents: DiagnosticIncident[],
  asOf: number | null,
): DiagnosticIncident[] {
  return incidents.filter(incident => incident.key === key
    && (asOf === null || time(incident.ts) === null || time(incident.ts)! <= asOf))
}

function stateFor(
  lane: TimelineLane,
  incidents: DiagnosticIncident[] = [],
  asOf: number | null = null,
): ExecutionNodeState {
  const laneIncidents = relevantIncidents(lane.key, incidents, asOf)
  if (asOf !== null) {
    const start = time(lane.firstTs)
    const end = time(lane.lastTs)
    if (start !== null && start > asOf) return 'inactive'
    if (start !== null && (end === null || end > asOf)) return 'active'
    if (laneIncidents.some(incident => incident.severity === 'error')) return 'failed'
    if (start !== null || lane.tools) return 'completed'
    return 'inactive'
  }
  if (lane.live) return 'active'
  if (lane.spawnState === 'running') return 'blocked'
  if (lane.errors || laneIncidents.some(incident => incident.severity === 'error')) return 'failed'
  if (!lane.firstTs && !lane.lastTs && !lane.tools) return 'inactive'
  return 'completed'
}

export function executionStateLabel(state: ExecutionNodeState): string {
  return {
    active: 'Active',
    blocked: 'Blocked',
    completed: 'Completed',
    failed: 'Failed',
    inactive: 'Inactive',
  }[state]
}

function buildTree(lanes: TimelineLane[]): LayoutEntry[] {
  const roots: LayoutEntry[] = []
  const stack: LayoutEntry[] = []
  for (const lane of lanes) {
    const parent = lane.depth > 0 ? stack[lane.depth - 1] || null : null
    const entry: LayoutEntry = { lane, children: [], parent, y: 0 }
    if (parent) parent.children.push(entry)
    else roots.push(entry)
    stack[lane.depth] = entry
    stack.length = lane.depth + 1
  }
  return roots
}

function descendants(entry: LayoutEntry): LayoutEntry[] {
  const entries: LayoutEntry[] = []
  const visit = (current: LayoutEntry): void => {
    entries.push(current)
    current.children.forEach(visit)
  }
  visit(entry)
  return entries
}

function aggregate(
  entry: LayoutEntry,
  context: ExecutionGraphContext,
  nodeByKey: ReadonlyMap<string, RunNode>,
): AggregateStats {
  const entries = descendants(entry)
  const incidents = context.diagnostics?.incidents || []
  const changes = context.diagnostics?.changes || []
  const starts = entries.map(item => item.lane.firstTs).filter(value => value !== null).sort()
  const ends = entries.map(item => item.lane.lastTs).filter(value => value !== null).sort()
  const states = entries.map(item => stateFor(item.lane, incidents, context.asOf ?? null))
  return {
    agents: entries.length,
    blocked: states.includes('blocked'),
    completed: states.includes('completed'),
    errors: entries.reduce((total, item) => total + item.lane.errors
      + relevantIncidents(item.lane.key, incidents, context.asOf ?? null)
        .filter(incident => incident.severity === 'error').length, 0),
    incidents: entries.reduce((total, item) => total + relevantIncidents(item.lane.key, incidents, context.asOf ?? null).length, 0),
    changes: changes.filter(change => change.key && entries.some(item => item.lane.key === change.key)
      && (context.asOf == null || time(change.ts) === null || time(change.ts)! <= context.asOf)).length,
    files: entries.reduce((total, item) => total + item.lane.files, 0),
    firstTs: starts[0] || null,
    lastTs: ends.at(-1) || null,
    live: states.includes('active'),
    memberKeys: entries.map(item => item.lane.key),
    tools: entries.reduce((total, item) => total + item.lane.tools, 0),
    tokens: entries.reduce((total, item) => total + (nodeByKey.get(item.lane.key)?.tokensOut || 0), 0),
  }
}

function aggregateState(stats: AggregateStats): ExecutionNodeState {
  if (stats.live) return 'active'
  if (stats.blocked) return 'blocked'
  if (stats.errors) return 'failed'
  if (stats.completed) return 'completed'
  return 'inactive'
}

function edgeColor(state: ExecutionNodeState): string {
  if (state === 'active') return '#73c995'
  if (state === 'blocked') return '#d7aa68'
  if (state === 'failed') return '#d6797f'
  if (state === 'inactive') return '#555159'
  return '#77717f'
}

function clockLabel(value: string | null): string {
  const parsed = time(value)
  if (parsed === null) return ''
  return new Date(parsed).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function compactDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return '<1s'
  const seconds = Math.round(milliseconds / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m${seconds % 60 ? `${seconds % 60}s` : ''}`
}

function summaryFor(
  node: RunNode | undefined,
  state: ExecutionNodeState,
  incident: DiagnosticIncident | undefined,
  pendingChildren: number,
  replaying: boolean,
): { summary: string, tool: string } {
  if (replaying && state === 'active') return { summary: 'Active at replay cursor', tool: '' }
  if (state === 'active' && node?.current) {
    return { summary: node.current.summary.replace(/\s+/g, ' ').slice(0, 110), tool: node.current.tool }
  }
  if (state === 'blocked') {
    return { summary: pendingChildren ? `Waiting for ${pendingChildren} child ${pendingChildren === 1 ? 'agent' : 'agents'}` : 'Waiting for a child result', tool: '' }
  }
  if (state === 'failed') return { summary: incident?.title || 'Run ended with recorded errors', tool: incident?.tool || '' }
  if (state === 'completed' && node?.finalText) {
    const first = node.finalText.replace(/^#+\s*/gm, '').split('\n').find(Boolean)
    if (first) return { summary: first.replace(/\s+/g, ' ').slice(0, 110), tool: '' }
  }
  if (state === 'completed') return { summary: replaying ? 'Completed by replay cursor' : 'Returned to parent', tool: '' }
  return { summary: 'No recorded activity', tool: '' }
}

export function buildExecutionGraph(
  lanes: TimelineLane[],
  previousPositions: ReadonlyMap<string, XYPosition> = new Map(),
  direction: ExecutionDirection = 'left-to-right',
  detail: ExecutionDetail = DEFAULT_EXECUTION_DETAIL,
  context: ExecutionGraphContext = {},
): ExecutionGraph {
  const now = context.now ?? Date.now()
  const asOf = context.asOf ?? null
  const visibleLanes = asOf === null
    ? lanes
    : lanes.filter((lane, index) => index === 0 || time(lane.firstTs) === null || time(lane.firstTs)! <= asOf)
  const roots = buildTree(visibleLanes)
  const allEntries = roots.flatMap(descendants)
  const entryByKey = new Map(allEntries.map(entry => [entry.lane.key, entry]))
  const nodeByKey = new Map(flattenRunTree(context.root || null).map(node => [node.key, node]))
  const incidents = context.diagnostics?.incidents || []
  const changes = context.diagnostics?.changes || []
  const lens = context.lens || 'all'
  const query = (context.query || '').trim().toLowerCase()
  const coordinationKeys = new Set(context.coordination?.findings.flatMap(finding => finding.keys) || [])
  const directMatches = new Set<string>()

  for (const entry of allEntries) {
    const lane = entry.lane
    const state = stateFor(lane, incidents, asOf)
    const node = nodeByKey.get(lane.key)
    const laneIncidents = relevantIncidents(lane.key, incidents, asOf)
    const laneChanges = changes.filter(change => change.key === lane.key
      && (asOf === null || time(change.ts) === null || time(change.ts)! <= asOf))
    const lensMatch = lens === 'all'
      || (lens === 'active' && (state === 'active' || state === 'blocked'))
      || (lens === 'problems' && (state === 'failed' || laneIncidents.length > 0))
      || (lens === 'files' && (lane.files > 0 || laneChanges.length > 0))
      || (lens === 'coordination' && coordinationKeys.has(lane.key))
    const label = normalizeSessionLabel(lane.label, lane.key).toLowerCase()
    const queryMatch = !query || label.includes(query) || lane.agentType.toLowerCase().includes(query)
      || node?.current?.summary.toLowerCase().includes(query)
    const fileMatch = !context.focusedFile || node?.files.some(file => file.path === context.focusedFile)
      || laneChanges.some(change => change.path === context.focusedFile)
    if (lensMatch && queryMatch && fileMatch) directMatches.add(lane.key)
  }

  const contextualMatches = new Set(directMatches)
  for (const key of directMatches) {
    let parent = entryByKey.get(key)?.parent
    while (parent) {
      contextualMatches.add(parent.lane.key)
      parent = parent.parent
    }
  }

  const selectedPath = new Set<string>()
  const selectedEntry = context.selectedKey ? entryByKey.get(context.selectedKey) : undefined
  if (selectedEntry) {
    descendants(selectedEntry).forEach(entry => selectedPath.add(entry.lane.key))
    let parent: LayoutEntry | null = selectedEntry
    while (parent) {
      selectedPath.add(parent.lane.key)
      parent = parent.parent
    }
  }

  const nodes: Array<Node<ExecutionNodeData>> = []
  const edges: Array<Edge<ExecutionEdgeData>> = []
  let nextRow = 0
  const overview = detail === 'overview'
  const branchGap = direction === 'left-to-right'
    ? overview ? 166 : VERTICAL_GAP
    : overview ? 300 : TOP_DOWN_BRANCH_GAP
  const levelGap = direction === 'left-to-right'
    ? overview ? 348 : HORIZONTAL_GAP
    : overview ? 218 : TOP_DOWN_LEVEL_GAP
  const workstreamByKey = new Map<string, number>()
  const overviewPositions = new Map<string, XYPosition>()
  roots.forEach(root => {
    workstreamByKey.set(root.lane.key, 0)
    root.children.forEach((child, index) => workstreamByKey.set(child.lane.key, index + 1))
    if (!overview) return
    if (direction === 'left-to-right') {
      const rows = Math.max(1, Math.ceil(root.children.length / 2))
      overviewPositions.set(root.lane.key, { x: 0, y: ((rows - 1) * branchGap) / 2 })
      root.children.forEach((child, index) => overviewPositions.set(child.lane.key, {
        x: (Math.floor(index / rows) + 1) * levelGap,
        y: (index % rows) * branchGap,
      }))
    } else {
      const columns = Math.max(1, Math.min(3, root.children.length))
      overviewPositions.set(root.lane.key, { x: ((columns - 1) * branchGap) / 2, y: 0 })
      root.children.forEach((child, index) => overviewPositions.set(child.lane.key, {
        x: (index % columns) * branchGap,
        y: (Math.floor(index / columns) + 1) * levelGap,
      }))
    }
  })

  const isCollapsed = (entry: LayoutEntry): boolean => {
    if (!entry.children.length) return false
    if (overview && entry.lane.depth > 0) return true
    if (!context.collapsedKeys?.has(entry.lane.key)) return false
    if (lens === 'problems') {
      const stats = aggregate(entry, context, nodeByKey)
      if (stats.errors || stats.incidents) return false
    }
    return true
  }

  const place = (entry: LayoutEntry): number => {
    const collapsed = isCollapsed(entry)
    const children = collapsed ? [] : entry.children
    const childRows = children.map(place)
    entry.y = childRows.length ? (childRows[0]! + childRows.at(-1)!) / 2 : nextRow++ * branchGap

    const lane = entry.lane
    const aggregateNode = overview || collapsed
    const stats = aggregateNode ? aggregate(entry, context, nodeByKey) : aggregate(entry, { ...context }, nodeByKey)
    if (!aggregateNode) {
      stats.agents = 1
      stats.memberKeys = [lane.key]
      stats.errors = lane.errors
      stats.files = lane.files
      stats.tools = lane.tools
      stats.firstTs = lane.firstTs
      stats.lastTs = lane.lastTs
      stats.live = stateFor(lane, incidents, asOf) === 'active'
      stats.blocked = stateFor(lane, incidents, asOf) === 'blocked'
      stats.completed = stateFor(lane, incidents, asOf) === 'completed'
      stats.incidents = relevantIncidents(lane.key, incidents, asOf).length
      stats.changes = changes.filter(change => change.key === lane.key
        && (asOf === null || time(change.ts) === null || time(change.ts)! <= asOf)).length
      stats.tokens = nodeByKey.get(lane.key)?.tokensOut || 0
    }
    const state = aggregateNode ? aggregateState(stats) : stateFor(lane, incidents, asOf)
    const memberKeys = overview && lane.depth === 0 ? [lane.key] : stats.memberKeys
    const node = nodeByKey.get(lane.key)
    const laneIncidents = relevantIncidents(lane.key, incidents, asOf)
    const lastIncident = laneIncidents.at(-1)
    const pendingChildren = node?.children.filter(child => child.live || child.spawnState === 'running').length || 0
    const semantic = summaryFor(node, state, lastIncident, pendingChildren, asOf !== null)
    const matched = memberKeys.some(key => contextualMatches.has(key))
    const focusedFile = Boolean(context.focusedFile && memberKeys.some(key => {
      const member = nodeByKey.get(key)
      return member?.files.some(file => file.path === context.focusedFile)
        || changes.some(change => change.key === key && change.path === context.focusedFile)
    }))
    const muted = Boolean(lens !== 'all' || query || context.focusedFile) && !matched
    const collision = memberKeys.some(key => context.coordination?.collisionKeys.has(key))
    const critical = memberKeys.some(key => context.coordination?.criticalPathKeys.has(key))
    const bottleneck = memberKeys.some(key => context.coordination?.bottleneckKeys.has(key))
    const onPath = memberKeys.some(key => selectedPath.has(key))
    const nodeWidth = aggregateNode ? 270 : 252
    nodes.push({
      id: lane.key,
      type: 'agent',
      position: previousPositions.get(lane.key) || overviewPositions.get(lane.key) || {
        x: direction === 'left-to-right' ? lane.depth * levelGap : entry.y,
        y: direction === 'left-to-right' ? entry.y : lane.depth * levelGap,
      },
      width: nodeWidth,
      class: [aggregateNode ? 'overview-node' : '', muted ? 'muted-node' : '', onPath ? 'path-node' : ''].filter(Boolean).join(' '),
      connectable: false,
      deletable: false,
      ariaLabel: `${normalizeSessionLabel(lane.label, lane.key)}, ${state}`,
      data: {
        label: normalizeSessionLabel(lane.label, lane.key),
        agentType: lane.agentType || (lane.depth ? 'Subagent' : 'Main session'),
        tools: stats.tools,
        files: stats.files,
        tokens: stats.tokens,
        firstTs: stats.firstTs,
        lastTs: stats.lastTs,
        depth: lane.depth,
        root: lane.depth === 0,
        state,
        overview: aggregateNode,
        agents: stats.agents,
        errors: stats.errors,
        incidents: stats.incidents,
        changes: stats.changes,
        workstream: workstreamByKey.get(lane.key) || 0,
        memberKeys,
        summary: semantic.summary,
        currentTool: semantic.tool,
        idleMs: Math.max(0, now - (time(lane.lastTs) ?? now)),
        pendingChildren,
        collapsed,
        collapsible: entry.children.length > 0,
        muted,
        onPath,
        collision,
        critical,
        bottleneck,
        focusedFile,
      },
    })

    for (const child of children) {
      const childStats = (overview || isCollapsed(child)) ? aggregate(child, context, nodeByKey) : null
      const childState = childStats ? aggregateState(childStats) : stateFor(child.lane, incidents, asOf)
      const childDuration = duration(child.lane.firstTs, child.lane.lastTs, asOf ?? now)
      const interrupted = relevantIncidents(child.lane.key, incidents, asOf)
        .some(incident => incident.category === 'interruption')
      const relation: ExecutionEdgeData['relation'] = interrupted
        ? 'interrupted'
        : childState === 'active'
          ? 'running'
          : childState === 'blocked'
            ? 'waiting'
            : child.lane.spawnState === 'returned' || child.lane.lastTs
              ? 'returned'
              : 'spawned'
      const label = [
        clockLabel(child.lane.firstTs) ? `spawned ${clockLabel(child.lane.firstTs)}` : '',
        relation === 'running' ? `running ${compactDuration(childDuration)}`
          : relation === 'waiting' ? `waiting ${compactDuration(childDuration)}`
            : relation === 'returned' ? `returned ${compactDuration(childDuration)}`
              : relation === 'interrupted' ? 'interrupted' : '',
      ].filter(Boolean).join(' · ')
      const onEdgePath = selectedPath.has(entry.lane.key) && selectedPath.has(child.lane.key)
      const color = edgeColor(childState)
      edges.push({
        id: `${lane.key}->${child.lane.key}`,
        source: lane.key,
        target: child.lane.key,
        type: 'smoothstep',
        animated: childState === 'active',
        selectable: false,
        focusable: false,
        interactionWidth: 40,
        label,
        class: `execution-edge ${childState}${onEdgePath ? ' selected-path' : ''}`,
        data: { durationMs: childDuration, relation, onPath: onEdgePath },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
      })
    }
    return entry.y
  }

  for (const root of roots) {
    place(root)
    nextRow += 0.45
  }
  return { nodes, edges }
}
