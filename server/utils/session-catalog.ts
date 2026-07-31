import { basename } from 'node:path'
import { Clock, Context, Deferred, Effect, Layer, Result } from 'effect'
import {
  buildCodexTree,
  codexRunDiagnostics,
  type CodexTree,
} from './codex-runs'
import {
  buildCopilotTree,
  copilotRunDiagnostics,
  type CopilotTree,
} from './copilot-runs'
import {
  buildTrees,
  flatten,
  pathFor,
  rootOf,
  runDiagnostics,
  runPhases,
  settleReturnedAgent,
  stripNode,
} from './runs'
import { FILE_CONCURRENCY } from './filesystem-concurrency'
import { projectName, resolveProjectDirectories } from './project'
import {
  CodexScanCache,
  CopilotScanCache,
  type CopilotSessionLocation,
  ScanCache,
  UnknownRun,
} from './services'
import type {
  ProjectRuns,
  PublicRunNode,
  RunNode,
  SessionEventsResponse,
  SessionSourceStatus,
  TranscriptEvent,
} from '#shared/types/run'

interface ClaudeTree {
  roots: RunNode[]
  byKey: Map<string, RunNode>
  cwd: string
  malformed: number
  unreadable: number
}

export type SessionLocator =
  | {
      source: 'claude'
      projectId: string
      projectDirectory: string
      tree: ClaudeTree
      node: RunNode
    }
  | {
      source: 'codex'
      projectId: string
      tree: CodexTree
      node: RunNode
    }
  | {
      source: 'copilot'
      projectId: string
      tree: CopilotTree
      node: RunNode
      location: CopilotSessionLocation
    }

export interface SessionCatalog {
  projects: ProjectRuns[]
  sources: SessionSourceStatus[]
  locators: Map<string, SessionLocator>
}

interface MutableProject {
  id: string
  name: string
  path: string
  roots: RunNode[]
}

interface SessionEventLocationBase {
  projectId: string
  key: string
  node: RunNode
}

export type SessionEventLocation =
  | SessionEventLocationBase & {
      source: 'claude'
      projectDirectory: string
    }
  | SessionEventLocationBase & {
      source: 'codex'
      transcriptPath: string
    }
  | SessionEventLocationBase & {
      source: 'copilot'
      copilotLocation: CopilotSessionLocation
    }

function sessionEventLocation(locator: SessionLocator): SessionEventLocation | undefined {
  const base = {
    projectId: locator.projectId,
    key: locator.node.key,
    node: locator.node,
  }
  if (locator.source === 'claude') {
    return { ...base, source: 'claude', projectDirectory: locator.projectDirectory }
  }
  if (locator.source === 'copilot') {
    return { ...base, source: 'copilot', copilotLocation: locator.location }
  }
  const transcriptPath = locator.tree.pathByKey.get(locator.node.key)
  return transcriptPath
    ? { ...base, source: 'codex', transcriptPath }
    : undefined
}

const SESSION_LOCATOR_CAPACITY = 8
const UNASSIGNED_PROJECT = '__unassigned__'

function locatorKey(project: string, key: string): string {
  return `${project}\0${key}`
}

function catalogKey(projectInput: string, hours: number): string {
  return `${projectInput}\0${hours}`
}

/**
 * Targeted event locators, partitioned by the same project/range key as the
 * catalog build that published them. One viewer can therefore refresh its
 * catalog without invalidating another viewer's event polling state.
 */
export class SessionLocatorCache extends Context.Service<SessionLocatorCache, {
  readonly replace: (
    projectInput: string,
    hours: number,
    locations: ReadonlyArray<SessionEventLocation>,
  ) => Effect.Effect<void>
  readonly get: (
    projectInput: string,
    hours: number,
    project: string,
    key: string,
  ) => Effect.Effect<SessionEventLocation | undefined>
}>()('lcc/SessionLocatorCache') {
  static readonly layer = Layer.effect(
    SessionLocatorCache,
    Effect.sync(() => {
      const catalogs = new Map<string, Map<string, SessionEventLocation>>()
      return SessionLocatorCache.of({
        replace: (projectInput, hours, next) => Effect.sync(() => {
          const key = catalogKey(projectInput, hours)
          catalogs.delete(key)
          catalogs.set(key, new Map(next.map(location => [
            locatorKey(location.projectId, location.key),
            location,
          ])))
          if (catalogs.size > SESSION_LOCATOR_CAPACITY) {
            const oldest = catalogs.keys().next().value
            if (oldest !== undefined) catalogs.delete(oldest)
          }
        }),
        get: (projectInput, hours, project, key) => Effect.sync(() => {
          const keyForCatalog = catalogKey(projectInput, hours)
          const locations = catalogs.get(keyForCatalog)
          if (!locations) return undefined
          catalogs.delete(keyForCatalog)
          catalogs.set(keyForCatalog, locations)
          if (project) return locations.get(locatorKey(project, key))
          const matches = [...locations.values()].filter(location => location.key === key)
          return matches.length === 1 ? matches[0] : undefined
        }),
      })
    }),
  )
}

function projectIdentity(path: string): { id: string, name: string, path: string } {
  if (!path) return { id: UNASSIGNED_PROJECT, name: 'Unassigned', path: '' }
  return { id: path, name: projectName(path), path }
}

function addProject(
  projects: Map<string, MutableProject>,
  path: string,
  roots: RunNode[],
): MutableProject {
  const identity = projectIdentity(path)
  const existing = projects.get(identity.id)
  if (existing) {
    existing.roots.push(...roots)
    return existing
  }
  const project = { ...identity, roots: [...roots] }
  projects.set(identity.id, project)
  return project
}

function failureMessage(error: { readonly _tag: string, readonly message?: string }): string {
  if (error._tag === 'PlatformError' && 'reason' in error) {
    const reason = error.reason as { readonly _tag?: string }
    return `Storage unavailable: ${reason._tag || 'filesystem error'}`
  }
  return error.message || 'Storage unavailable'
}

function sourceStatus(
  source: SessionSourceStatus['source'],
  sessions: number,
  malformed: number,
  message = '',
  unreadable = 0,
  unreadableNoun = 'rollout',
): SessionSourceStatus {
  if (message) return { source, state: 'unavailable', sessions: 0, malformed: 0, message }
  if (malformed > 0 || unreadable > 0) {
    const malformedMessage = malformed > 0
      ? malformed + ' malformed record' + (malformed === 1 ? '' : 's') + ' skipped'
      : ''
    const unreadableMessage = unreadable > 0
      ? unreadable + ` unreadable ${unreadableNoun}` + (unreadable === 1 ? '' : 's') + ' skipped'
      : ''
    return {
      source,
      state: 'degraded',
      sessions,
      malformed,
      message: [malformedMessage, unreadableMessage].filter(Boolean).join('; '),
    }
  }
  return { source, state: 'ready', sessions, malformed: 0, message: '' }
}

function matchesProjectInput(project: MutableProject, input: string): boolean {
  if (!input) return true
  if (project.roots.some(root => root.source === 'claude')) return true
  const trimmed = input.replace(/\/$/, '')
  const inputName = basename(trimmed)
  return project.id === input
    || project.path === trimmed
    || project.name === input
    || project.name === inputName
    || project.id.endsWith(`/${input}`)
}

function visit(node: RunNode, use: (node: RunNode) => void): void {
  use(node)
  node.children.forEach(child => visit(child, use))
}

const buildSessionCatalog = Effect.fn('buildSessionCatalog')(function*(
  projectInput: string,
  hours: number,
) {
  const locatorCache = yield* SessionLocatorCache
  const projects = new Map<string, MutableProject>()
  const locators = new Map<string, SessionLocator>()
  const statuses: SessionSourceStatus[] = []

  // The three sources read disjoint storage roots, so their scans overlap.
  const [claudeResult, codexResult, copilotResult] = yield* Effect.all([
    Effect.result(Effect.gen(function*() {
      const directories = yield* resolveProjectDirectories(projectInput)
      const trees = yield* buildTrees(
        directories.map(directory => directory.directory),
        hours,
      )
      return trees.map((tree, index) => ({
        directory: directories[index]!.directory,
        tree,
      }))
    })),
    Effect.result(buildCodexTree(hours)),
    Effect.result(buildCopilotTree(hours)),
  ], { concurrency: 3 })

  if (Result.isSuccess(claudeResult)) {
    let malformed = 0
    let sessions = 0
    for (const item of claudeResult.success) {
      malformed += item.tree.malformed
      sessions += item.tree.roots.length
      if (!item.tree.roots.length) continue
      const path = item.tree.cwd || item.directory
      const project = addProject(projects, path, item.tree.roots)
      for (const root of item.tree.roots) {
        visit(root, node => locators.set(locatorKey(project.id, node.key), {
          source: 'claude',
          projectId: project.id,
          projectDirectory: item.directory,
          tree: item.tree,
          node,
        }))
      }
    }
    const unreadable = claudeResult.success.reduce((total, item) => total + item.tree.unreadable, 0)
    statuses.push(sourceStatus('claude', sessions, malformed, '', unreadable, 'transcript'))
  } else {
    statuses.push(sourceStatus('claude', 0, 0, failureMessage(claudeResult.failure)))
  }

  if (Result.isSuccess(codexResult)) {
    const tree = codexResult.success
    for (const root of tree.roots) {
      const project = addProject(projects, tree.cwdByKey.get(root.key) || '', [root])
      visit(root, node => locators.set(locatorKey(project.id, node.key), {
        source: 'codex',
        projectId: project.id,
        tree,
        node,
      }))
    }
    const suffix = tree.duplicates
      ? `; ${tree.duplicates} duplicate rollout${tree.duplicates === 1 ? '' : 's'} deduplicated`
      : ''
    const status = sourceStatus('codex', tree.roots.length, tree.malformed, '', tree.unreadable)
    statuses.push(suffix ? { ...status, message: `${status.message}${suffix}`.replace(/^; /, '') } : status)
  } else {
    statuses.push(sourceStatus('codex', 0, 0, failureMessage(codexResult.failure)))
  }

  if (Result.isSuccess(copilotResult)) {
    const tree = copilotResult.success
    for (const root of tree.roots) {
      const project = addProject(projects, tree.cwdByKey.get(root.key) || '', [root])
      visit(root, node => locators.set(locatorKey(project.id, node.key), {
        source: 'copilot',
        projectId: project.id,
        tree,
        node,
        location: tree.locationByKey.get(node.key)!,
      }))
    }
    if (tree.rootsPresent === 0) {
      statuses.push(sourceStatus(
        'copilot',
        0,
        0,
        'Copilot CLI and VS Code storage unavailable',
      ))
    } else {
      const notes = [
        tree.genericExcluded
          ? `${tree.genericExcluded} non-Copilot chat session${tree.genericExcluded === 1 ? '' : 's'} excluded`
          : '',
        tree.duplicates
          ? `${tree.duplicates} duplicate session${tree.duplicates === 1 ? '' : 's'} deduplicated`
          : '',
      ].filter(Boolean)
      const status = sourceStatus(
        'copilot',
        tree.roots.length,
        tree.malformed,
        '',
        tree.unreadable,
        'session file',
      )
      statuses.push(notes.length
        ? { ...status, message: [status.message, ...notes].filter(Boolean).join('; ') }
        : status)
    }
  } else {
    statuses.push(sourceStatus('copilot', 0, 0, failureMessage(copilotResult.failure)))
  }

  const visible = [...projects.values()].filter(project => matchesProjectInput(project, projectInput))
  const visibleIds = new Set(visible.map(project => project.id))
  for (const [key, locator] of locators) {
    if (!visibleIds.has(locator.projectId)) locators.delete(key)
  }

  for (const project of visible) {
    project.roots.sort((a, b) => (b.subLast || '').localeCompare(a.subLast || ''))
  }
  visible.sort((a, b) => {
    const aLast = a.roots[0]?.subLast || ''
    const bLast = b.roots[0]?.subLast || ''
    return bLast.localeCompare(aLast) || a.name.localeCompare(b.name)
  })

  yield* locatorCache.replace(
    projectInput,
    hours,
    [...locators.values()].flatMap((locator) => {
      const location = sessionEventLocation(locator)
      return location ? [location] : []
    }),
  )

  return {
    projects: visible.map(({ id, name, roots }) => ({ id, name, roots })),
    sources: statuses,
    locators,
  } satisfies SessionCatalog
})

/**
 * Deduplicates catalog builds without ever serving a stale one.
 *
 * The UI polls the tree, run, and event endpoints on overlapping timers, so
 * several requests routinely ask for the same catalog at once. Entries are
 * removed in the build finalizer, so only in-flight work is retained and every
 * later request observes a fresh filesystem snapshot.
 */
export class SessionCatalogCache extends Context.Service<SessionCatalogCache, {
  readonly get: (
    projectInput: string,
    hours: number,
  ) => ReturnType<typeof buildSessionCatalog>
  /** Diagnostic ownership count; completed builds must leave this at zero. */
  readonly size: Effect.Effect<number>
}>()('lcc/SessionCatalogCache') {
  static readonly layer = Layer.effect(
    SessionCatalogCache,
    Effect.sync(() => {
      type BuildError = ReturnType<typeof buildSessionCatalog> extends
        Effect.Effect<unknown, infer Error, unknown> ? Error : never
      const inFlight = new Map<string, Deferred.Deferred<SessionCatalog, BuildError>>()
      return SessionCatalogCache.of({
        get: (projectInput, hours) => Effect.uninterruptibleMask(restore =>
          Effect.gen(function*() {
            const key = catalogKey(projectInput, hours)
            const candidate = yield* Deferred.make<SessionCatalog, BuildError>()
            const selected = yield* Effect.sync(() => {
              const existing = inFlight.get(key)
              if (existing) return { deferred: existing, owner: false } as const
              inFlight.set(key, candidate)
              return { deferred: candidate, owner: true } as const
            })
            if (!selected.owner) return yield* restore(Deferred.await(selected.deferred))
            return yield* restore(buildSessionCatalog(projectInput, hours)).pipe(
              Effect.onExit(exit => Effect.gen(function*() {
                yield* Deferred.done(candidate, exit)
                yield* Effect.sync(() => {
                  if (inFlight.get(key) === candidate) inFlight.delete(key)
                })
              })),
            )
          }),
        ),
        size: Effect.sync(() => inFlight.size),
      })
    }),
  )
}

export const loadSessionCatalog = Effect.fn('loadSessionCatalog')(function*(
  projectInput: string,
  hours: number,
) {
  const cache = yield* SessionCatalogCache
  return yield* cache.get(projectInput, hours)
})

export function findSessionLocator(
  catalog: SessionCatalog,
  project: string,
  key: string,
): SessionLocator | null {
  if (project) return catalog.locators.get(locatorKey(project, key)) || null
  const matches = [...catalog.locators.values()].filter(locator => locator.node.key === key)
  return matches.length === 1 ? matches[0]! : null
}

export const listSessions = Effect.fn('listSessions')(function*(
  projectInput: string,
  hours: number,
) {
  const catalog = yield* loadSessionCatalog(projectInput, hours)
  return {
    projects: catalog.projects,
    sources: catalog.sources,
    now: (yield* Clock.currentTimeMillis) / 1_000,
    hours,
  }
})

export const getSessionRun = Effect.fn('getSessionRun')(function*(
  projectInput: string,
  hours: number,
  project: string,
  key: string,
) {
  const catalog = yield* loadSessionCatalog(projectInput, hours)
  const locator = findSessionLocator(catalog, project, key)
  if (!locator) return yield* new UnknownRun({ key })
  const root = rootOf(locator.tree.roots, key)
  if (!root) return yield* new UnknownRun({ key })

  const diagnostics = locator.source === 'claude'
    ? yield* runDiagnostics(locator.projectDirectory, root)
    : locator.source === 'codex'
      ? codexRunDiagnostics(root, locator.tree.scanByKey)
      : copilotRunDiagnostics(locator.tree.scanByKey.get(locator.node.key)!)
  const transcriptPath = locator.source === 'claude'
    ? yield* pathFor(locator.projectDirectory, locator.node.key)
    : locator.tree.pathByKey.get(locator.node.key) || ''

  return {
    key,
    transcriptPath,
    lanes: flatten(root),
    files: Object.entries(root.subFiles).sort((a, b) => b[1] - a[1]),
    phases: runPhases(root),
    diagnostics,
    node: stripNode(locator.node),
    root: stripNode(root),
  }
})

interface SessionEventSnapshot {
  events: TranscriptEvent[]
  revision: number
  node: PublicRunNode
  decorate: (events: TranscriptEvent[]) => TranscriptEvent[]
}

const loadSessionEventSnapshot = Effect.fn('loadSessionEventSnapshot')(function*(
  location: SessionEventLocation,
) {
  if (location.source === 'codex') {
    const cache = yield* CodexScanCache
    const scan = yield* cache.get(location.transcriptPath)
    const node = { ...location.node, ...(yield* scan.stats) }
    return {
      events: scan.events,
      revision: 0,
      node: stripNode(node),
      decorate: (events: TranscriptEvent[]) => events,
    } satisfies SessionEventSnapshot
  }

  if (location.source === 'copilot') {
    const cache = yield* CopilotScanCache
    const scan = yield* cache.get(location.copilotLocation)
    const node = { ...location.node, ...(yield* scan.stats) }
    return {
      events: scan.events,
      revision: scan.eventRevision,
      node: stripNode(node),
      decorate: (events: TranscriptEvent[]) => events,
    } satisfies SessionEventSnapshot
  }

  const cache = yield* ScanCache
  const scan = yield* cache.get(yield* pathFor(location.projectDirectory, location.key))
  const node = settleReturnedAgent({ ...location.node, ...(yield* scan.stats) })
  const childByToolId = new Map(
    location.node.children
      .filter(child => child.toolUseId)
      .map(child => [child.toolUseId!, child.key]),
  )
  return {
    events: scan.events,
    revision: 0,
    node: stripNode(node),
    decorate: events => events.map((entry) => {
      const childKey = entry.spawn && entry.id ? childByToolId.get(entry.id) : undefined
      return childKey ? { ...entry, childKey } : entry
    }),
  } satisfies SessionEventSnapshot
})

export const getSessionEvents = Effect.fn('getSessionEvents')(function*(
  projectInput: string,
  hours: number,
  project: string,
  key: string,
  since: number,
  revision: number,
) {
  const locatorCache = yield* SessionLocatorCache
  let location = yield* locatorCache.get(projectInput, hours, project, key)
  if (!location) {
    yield* loadSessionCatalog(projectInput, hours)
    location = yield* locatorCache.get(projectInput, hours, project, key)
  }
  if (!location) return yield* new UnknownRun({ key })

  const snapshot = yield* loadSessionEventSnapshot(location)
  const reset = location.source === 'copilot'
    && (revision !== snapshot.revision || since > snapshot.events.length)
  const events = reset ? [...snapshot.events] : snapshot.events.slice(since)
  return {
    key,
    events: snapshot.decorate(events),
    next: snapshot.events.length,
    revision: snapshot.revision,
    reset,
    node: snapshot.node,
  }
})

interface SessionEventTail {
  events: TranscriptEvent[]
  total: number
}

interface ActivityHeapEntry {
  event: TranscriptEvent
  eventIndex: number
  streamIndex: number
}

function compareActivityEvents(left: TranscriptEvent, right: TranscriptEvent): number {
  const byTime = (left.ts || '').localeCompare(right.ts || '')
  if (byTime) return byTime
  const byDepth = (left.agentDepth || 0) - (right.agentDepth || 0)
  return byDepth || left.line - right.line
}

function compareActivityEntries(left: ActivityHeapEntry, right: ActivityHeapEntry): number {
  const byEvent = compareActivityEvents(left.event, right.event)
  if (byEvent) return byEvent
  const byStream = left.streamIndex - right.streamIndex
  return byStream || left.eventIndex - right.eventIndex
}

type HeapComparator<A> = (left: A, right: A) => number

function pushHeap<A>(heap: A[], entry: A, compare: HeapComparator<A>): void {
  heap.push(entry)
  let index = heap.length - 1
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2)
    if (compare(heap[parent]!, entry) >= 0) break
    heap[index] = heap[parent]!
    index = parent
  }
  heap[index] = entry
}

function popHeap<A>(heap: A[], compare: HeapComparator<A>): A | undefined {
  const first = heap[0]
  const last = heap.pop()
  if (first === undefined || last === undefined || heap.length === 0) return first

  let index = 0
  while (true) {
    const left = index * 2 + 1
    if (left >= heap.length) break
    const right = left + 1
    const child = right < heap.length
      && compare(heap[right]!, heap[left]!) > 0
      ? right
      : left
    if (compare(last, heap[child]!) >= 0) break
    heap[index] = heap[child]!
    index = child
  }
  heap[index] = last
  return first
}

function selectActivityTail(
  events: ReadonlyArray<TranscriptEvent>,
  limit: number,
): TranscriptEvent[] {
  if (limit <= 0) return []
  const oldestFirst = (left: ActivityHeapEntry, right: ActivityHeapEntry): number =>
    compareActivityEntries(right, left)
  const heap: ActivityHeapEntry[] = []
  events.forEach((event, eventIndex) => {
    const entry = { event, eventIndex, streamIndex: 0 }
    if (heap.length < limit) {
      pushHeap(heap, entry, oldestFirst)
      return
    }
    if (compareActivityEntries(entry, heap[0]!) <= 0) return
    popHeap(heap, oldestFirst)
    pushHeap(heap, entry, oldestFirst)
  })
  return heap.sort(compareActivityEntries).map(entry => entry.event)
}

function mergeActivityTails(
  streams: ReadonlyArray<ReadonlyArray<TranscriptEvent>>,
  limit: number,
): TranscriptEvent[] {
  if (limit <= 0) return []
  const heap: ActivityHeapEntry[] = []
  streams.forEach((events, streamIndex) => {
    const eventIndex = events.length - 1
    const event = events[eventIndex]
    if (event) pushHeap(heap, { event, eventIndex, streamIndex }, compareActivityEntries)
  })

  const newestFirst: TranscriptEvent[] = []
  while (heap.length > 0 && newestFirst.length < limit) {
    const entry = popHeap(heap, compareActivityEntries)!
    newestFirst.push(entry.event)
    const eventIndex = entry.eventIndex - 1
    const event = streams[entry.streamIndex]?.[eventIndex]
    if (event) {
      pushHeap(heap, {
        event,
        eventIndex,
        streamIndex: entry.streamIndex,
      }, compareActivityEntries)
    }
  }
  return newestFirst.reverse()
}

const getSessionEventTail = Effect.fn('getSessionEventTail')(function*(
  locator: SessionLocator,
  limit: number,
) {
  const location = sessionEventLocation(locator)
  if (!location) return yield* new UnknownRun({ key: locator.node.key })
  const snapshot = yield* loadSessionEventSnapshot(location)
  return {
    events: snapshot.decorate(selectActivityTail(snapshot.events, limit)),
    total: snapshot.events.length,
  } satisfies SessionEventTail
})

export const getSessionActivity = Effect.fn('getSessionActivity')(function*(
  projectInput: string,
  hours: number,
  project: string,
  key: string,
  limit: number,
) {
  const catalog = yield* loadSessionCatalog(projectInput, hours)
  const locator = findSessionLocator(catalog, project, key)
  if (!locator) return yield* new UnknownRun({ key })
  const root = rootOf(locator.tree.roots, key)
  if (!root) return yield* new UnknownRun({ key })

  const nodes: Array<{ node: RunNode, depth: number }> = []
  const gather = (node: RunNode, depth: number): void => {
    nodes.push({ node, depth })
    node.children.forEach(child => gather(child, depth + 1))
  }
  gather(root, 0)

  const tails = yield* Effect.forEach(
    nodes,
    ({ node }) => {
      const nodeLocator = catalog.locators.get(locatorKey(locator.projectId, node.key))
      return nodeLocator
        ? getSessionEventTail(nodeLocator, limit)
        : Effect.fail(new UnknownRun({ key: node.key }))
    },
    { concurrency: FILE_CONCURRENCY },
  )
  const streams = tails.map((tail, index) => {
    const entry = nodes[index]!
    return tail.events.map(event => ({
      ...event,
      agentKey: entry.node.key,
      agentLabel: entry.node.label,
      agentType: entry.node.agentType || (entry.depth ? 'Subagent' : 'Main session'),
      agentDepth: entry.depth,
    }))
  })
  const events = mergeActivityTails(streams, limit)
  const total = tails.reduce((count, tail) => count + tail.total, 0)

  return {
    key: root.key,
    events,
    total,
    truncated: events.length < total,
  } satisfies SessionEventsResponse
})
