import { join, resolve, sep } from 'node:path'
import { Clock, Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import {
  parseClaudeRecord,
  parseClaudeSubagentMeta,
  type ClaudeSubagentMeta,
} from '#shared/schemas/claude'
import { InvalidRunKey, PromptCache, ScanCache } from './services'
import type {
  AgentDiagnosticSummary,
  DiagnosticIncident,
  Milestone,
  PublicRunNode,
  RunDiagnostics,
  RunNode,
  SessionEnvironment,
  TimelineLane,
  Usage,
} from '#shared/types/run'
import { plainText } from './transcript'

interface CollectedItem {
  key: string
  path: string
  kind: RunNode['kind']
  sid: string
  label: string
  meta: ClaudeSubagentMeta | null
}

/**
 * Subagent metadata is written separately from the transcript and may not exist
 * yet, so a missing or unreadable file yields `null` rather than failing.
 */
const readSubagentMeta = Effect.fn('readSubagentMeta')(function*(path: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(path).pipe(
    Effect.map((raw): ClaudeSubagentMeta | null => {
      try {
        return parseClaudeSubagentMeta(JSON.parse(raw) as unknown)
      } catch {
        return null
      }
    }),
    Effect.catchTag('PlatformError', () => Effect.succeed(null)),
  )
})

const readFirstPrompt = Effect.fn('readFirstPrompt')(function*(path: string) {
  const fs = yield* FileSystem.FileSystem
  const raw = yield* fs.readFileString(path).pipe(
    Effect.catchTag('PlatformError', () => Effect.succeed('')),
  )

  for (const line of raw.split('\n').slice(0, 61)) {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    const parsed = parseClaudeRecord(value)
    if (!parsed.success || parsed.record.kind !== 'user') continue
    const candidate = plainText(parsed.record.data.message.content)
      .replace(/<command-(?:name|message|args)>/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (candidate && !candidate.startsWith('Caveat:')) return candidate.slice(0, 100)
  }
  return ''
})

export const firstPrompt = Effect.fn('firstPrompt')(function*(path: string) {
  const cache = yield* PromptCache
  return yield* cache.get(path, readFirstPrompt(path))
})

export const collect = Effect.fn('collect')(function*(
  projectDirectory: string,
  maxAgeHours: number,
) {
  if (maxAgeHours <= 0) return []
  const fs = yield* FileSystem.FileSystem
  const now = yield* Clock.currentTimeMillis
  const cutoff = now - maxAgeHours * 3_600_000
  const names = (yield* fs.readDirectory(projectDirectory)).sort((a, b) => a.localeCompare(b))
  const items: CollectedItem[] = []

  const freshFile = Effect.fn('freshFile')(function*(path: string) {
    const info = yield* fs.stat(path)
    if (info.type !== 'File') return false
    return info.mtime._tag === 'Some' ? info.mtime.value.getTime() >= cutoff : true
  })

  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const path = join(projectDirectory, name)
    if (!(yield* freshFile(path))) continue
    const sid = name.slice(0, -'.jsonl'.length)
    items.push({
      key: sid,
      path,
      kind: 'session',
      sid,
      meta: null,
      label: (yield* firstPrompt(path)) || sid.slice(0, 8),
    })
  }

  for (const sessionName of names) {
    const subagentsDirectory = join(projectDirectory, sessionName, 'subagents')
    const subagentNames = yield* fs.readDirectory(subagentsDirectory).pipe(
      Effect.catchTag('PlatformError', () => Effect.succeed([] as Array<string>)),
    )
    for (const name of subagentNames.sort((a, b) => a.localeCompare(b))) {
      if (!name.endsWith('.jsonl')) continue
      const path = join(subagentsDirectory, name)
      if (!(yield* freshFile(path))) continue
      const agent = name.slice(0, -'.jsonl'.length)
      const meta = yield* readSubagentMeta(join(subagentsDirectory, `${agent}.meta.json`))
      items.push({
        key: `${sessionName}/${agent}`,
        path,
        kind: 'subagent',
        sid: sessionName,
        meta,
        label: meta?.description || agent,
      })
    }
  }
  return items
})

export const buildTree = Effect.fn('buildTree')(function*(
  projectDirectory: string,
  hours: number,
) {
  const cache = yield* ScanCache
  const items = yield* collect(projectDirectory, hours)
  const scans = yield* Effect.forEach(items, item => cache.get(item.path))
  const stats = yield* Effect.forEach(scans, scan => scan.stats)
  const byKey = new Map<string, RunNode>()

  for (const [index, item] of items.entries()) {
    const node: RunNode = {
      ...stats[index]!,
      key: item.key,
      kind: item.kind,
      sid: item.sid,
      label: item.label,
      agentType: item.kind === 'subagent' && item.meta
        ? item.meta.agentType
        : '',
      toolUseId: item.meta?.toolUseId || null,
      model: item.meta?.model || '',
      spawnDepth: item.meta?.spawnDepth ?? null,
      parentAgentId: item.meta?.parentAgentId || null,
      stoppedByUser: item.meta?.stoppedByUser === true,
      spawnState: '',
      children: [],
      subAgents: 0,
      subRunning: 0,
      subErrors: 0,
      subTools: 0,
      subFiles: {},
      subLast: null,
      subLive: false,
    }
    byKey.set(node.key, node)
  }

  const owner = new Map<string, string>()
  const spawnState = new Map<string, RunNode['spawnState']>()
  for (const [index, item] of items.entries()) {
    const scan = scans[index]!
    for (const id of scan.spawnIds) {
      owner.set(id, item.key)
      spawnState.set(id, scan.openTools.has(id) ? 'running' : 'returned')
    }
  }

  const roots: RunNode[] = []
  for (const node of byKey.values()) {
    node.spawnState = node.toolUseId ? spawnState.get(node.toolUseId) || '' : ''
    const parentKey = node.toolUseId ? owner.get(node.toolUseId) : undefined
    const parent = parentKey ? byKey.get(parentKey) : undefined
    if (parent && parent.key !== node.key) parent.children.push(node)
    else if (node.kind === 'subagent' && byKey.has(node.sid)) byKey.get(node.sid)!.children.push(node)
    else roots.push(node)
  }

  for (const root of roots) rollup(root)
  roots.sort((a, b) => (b.subLast || '').localeCompare(a.subLast || ''))
  return { roots, byKey, cwd: scans.find(scan => scan.cwd)?.cwd || '' }
})

export function rollup(node: RunNode): RunNode {
  let agents = 0
  let running = 0
  let errors = node.errors
  let tools = node.tools
  let last = node.lastTs || ''
  let live = node.live
  const files = Object.fromEntries(node.files.map(file => [file.path, file.ops]))

  for (const child of node.children) {
    rollup(child)
    agents += 1 + child.subAgents
    running += (child.spawnState === 'running' || child.live ? 1 : 0) + child.subRunning
    errors += child.subErrors
    tools += child.subTools
    for (const [path, operations] of Object.entries(child.subFiles)) {
      files[path] = (files[path] || 0) + operations
    }
    last = [last, child.subLast || ''].sort().at(-1) || ''
    live ||= child.subLive
  }

  node.subAgents = agents
  node.subRunning = running
  node.subErrors = errors
  node.subTools = tools
  node.subFiles = files
  node.subLast = last || null
  node.subLive = live
  node.children.sort((a, b) => (a.firstTs || '').localeCompare(b.firstTs || ''))
  return node
}

export function flatten(node: RunNode, depth = 0, output: TimelineLane[] = []): TimelineLane[] {
  output.push({
    key: node.key,
    label: node.label,
    agentType: node.agentType,
    kind: node.kind,
    depth,
    firstTs: node.firstTs,
    lastTs: node.lastTs,
    live: node.live,
    errors: node.errors,
    tools: node.tools,
    spawnState: node.spawnState,
    files: node.files.length,
  })
  for (const child of node.children) flatten(child, depth + 1, output)
  return output
}

export function rootOf(roots: RunNode[], key: string): RunNode | null {
  const contains = (node: RunNode): boolean =>
    node.key === key || node.children.some(child => contains(child))
  return roots.find(root => contains(root)) || null
}

export function runPhases(root: RunNode, limit = 16): Milestone[] {
  const phases: Milestone[] = []
  const gather = (node: RunNode): void => {
    const who = node.kind === 'subagent' ? node.label : 'main'
    phases.push(...node.milestones.map(milestone => ({ ...milestone, who })))
    node.children.forEach(gather)
  }
  gather(root)
  const selected = phases.some(phase => phase.strong)
    ? phases.filter(phase => phase.strong)
    : phases
  return selected
    .sort((a, b) => (a.ts || '').localeCompare(b.ts || ''))
    .slice(-limit)
}

export const runDiagnostics = Effect.fn('runDiagnostics')(function*(
  projectDirectory: string,
  root: RunNode,
) {
  const cache = yield* ScanCache
  const nodes: RunNode[] = []
  const gather = (node: RunNode): void => {
    nodes.push(node)
    node.children.forEach(gather)
  }
  gather(root)

  const scans = yield* Effect.forEach(nodes, node =>
    Effect.flatMap(pathFor(projectDirectory, node.key), path => cache.get(path)))
  const childByToolId = new Map<string, RunNode>()
  for (const node of nodes) {
    if (node.toolUseId) childByToolId.set(node.toolUseId, node)
  }

  const incidents: DiagnosticIncident[] = []
  const turns: RunDiagnostics['turns'] = []
  const compactions: RunDiagnostics['compactions'] = []
  const outcomes: RunDiagnostics['outcomes'] = []
  const changes: RunDiagnostics['changes'] = []
  const git: RunDiagnostics['git'] = []
  const agents: AgentDiagnosticSummary[] = []
  const usage: Usage = { in: 0, out: 0, cr: 0, cw: 0 }
  const causal = { records: 0, recordsWithUuid: 0, branchPoints: 0, sidechainRecords: 0, interruptions: 0 }
  let environment: SessionEnvironment = { cwd: '', gitBranch: '', version: '', entrypoint: '', permissionMode: '' }

  for (const [index, node] of nodes.entries()) {
    const diagnostic = scans[index]!.diagnostics()
    const who = node.kind === 'session' ? 'Main session' : node.label
    if (node.kind === 'session') environment = diagnostic.environment
    else {
      for (const key of Object.keys(environment) as Array<keyof SessionEnvironment>) {
        environment[key] ||= diagnostic.environment[key]
      }
    }

    for (const sample of diagnostic.context) {
      usage.in += sample.usage.in
      usage.out += sample.usage.out
      usage.cr += sample.usage.cr
      usage.cw += sample.usage.cw
    }
    for (const key of Object.keys(causal) as Array<keyof typeof causal>) {
      causal[key] += diagnostic.causal[key]
    }

    incidents.push(...diagnostic.incidents.map(incident => ({ ...incident, who, key: node.key })))
    if (node.stoppedByUser) {
      incidents.push({
        id: `${node.key}:stopped`,
        severity: 'warning',
        category: 'agent',
        title: 'Agent stopped by user',
        detail: node.label,
        ts: node.lastTs,
        line: node.records,
        who,
        key: node.key,
      })
    }
    turns.push(...diagnostic.turns.map(turn => ({ ...turn, who, key: node.key })))
    compactions.push(...diagnostic.compactions.map(compaction => ({ ...compaction, who, key: node.key })))
    changes.push(...diagnostic.changes.map(change => ({ ...change, who, key: node.key })))
    git.push(...diagnostic.git.map(event => ({ ...event, who, key: node.key })))
    outcomes.push(...diagnostic.outcomes.map((outcome) => {
      const child = childByToolId.get(outcome.toolUseId)
      return {
        ...outcome,
        ...(child ? { childKey: child.key, label: child.label } : {}),
      }
    }))

    const agentUsage = diagnostic.context.reduce<Usage>((total, sample) => ({
      in: total.in + sample.usage.in,
      out: total.out + sample.usage.out,
      cr: total.cr + sample.usage.cr,
      cw: total.cw + sample.usage.cw,
    }), { in: 0, out: 0, cr: 0, cw: 0 })
    agents.push({
      key: node.key,
      label: who,
      agentType: node.agentType || 'Main session',
      models: [...new Set(diagnostic.context.map(sample => sample.model).filter(Boolean))],
      efforts: [...new Set(diagnostic.context.map(sample => sample.effort).filter(Boolean))],
      usage: agentUsage,
      turns: diagnostic.turns.length,
      turnDurationMs: diagnostic.turns.reduce((total, turn) => total + turn.durationMs, 0),
      compactions: diagnostic.compactions.length,
      branchPoints: diagnostic.causal.branchPoints,
      sidechainRecords: diagnostic.causal.sidechainRecords,
    })
  }

  const byTimestamp = <T extends { ts: string | null }>(a: T, b: T): number =>
    (a.ts || '').localeCompare(b.ts || '')

  return {
    incidents: incidents.sort(byTimestamp).slice(-200),
    turns: turns.sort(byTimestamp).slice(-200),
    compactions: compactions.sort(byTimestamp).slice(-100),
    outcomes: outcomes.sort(byTimestamp).slice(-100),
    changes: changes.sort(byTimestamp).slice(-300),
    git: git.sort(byTimestamp).slice(-100),
    agents,
    environment,
    causal,
    usage,
  } satisfies RunDiagnostics
})

export function stripNode(node: RunNode): PublicRunNode {
  const { children: _children, subFiles: _subFiles, ...publicNode } = node
  return publicNode
}

/**
 * Map a run key to its transcript path.
 *
 * A run key arrives straight from a query parameter, so this is the boundary
 * that keeps a request inside the project directory. The final `resolve` check
 * is the backstop: whatever the segment rules let through, the result must
 * still live under the project root.
 */
export function pathFor(
  projectDirectory: string,
  key: string,
): Effect.Effect<string, InvalidRunKey> {
  const parts = key.split('/')
  if (parts.length > 2 || parts.some(part => !part || part === '..' || part.includes(sep))) {
    return Effect.fail(new InvalidRunKey({ key }))
  }
  const path = parts.length === 2
    ? join(projectDirectory, parts[0]!, 'subagents', `${parts[1]}.jsonl`)
    : join(projectDirectory, `${parts[0]}.jsonl`)
  const root = `${resolve(projectDirectory)}${sep}`
  if (!resolve(path).startsWith(root)) return Effect.fail(new InvalidRunKey({ key }))
  return Effect.succeed(path)
}
