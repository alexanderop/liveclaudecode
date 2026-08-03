import { join, resolve, sep } from 'node:path'
import { Clock, Effect, Option, Result } from 'effect'
import * as Arr from 'effect/Array'
import * as FileSystem from 'effect/FileSystem'
import { parseClaudeSubagentMetaJson, type ClaudeSubagentMeta } from '#shared/schemas/claude'
import { InvalidRunKey, PromptCache, ScanCache } from './services'
import type {
  Milestone,
  PublicRunNode,
  RunDiagnostics,
  RunNode,
  SessionEnvironment,
  TimelineLane,
} from '#shared/types/run'
import { normalizeSessionLabel } from '#shared/utils/session-label'
import { FILE_CONCURRENCY, FileDiscoveryLimiter, ignoreNotFound, isFreshFile } from './filesystem-concurrency'
import { addParseIssueCounts } from './parse-issues'
import { claudeCostSample, estimateCosts, type ClaudeCostSample } from './cost'
import {
  addUsage,
  byTimestamp,
  bySubLastDesc,
  countUnreadable,
  emptyRunDiagnostics,
  emptyUsage,
  finishRunDiagnostics,
  freshnessCutoff,
  mergeScanDiagnostics,
  visitNodes,
} from './run-shared'

interface CollectedItem {
  key: string
  path: string
  kind: RunNode['kind']
  sid: string
  /**
   * The label discovery can derive without a scan: the opening prompt for a
   * session, the spawn description for a subagent. `buildTree` upgrades it to
   * a recorded title once the scan is available.
   */
  label: string
  /** The session's opening prompt, blank when it had none and for subagents. */
  openingPrompt: string
  meta: ClaudeSubagentMeta | null
}

interface CollectedItems {
  items: CollectedItem[]
  unreadable: number
}

/**
 * Subagent metadata is written separately from the transcript and may not exist
 * yet, so a missing file yields `null`. Other storage failures stay typed. A
 * malformed file also yields `null`, after logging why it was rejected.
 */
const readSubagentMeta = Effect.fn('readSubagentMeta')(function*(path: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(path).pipe(
    Effect.flatMap(raw => Result.match(parseClaudeSubagentMetaJson(raw), {
      onSuccess: (meta): Effect.Effect<ClaudeSubagentMeta | null> => Effect.succeed(meta),
      onFailure: error => Effect.logDebug('Failed to parse subagent meta', { path, error }).pipe(
        Effect.as(null),
      ),
    })),
    ignoreNotFound(() => Effect.succeed(null)),
  )
})

export const firstPrompt = Effect.fn('firstPrompt')(function*(path: string) {
  const cache = yield* PromptCache
  return yield* cache.get(path).pipe(ignoreNotFound(() => Effect.succeed('')))
})

export const collect = Effect.fn('collect')(function*(
  projectDirectory: string,
  maxAgeHours: number,
) {
  const fs = yield* FileSystem.FileSystem
  const limiter = yield* FileDiscoveryLimiter
  const now = yield* Clock.currentTimeMillis
  const cutoff = freshnessCutoff(maxAgeHours, now)
  const names = (yield* limiter.withPermit(fs.readDirectory(projectDirectory)).pipe(
    ignoreNotFound(() => Effect.succeed([] as Array<string>)),
  )).sort((a, b) => a.localeCompare(b))

  const [sessionFailures, sessions] = yield* Effect.partition(
    names.filter(name => name.endsWith('.jsonl')),
    name => Effect.gen(function*() {
      const path = join(projectDirectory, name)
      if (!(yield* isFreshFile(path, cutoff))) return Option.none<CollectedItem>()
      const sid = name.slice(0, -'.jsonl'.length)
      const openingPrompt = normalizeSessionLabel(
        yield* limiter.withPermit(firstPrompt(path)),
        '',
      )
      return Option.some({
        key: sid,
        path,
        kind: 'session',
        sid,
        meta: null,
        openingPrompt,
        label: openingPrompt || sid.slice(0, 8),
      } satisfies CollectedItem)
    }),
    { concurrency: FILE_CONCURRENCY },
  )

  const [subagentDirFailures, subagentDirs] = yield* Effect.partition(
    names.filter(name => !name.endsWith('.jsonl')),
    sessionName => Effect.gen(function*() {
      const sessionDirectory = join(projectDirectory, sessionName)
      const info = yield* limiter.withPermit(fs.stat(sessionDirectory))
      if (info.type !== 'Directory') {
        return { items: [], unreadable: 0 } satisfies CollectedItems
      }
      const subagentsDirectory = join(sessionDirectory, 'subagents')
      const subagentNames = yield* limiter.withPermit(fs.readDirectory(subagentsDirectory)).pipe(
        ignoreNotFound(() => Effect.succeed([] as Array<string>)),
      )
      const [subagentFailures, subagents] = yield* Effect.partition(
        subagentNames.filter(name => name.endsWith('.jsonl')).sort((a, b) => a.localeCompare(b)),
        name => Effect.gen(function*() {
          const path = join(subagentsDirectory, name)
          if (!(yield* isFreshFile(path, cutoff))) return Option.none<CollectedItem>()
          const agent = name.slice(0, -'.jsonl'.length)
          const meta = yield* limiter.withPermit(
            readSubagentMeta(join(subagentsDirectory, `${agent}.meta.json`)),
          )
          return Option.some({
            key: `${sessionName}/${agent}`,
            path,
            kind: 'subagent',
            sid: sessionName,
            meta,
            openingPrompt: '',
            label: normalizeSessionLabel(meta?.description || '', agent),
          } satisfies CollectedItem)
        }),
      )
      return {
        items: Arr.getSomes(subagents),
        unreadable: yield* countUnreadable(`collect subagents(${subagentsDirectory})`, subagentFailures),
      } satisfies CollectedItems
    }),
    { concurrency: FILE_CONCURRENCY },
  )

  return {
    items: [
      ...Arr.getSomes(sessions),
      ...subagentDirs.flatMap(result => result.items),
    ],
    unreadable: (yield* countUnreadable(`collect sessions(${projectDirectory})`, sessionFailures))
      + (yield* countUnreadable(`collect subagent directories(${projectDirectory})`, subagentDirFailures))
      + subagentDirs.reduce((total, result) => total + result.unreadable, 0),
  } satisfies CollectedItems
})

export const buildTree = Effect.fn('buildTree')(function*(
  projectDirectory: string,
  hours: number,
) {
  const cache = yield* ScanCache
  const limiter = yield* FileDiscoveryLimiter
  const discovery = yield* collect(projectDirectory, hours)
  const [unreadableScans, readable] = yield* Effect.partition(
    discovery.items,
    item => Effect.map(limiter.withPermit(cache.get(item.path)), scan => ({ item, scan })),
    { concurrency: FILE_CONCURRENCY },
  )
  const items = readable.map(entry => entry.item)
  const scans = readable.map(entry => entry.scan)
  const stats = yield* Effect.forEach(scans, scan => scan.stats, { concurrency: 'unbounded' })
  const costSamples = scans.flatMap((scan, index) =>
    scan.diagnostics().context.map(sample => claudeCostSample(sample, items[index]!.key)),
  )
  const byKey = new Map<string, RunNode>()

  for (const [index, item] of items.entries()) {
    const scan = scans[index]!
    // A subagent's transcript carries the parent session's title records, so
    // only a session takes its title from the scan; a subagent keeps the
    // description it was spawned with.
    const title = item.kind === 'session'
      ? normalizeSessionLabel(scan.title, '')
      : ''
    const node: RunNode = {
      ...stats[index]!,
      source: 'claude',
      sourceDetail: 'Claude Code',
      key: item.key,
      kind: item.kind,
      sid: item.sid,
      label: title || item.label,
      title,
      openingPrompt: item.openingPrompt,
      lastPrompt: item.kind === 'session'
        ? normalizeSessionLabel(scan.lastPrompt, '')
        : '',
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
      // Background launches resolve their tool call instantly, so an async
      // spawn stays running until its task-notification arrives.
      spawnState.set(id, scan.openTools.has(id) || scan.asyncSpawns.has(id) ? 'running' : 'returned')
    }
  }

  const roots: RunNode[] = []
  for (const node of byKey.values()) {
    node.spawnState = node.toolUseId ? spawnState.get(node.toolUseId) || '' : ''
    settleReturnedAgent(node)
    const parentKey = node.toolUseId ? owner.get(node.toolUseId) : undefined
    const parent = parentKey ? byKey.get(parentKey) : undefined
    if (parent && parent.key !== node.key) parent.children.push(node)
    else if (node.kind === 'subagent' && byKey.has(node.sid)) byKey.get(node.sid)!.children.push(node)
    else roots.push(node)
  }

  for (const root of roots) rollup(root)
  roots.sort(bySubLastDesc)
  return {
    roots,
    byKey,
    // Keyed like the other two sources' trees, so the catalog can attribute a
    // skipped record to the session whose transcript it came from.
    scanByKey: new Map(items.map((item, index) => [item.key, scans[index]!])),
    cwd: scans.find(scan => scan.cwd)?.cwd || '',
    malformed: scans.reduce((total, scan) => total + scan.malformed, 0),
    unreadable: discovery.unreadable
      + (yield* countUnreadable(`buildTree scans(${projectDirectory})`, unreadableScans)),
    costSamples,
  }
})

export const buildTrees = Effect.fn('buildTrees')(function*(
  projectDirectories: ReadonlyArray<string>,
  hours: number,
) {
  return yield* Effect.forEach(
    projectDirectories,
    directory => buildTree(directory, hours),
    { concurrency: FILE_CONCURRENCY },
  )
})

/**
 * A completed Agent tool result is stronger evidence than a recently touched
 * subagent transcript. Without this override, returned workers appear active
 * for the entire mtime-based liveness window.
 */
export function settleReturnedAgent(node: RunNode): RunNode {
  if (node.kind === 'subagent' && node.spawnState === 'returned') {
    node.live = false
    node.current = null
  }
  return node
}

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
  visitNodes(root, (node) => {
    const who = node.kind === 'subagent' ? node.label : 'main'
    phases.push(...node.milestones.map(milestone => ({ ...milestone, who })))
  })
  const selected = phases.some(phase => phase.strong)
    ? phases.filter(phase => phase.strong)
    : phases
  return selected
    .sort(byTimestamp)
    .slice(-limit)
}

export const runDiagnostics = Effect.fn('runDiagnostics')(function*(
  projectDirectory: string,
  root: RunNode,
) {
  const cache = yield* ScanCache
  const nodes: RunNode[] = []
  visitNodes(root, node => nodes.push(node))

  const scans = yield* Effect.forEach(
    nodes,
    node => Effect.flatMap(pathFor(projectDirectory, node.key), path => cache.get(path)),
    { concurrency: FILE_CONCURRENCY },
  )
  const childByToolId = new Map<string, RunNode>()
  for (const node of nodes) {
    if (node.toolUseId) childByToolId.set(node.toolUseId, node)
  }

  const aggregate = emptyRunDiagnostics()
  const costSamples: ClaudeCostSample[] = []

  for (const [index, node] of nodes.entries()) {
    const scan = scans[index]!
    addParseIssueCounts(aggregate.parse.counts, scan.parseIssues.counts)
    aggregate.parse.skipped += scan.parseIssues.skipped
    const diagnostic = scan.diagnostics()
    costSamples.push(...diagnostic.context.map(sample => claudeCostSample(sample)))
    const who = node.kind === 'session' ? 'Main session' : node.label
    if (node.kind === 'session') aggregate.environment = diagnostic.environment
    else {
      for (const key of Object.keys(aggregate.environment) as Array<keyof SessionEnvironment>) {
        aggregate.environment[key] ||= diagnostic.environment[key]
      }
    }

    mergeScanDiagnostics(aggregate, diagnostic, who, node.key)
    if (node.stoppedByUser) {
      aggregate.incidents.push({
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
    aggregate.outcomes.push(...diagnostic.outcomes.map((outcome) => {
      const child = childByToolId.get(outcome.toolUseId)
      return {
        ...outcome,
        ...(child ? { childKey: child.key, label: child.label } : {}),
      }
    }))

    const agentUsage = emptyUsage()
    for (const sample of diagnostic.context) addUsage(agentUsage, sample.usage)
    aggregate.agents.push({
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

  return {
    ...finishRunDiagnostics(aggregate),
    cost: estimateCosts(costSamples),
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
