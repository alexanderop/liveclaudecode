import type { RunNode, RunResponse } from '#shared/types/run'
import { parseTimestamp } from './format'

export type CoordinationFindingKind =
  | 'file-collision'
  | 'duplicate-work'
  | 'wait-hotspot'
  | 'run-hotspot'
  | 'bottleneck'
  | 'critical-path'
  | 'unconsumed-result'

export interface CoordinationFinding {
  id: string
  kind: CoordinationFindingKind
  severity: 'error' | 'warning' | 'info'
  title: string
  detail: string
  keys: string[]
  file?: string
  command?: string
  durationMs?: number
}

export interface CoordinationAnalysis {
  findings: CoordinationFinding[]
  collisionKeys: ReadonlySet<string>
  criticalPathKeys: ReadonlySet<string>
  bottleneckKeys: ReadonlySet<string>
  fileAgents: ReadonlyMap<string, string[]>
}

export function flattenRunTree(root: RunNode | null): RunNode[] {
  if (!root) return []
  const output: RunNode[] = []
  const visit = (node: RunNode): void => {
    output.push(node)
    node.children.forEach(visit)
  }
  visit(root)
  return output
}

/** Maps every descendant's key to its parent node. */
export function buildParentIndex(root: RunNode | null): ReadonlyMap<string, RunNode> {
  const parents = new Map<string, RunNode>()
  for (const node of flattenRunTree(root)) {
    for (const child of node.children) parents.set(child.key, node)
  }
  return parents
}

/** Depth-first search for the node with `key`, including the root itself. */
export function findNode(root: RunNode | null, key: string | null): RunNode | null {
  if (!root || !key) return null
  if (root.key === key) return root
  for (const child of root.children) {
    const found = findNode(child, key)
    if (found) return found
  }
  return null
}

/**
 * Follows the most recently spawned live branch down to the agent that is
 * actually doing work right now; returns the node itself when nothing
 * beneath it is live.
 */
export function deepestLiveNode(node: RunNode): RunNode {
  const liveChildren = node.children.filter(child => child.subLive)
  return liveChildren.length ? deepestLiveNode(liveChildren.at(-1)!) : node
}

export function runNodeDuration(node: RunNode, now = Date.now()): number {
  const start = parseTimestamp(node.firstTs)
  if (start === null) return 0
  const end = parseTimestamp(node.lastTs) ?? (node.live ? now : start)
  return Math.max(0, end - start)
}

function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim()
}

function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.slice(-2).join('/') || path
}

export function analyzeCoordination(
  root: RunNode | null,
  run: RunResponse | null,
  now = Date.now(),
): CoordinationAnalysis {
  const nodes = flattenRunTree(root)
  const findings: CoordinationFinding[] = []
  const collisionKeys = new Set<string>()
  const bottleneckKeys = new Set<string>()
  const fileAgents = new Map<string, string[]>()
  const activeDurations = nodes.filter(node => node.live).map(node => runNodeDuration(node, now)).sort((a, b) => a - b)
  const activeMedian = activeDurations.length
    ? activeDurations[Math.floor(activeDurations.length / 2)]!
    : 0
  const longRunningThreshold = Math.max(5 * 60_000, activeMedian * 2)

  for (const node of nodes) {
    for (const file of node.files) {
      const keys = fileAgents.get(file.path) || []
      if (!keys.includes(node.key)) keys.push(node.key)
      fileAgents.set(file.path, keys)
    }
  }
  for (const change of run?.diagnostics?.changes || []) {
    if (!change.key) continue
    const keys = fileAgents.get(change.path) || []
    if (!keys.includes(change.key)) keys.push(change.key)
    fileAgents.set(change.path, keys)
  }
  for (const [file, keys] of fileAgents) {
    if (keys.length < 2) continue
    keys.forEach(key => collisionKeys.add(key))
    findings.push({
      id: `file:${file}`,
      kind: 'file-collision',
      severity: 'warning',
      title: `${keys.length} agents touched ${shortPath(file)}`,
      detail: 'Concurrent edits may overlap or invalidate another agent’s assumptions.',
      keys,
      file,
    })
  }

  const commands = new Map<string, string[]>()
  for (const node of nodes) {
    for (const item of node.commands) {
      const command = normalizeCommand(item.cmd)
      if (!command) continue
      const keys = commands.get(command) || []
      if (!keys.includes(node.key)) keys.push(node.key)
      commands.set(command, keys)
    }
  }
  for (const [command, keys] of commands) {
    if (keys.length < 2) continue
    findings.push({
      id: `command:${command}`,
      kind: 'duplicate-work',
      severity: 'info',
      title: `${keys.length} agents repeated a command`,
      detail: command.slice(0, 180),
      keys,
      command,
    })
  }

  for (const node of nodes) {
    const durationMs = runNodeDuration(node, now)
    if (node.spawnState === 'running' && !node.live) {
      findings.push({
        id: `wait:${node.key}`,
        kind: 'wait-hotspot',
        severity: 'warning',
        title: `${node.label} is waiting`,
        detail: node.current?.summary || 'The parent has not recorded a returned result yet.',
        keys: [node.key],
        durationMs,
      })
    }
    if (node.live && durationMs >= longRunningThreshold) {
      findings.push({
        id: `run:${node.key}`,
        kind: 'run-hotspot',
        severity: 'info',
        title: `${node.label} is a long-running agent`,
        detail: node.current
          ? `${node.current.tool}: ${node.current.summary}`
          : 'This agent has been active substantially longer than its peers without a current tool signal.',
        keys: [node.key],
        durationMs,
      })
    }
    if (node.children.length >= 3) {
      bottleneckKeys.add(node.key)
      findings.push({
        id: `fanout:${node.key}`,
        kind: 'bottleneck',
        severity: 'info',
        title: `${node.label} coordinates ${node.children.length} branches`,
        detail: 'The coordinator owns result collection across this fan-out; inspect branches that stop reporting activity.',
        keys: [node.key, ...node.children.map(child => child.key)],
      })
    }
    for (const child of node.children) {
      const returnedAt = parseTimestamp(child.lastTs)
      if (child.spawnState === 'returned' && child.finalText && node.live
        && returnedAt !== null && now - returnedAt >= 30_000) {
        findings.push({
          id: `consume:${child.key}`,
          kind: 'unconsumed-result',
          severity: 'info',
          title: `${child.label} returned while its parent is active`,
          detail: 'The result may still be awaiting integration into the parent’s work.',
          keys: [node.key, child.key],
        })
      }
    }
  }

  const criticalPathKeys = new Set<string>()
  const longestPath = (node: RunNode): { duration: number, path: RunNode[] } => {
    const own = runNodeDuration(node, now)
    if (!node.children.length) return { duration: own, path: [node] }
    const child = node.children.map(longestPath).sort((a, b) => b.duration - a.duration)[0]!
    return { duration: own + child.duration, path: [node, ...child.path] }
  }
  if (root) {
    const critical = longestPath(root)
    critical.path.forEach(node => criticalPathKeys.add(node.key))
    if (critical.path.length > 1) {
      findings.push({
        id: 'critical-path',
        kind: 'critical-path',
        severity: 'info',
        title: `Critical path spans ${critical.path.length} agents`,
        detail: critical.path.map(node => node.label).join(' → '),
        keys: critical.path.map(node => node.key),
        durationMs: critical.duration,
      })
    }
  }

  const severityRank = { error: 0, warning: 1, info: 2 }
  findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]
    || (b.durationMs || 0) - (a.durationMs || 0)
    || a.title.localeCompare(b.title))

  return { findings, collisionKeys, criticalPathKeys, bottleneckKeys, fileAgents }
}
