import dagre from '@dagrejs/dagre'
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
import { canonicalIssueCount, type AgentDisplayState } from '~/utils/session-state'

export type ExecutionNodeState = 'active' | 'blocked' | 'completed' | 'failed' | 'inactive'
export type ExecutionDirection = 'left-to-right' | 'top-to-bottom'
export type ExecutionDetail = 'overview' | 'all-agents'
export type ExecutionLens = 'all' | 'active' | 'problems' | 'files' | 'coordination'
export const DEFAULT_EXECUTION_DETAIL: ExecutionDetail = 'all-agents'
export const DENSE_NESTED_GRAPH_THRESHOLD = 12

export function defaultExecutionDetail(lanes: TimelineLane[]): ExecutionDetail {
  return lanes.length > DENSE_NESTED_GRAPH_THRESHOLD && lanes.some(lane => lane.depth > 1)
    ? 'overview'
    : DEFAULT_EXECUTION_DETAIL
}

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
  displayState: AgentDisplayState
  overview: boolean
  agents: number
  errors: number
  incidents: number
  issues: number
  changes: number
  workstream: number
  memberKeys: string[]
  summary: string
  currentTool: string
  idleMs: number
  pendingChildren: number
  childCount: number
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
  expandedKeys?: ReadonlySet<string>
  coordination?: CoordinationAnalysis | null
}

interface LayoutEntry {
  lane: TimelineLane
  children: LayoutEntry[]
  parent: LayoutEntry | null
}

interface AggregateStats {
  agents: number
  blocked: boolean
  completed: boolean
  errors: number
  incidents: number
  issues: number
  changes: number
  files: number
  firstTs: TimelineLane['firstTs']
  lastTs: TimelineLane['lastTs']
  live: boolean
  failed: boolean
  memberKeys: string[]
  tools: number
  tokens: number
}

const GRID_SIZE = 8
const NODE_WIDTH = 252
const OVERVIEW_NODE_WIDTH = 270
const NODE_MIN_HEIGHT = 122
const OVERVIEW_MIN_HEIGHT = 136
const HORIZONTAL_RANK_GAP = 160
const HORIZONTAL_NODE_GAP = 72
const TOP_DOWN_RANK_GAP = 104
const TOP_DOWN_NODE_GAP = 88

function executionNodeHeight(data: ExecutionNodeData): number {
  let height = data.overview ? OVERVIEW_MIN_HEIGHT : NODE_MIN_HEIGHT
  if (data.issues || data.collision || data.bottleneck || data.critical) height += 25
  if (data.overview) height += 25
  if (data.childCount) height += 26
  return height
}

function snapPositionByCenter(value: number, size: number): number {
  return Math.round(value / GRID_SIZE) * GRID_SIZE - size / 2
}

/**
 * n8n's workflow canvas lays out the visible graph with Dagre using measured
 * node boxes, separate rank/node gaps, and center-based grid snapping. Agent
 * cards are predictable enough to use their rendered width and an estimated
 * content height here, which keeps nested branches from sharing space.
 */
function layoutExecutionNodes(
  nodes: Array<Node<ExecutionNodeData>>,
  edges: Array<Edge<ExecutionEdgeData>>,
  direction: ExecutionDirection,
  orderByKey: ReadonlyMap<string, number>,
  positionOverrides: ReadonlyMap<string, XYPosition>,
): Array<Node<ExecutionNodeData>> {
  if (!nodes.length) return nodes

  const graph = new dagre.graphlib.Graph()
  graph.setGraph({
    rankdir: direction === 'left-to-right' ? 'LR' : 'TB',
    ranksep: direction === 'left-to-right' ? HORIZONTAL_RANK_GAP : TOP_DOWN_RANK_GAP,
    nodesep: direction === 'left-to-right' ? HORIZONTAL_NODE_GAP : TOP_DOWN_NODE_GAP,
    edgesep: 32,
    marginx: 0,
    marginy: 0,
  })
  graph.setDefaultEdgeLabel(() => ({}))

  const dimensions = new Map<string, { width: number, height: number }>()
  const orderedNodes = [...nodes].sort((left, right) =>
    (orderByKey.get(left.id) ?? 0) - (orderByKey.get(right.id) ?? 0))
  for (const node of orderedNodes) {
    const size = {
      width: node.data!.overview ? OVERVIEW_NODE_WIDTH : NODE_WIDTH,
      height: executionNodeHeight(node.data!),
    }
    dimensions.set(node.id, size)
    graph.setNode(node.id, size)
  }

  const visibleKeys = new Set(nodes.map(node => node.id))
  const orderedEdges = [...edges].sort((left, right) =>
    (orderByKey.get(left.target) ?? 0) - (orderByKey.get(right.target) ?? 0))
  for (const edge of orderedEdges) {
    if (visibleKeys.has(edge.source) && visibleKeys.has(edge.target)) {
      graph.setEdge(edge.source, edge.target)
    }
  }

  dagre.layout(graph, { disableOptimalOrderHeuristic: true })

  return nodes.map((node) => {
    const override = positionOverrides.get(node.id)
    if (override) return { ...node, position: override }
    const position = graph.node(node.id)
    const size = dimensions.get(node.id)!
    return {
      ...node,
      position: {
        x: snapPositionByCenter(position.x, size.width),
        y: snapPositionByCenter(position.y, size.height),
      },
    }
  })
}

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
  node?: RunNode,
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
  if (lane.errors || laneIncidents.some(incident => incident.severity === 'error')) {
    return node?.finalText ? 'completed' : 'failed'
  }
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
    const entry: LayoutEntry = { lane, children: [], parent }
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
  const states = entries.map(item => stateFor(item.lane, incidents, context.asOf ?? null, nodeByKey.get(item.lane.key)))
  return {
    agents: entries.length,
    blocked: states.includes('blocked'),
    completed: states.includes('completed'),
    errors: entries.reduce((total, item) => total + item.lane.errors, 0),
    incidents: entries.reduce((total, item) => total + relevantIncidents(item.lane.key, incidents, context.asOf ?? null)
      .filter(incident => incident.severity !== 'info').length, 0),
    issues: entries.reduce((total, item) => total + canonicalIssueCount(
      item.lane.errors,
      relevantIncidents(item.lane.key, incidents, context.asOf ?? null),
    ), 0),
    changes: changes.filter(change => change.key && entries.some(item => item.lane.key === change.key)
      && (context.asOf == null || time(change.ts) === null || time(change.ts)! <= context.asOf)).length,
    files: entries.reduce((total, item) => total + item.lane.files, 0),
    firstTs: starts[0] || null,
    lastTs: ends.at(-1) || null,
    live: states.includes('active'),
    failed: states.includes('failed'),
    memberKeys: entries.map(item => item.lane.key),
    tools: entries.reduce((total, item) => total + item.lane.tools, 0),
    tokens: entries.reduce((total, item) => total + (nodeByKey.get(item.lane.key)?.tokensOut || 0), 0),
  }
}

function aggregateState(stats: AggregateStats): ExecutionNodeState {
  if (stats.live) return 'active'
  if (stats.blocked) return 'blocked'
  if (stats.failed) return 'failed'
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
  if (state === 'active' && node) {
    return {
      summary: node.tools ? `Working through the session · ${node.tools} tool calls recorded` : 'Thinking before the next action',
      tool: '',
    }
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
  return { summary: node?.tools ? `${node.tools} tool calls recorded` : 'No activity recorded yet', tool: '' }
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
  const orderByKey = new Map(allEntries.map((entry, index) => [entry.lane.key, index]))
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
    const node = nodeByKey.get(lane.key)
    const state = stateFor(lane, incidents, asOf, node)
    const laneIncidents = relevantIncidents(lane.key, incidents, asOf)
    const laneChanges = changes.filter(change => change.key === lane.key
      && (asOf === null || time(change.ts) === null || time(change.ts)! <= asOf))
    const lensMatch = lens === 'all'
      || (lens === 'active' && (state === 'active' || state === 'blocked'))
      || (lens === 'problems' && (state === 'failed' || lane.errors > 0 || laneIncidents.some(incident => incident.severity !== 'info')))
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
  const overview = detail === 'overview'
  const workstreamByKey = new Map<string, number>()
  roots.forEach(root => {
    workstreamByKey.set(root.lane.key, 0)
    root.children.forEach((child, index) => workstreamByKey.set(child.lane.key, index + 1))
  })

  const isCollapsed = (entry: LayoutEntry): boolean => {
    if (!entry.children.length) return false
    if (overview && entry.lane.depth > 0) {
      if (context.expandedKeys?.has(entry.lane.key)) return false
      if (lens === 'problems') {
        const stats = aggregate(entry, context, nodeByKey)
        if (stats.issues) return false
      }
      return true
    }
    if (!context.collapsedKeys?.has(entry.lane.key)) return false
    if (lens === 'problems') {
      const stats = aggregate(entry, context, nodeByKey)
      if (stats.issues) return false
    }
    return true
  }

  const place = (entry: LayoutEntry): void => {
    const collapsed = isCollapsed(entry)
    const children = collapsed ? [] : entry.children
    children.forEach(place)

    const lane = entry.lane
    const aggregateNode = collapsed || (overview && entry.lane.depth <= 1)
    const stats = aggregateNode ? aggregate(entry, context, nodeByKey) : aggregate(entry, { ...context }, nodeByKey)
    if (!aggregateNode) {
      stats.agents = 1
      stats.memberKeys = [lane.key]
      stats.errors = lane.errors
      stats.files = lane.files
      stats.tools = lane.tools
      stats.firstTs = lane.firstTs
      stats.lastTs = lane.lastTs
      const laneState = stateFor(lane, incidents, asOf, nodeByKey.get(lane.key))
      const laneIncidents = relevantIncidents(lane.key, incidents, asOf)
      stats.live = laneState === 'active'
      stats.blocked = laneState === 'blocked'
      stats.completed = laneState === 'completed'
      stats.failed = laneState === 'failed'
      stats.incidents = laneIncidents.filter(incident => incident.severity !== 'info').length
      stats.issues = canonicalIssueCount(lane.errors, laneIncidents)
      stats.changes = changes.filter(change => change.key === lane.key
        && (asOf === null || time(change.ts) === null || time(change.ts)! <= asOf)).length
      stats.tokens = nodeByKey.get(lane.key)?.tokensOut || 0
    }
    const state = aggregateNode ? aggregateState(stats) : stateFor(lane, incidents, asOf, nodeByKey.get(lane.key))
    const memberKeys = overview && lane.depth === 0 ? [lane.key] : stats.memberKeys
    const node = nodeByKey.get(lane.key)
    const laneIncidents = relevantIncidents(lane.key, incidents, asOf)
    const lastIncident = laneIncidents.at(-1)
    const pendingChildren = node?.children.filter(child => child.live || child.spawnState === 'running').length || 0
    const semantic = summaryFor(node, state, lastIncident, pendingChildren, asOf !== null)
    const displayState: AgentDisplayState = state === 'active'
      ? node?.current ? 'running' : 'thinking'
      : state === 'blocked'
        ? 'waiting'
        : state === 'failed'
          ? 'failed'
          : state === 'completed' && stats.issues
            ? 'warning'
            : state === 'completed' ? 'completed' : 'inactive'
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
      position: { x: 0, y: 0 },
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
        displayState,
        overview: aggregateNode,
        agents: stats.agents,
        errors: stats.errors,
        incidents: stats.incidents,
        issues: stats.issues,
        changes: stats.changes,
        workstream: workstreamByKey.get(lane.key) || 0,
        memberKeys,
        summary: semantic.summary,
        currentTool: semantic.tool,
        idleMs: Math.max(0, now - (time(lane.lastTs) ?? now)),
        pendingChildren,
        childCount: entry.children.length,
        collapsed,
        collapsible: entry.children.length > 0 && !(overview && lane.depth === 0),
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
      const childState = childStats ? aggregateState(childStats) : stateFor(child.lane, incidents, asOf, nodeByKey.get(child.lane.key))
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
        pathOptions: { borderRadius: 16, offset: 28 },
        animated: childState === 'active',
        selectable: false,
        focusable: false,
        interactionWidth: 40,
        label: overview ? '' : label,
        class: `execution-edge ${childState}${onEdgePath ? ' selected-path' : ''}`,
        data: { durationMs: childDuration, relation, onPath: onEdgePath },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
      })
    }
  }

  roots.forEach(place)
  return {
    nodes: layoutExecutionNodes(nodes, edges, direction, orderByKey, previousPositions),
    edges,
  }
}
