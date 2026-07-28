import { MarkerType, type Edge, type Node, type XYPosition } from '@vue-flow/core'
import type { TimelineLane } from '#shared/types/run'

export type ExecutionNodeState = 'active' | 'blocked' | 'completed' | 'failed' | 'inactive'
export type ExecutionDirection = 'left-to-right' | 'top-to-bottom'
export type ExecutionDetail = 'overview' | 'all-agents'

export interface ExecutionNodeData {
  label: string
  agentType: string
  tools: number
  files: number
  firstTs: TimelineLane['firstTs']
  lastTs: TimelineLane['lastTs']
  depth: number
  root: boolean
  selected: boolean
  state: ExecutionNodeState
  overview: boolean
  agents: number
  errors: number
  workstream: number
  memberKeys: string[]
}

export interface ExecutionGraph {
  nodes: Array<Node<ExecutionNodeData>>
  edges: Edge[]
}

interface LayoutEntry {
  lane: TimelineLane
  children: LayoutEntry[]
  y: number
}

const HORIZONTAL_GAP = 300
const VERTICAL_GAP = 136
const TOP_DOWN_LEVEL_GAP = 180
const TOP_DOWN_BRANCH_GAP = 270

interface AggregateStats {
  agents: number
  blocked: boolean
  completed: boolean
  errors: number
  files: number
  firstTs: TimelineLane['firstTs']
  lastTs: TimelineLane['lastTs']
  live: boolean
  memberKeys: string[]
  tools: number
}

function stateFor(lane: TimelineLane): ExecutionNodeState {
  if (lane.live) return 'active'
  if (lane.spawnState === 'running') return 'blocked'
  if (lane.errors) return 'failed'
  if (!lane.firstTs && !lane.lastTs && !lane.tools) return 'inactive'
  return 'completed'
}

function buildTree(lanes: TimelineLane[]): LayoutEntry[] {
  const roots: LayoutEntry[] = []
  const stack: LayoutEntry[] = []

  for (const lane of lanes) {
    const entry: LayoutEntry = { lane, children: [], y: 0 }
    const parent = lane.depth > 0 ? stack[lane.depth - 1] : undefined
    if (parent) parent.children.push(entry)
    else roots.push(entry)

    stack[lane.depth] = entry
    stack.length = lane.depth + 1
  }

  return roots
}

function aggregate(entry: LayoutEntry): AggregateStats {
  const entries: LayoutEntry[] = []
  const visit = (current: LayoutEntry): void => {
    entries.push(current)
    current.children.forEach(visit)
  }
  visit(entry)

  const starts = entries.map(item => item.lane.firstTs).filter(value => value !== null).sort()
  const ends = entries.map(item => item.lane.lastTs).filter(value => value !== null).sort()
  return {
    agents: entries.length,
    blocked: entries.some(item => stateFor(item.lane) === 'blocked'),
    completed: entries.some(item => stateFor(item.lane) === 'completed'),
    errors: entries.reduce((total, item) => total + item.lane.errors, 0),
    files: entries.reduce((total, item) => total + item.lane.files, 0),
    firstTs: starts[0] || null,
    lastTs: ends.at(-1) || null,
    live: entries.some(item => item.lane.live),
    memberKeys: entries.map(item => item.lane.key),
    tools: entries.reduce((total, item) => total + item.lane.tools, 0),
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

export function buildExecutionGraph(
  lanes: TimelineLane[],
  selectedKey: string | null,
  previousPositions: ReadonlyMap<string, XYPosition> = new Map(),
  direction: ExecutionDirection = 'left-to-right',
  detail: ExecutionDetail = 'all-agents',
): ExecutionGraph {
  const roots = buildTree(lanes)
  const nodes: Array<Node<ExecutionNodeData>> = []
  const edges: Edge[] = []
  let nextRow = 0
  const overview = detail === 'overview'
  const branchGap = direction === 'left-to-right'
    ? overview ? 158 : VERTICAL_GAP
    : overview ? 286 : TOP_DOWN_BRANCH_GAP
  const levelGap = direction === 'left-to-right'
    ? overview ? 330 : HORIZONTAL_GAP
    : overview ? 205 : TOP_DOWN_LEVEL_GAP
  const workstreamByKey = new Map<string, number>()
  const overviewPositions = new Map<string, XYPosition>()
  if (overview) {
    for (const root of roots) {
      workstreamByKey.set(root.lane.key, 0)
      root.children.forEach((child, index) => workstreamByKey.set(child.lane.key, index + 1))

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
    }
  }

  const visibleChildren = (entry: LayoutEntry): LayoutEntry[] =>
    overview && entry.lane.depth > 0 ? [] : entry.children

  const place = (entry: LayoutEntry): number => {
    const children = visibleChildren(entry)
    const childRows = children.map(place)
    entry.y = childRows.length
      ? (childRows[0]! + childRows.at(-1)!) / 2
      : nextRow++ * branchGap

    const lane = entry.lane
    const stats = overview ? aggregate(entry) : {
      agents: 1,
      blocked: stateFor(lane) === 'blocked',
      completed: stateFor(lane) === 'completed',
      errors: lane.errors,
      files: lane.files,
      firstTs: lane.firstTs,
      lastTs: lane.lastTs,
      live: lane.live,
      memberKeys: [lane.key],
      tools: lane.tools,
    }
    const state = aggregateState(stats)
    const selectableMemberKeys = overview && lane.depth === 0 ? [lane.key] : stats.memberKeys
    nodes.push({
      id: lane.key,
      type: 'agent',
      position: previousPositions.get(lane.key) || overviewPositions.get(lane.key) || {
        x: direction === 'left-to-right' ? lane.depth * levelGap : entry.y,
        y: direction === 'left-to-right' ? entry.y : lane.depth * levelGap,
      },
      width: overview ? 258 : 238,
      class: overview ? 'overview-node' : undefined,
      connectable: false,
      deletable: false,
      ariaLabel: `${lane.label}, ${state}`,
      data: {
        label: lane.label,
        agentType: lane.agentType || (lane.depth ? 'Subagent' : 'Main session'),
        tools: stats.tools,
        files: stats.files,
        firstTs: stats.firstTs,
        lastTs: stats.lastTs,
        depth: lane.depth,
        root: lane.depth === 0,
        selected: selectedKey !== null && selectableMemberKeys.includes(selectedKey),
        state,
        overview,
        agents: stats.agents,
        errors: stats.errors,
        workstream: workstreamByKey.get(lane.key) || 0,
        memberKeys: selectableMemberKeys,
      },
    })

    for (const child of children) {
      const childState = overview ? aggregateState(aggregate(child)) : stateFor(child.lane)
      const color = edgeColor(childState)
      edges.push({
        id: `${lane.key}->${child.lane.key}`,
        source: lane.key,
        target: child.lane.key,
        type: 'smoothstep',
        animated: childState === 'active',
        selectable: false,
        focusable: false,
        class: `execution-edge ${childState}`,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color,
          width: 16,
          height: 16,
        },
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
