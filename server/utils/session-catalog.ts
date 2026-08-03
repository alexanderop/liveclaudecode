import { basename } from 'node:path'
import { Cache, Clock, Context, Duration, Effect, Iterable, Layer, Option, Result } from 'effect'
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
  type CopilotSessionScan,
  ScanCache,
  UnknownRun,
} from './services'
import type {
  ParseHealthResponse,
  ProjectRuns,
  PublicRunNode,
  RunNode,
  SessionEventsResponse,
  SessionParseHealth,
  SessionSourceStatus,
  TranscriptEvent,
} from '#shared/types/run'
import { PARSE_ISSUE_SAMPLE_LIMIT } from './parse-issues'
import type { TranscriptScan } from './transcript'
import {
  buildCostOverview,
  summarizeCosts,
  type CostUsageSample,
  providerCostSample,
} from './cost'
import { bySubLastDesc, visitNodes } from './run-shared'

interface ClaudeTree {
  roots: RunNode[]
  byKey: Map<string, RunNode>
  scanByKey: Map<string, TranscriptScan>
  cwd: string
  malformed: number
  unreadable: number
  costSamples: CostUsageSample[]
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
  costSamples: CostUsageSample[]
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

/** Project id under which runs without a resolvable working directory are grouped. */
export const UNASSIGNED_PROJECT = '__unassigned__'

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
  ) => Effect.Effect<Option.Option<SessionEventLocation>>
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
          if (!locations) return Option.none()
          catalogs.delete(keyForCatalog)
          catalogs.set(keyForCatalog, locations)
          if (project) return Option.fromUndefinedOr(locations.get(locatorKey(project, key)))
          const matches = [...locations.values()].filter(location => location.key === key)
          return matches.length === 1 ? Option.some(matches[0]!) : Option.none()
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

/**
 * The exact error union the three source builders can fail with. Naming it
 * lets `failureMessage` narrow on `_tag` directly instead of casting through
 * a structural `'reason' in error` check.
 */
type CatalogSourceError =
  | Effect.Error<ReturnType<typeof buildClaudeTrees>>
  | Effect.Error<ReturnType<typeof buildCodexTree>>
  | Effect.Error<ReturnType<typeof buildCopilotTree>>

function failureMessage(error: CatalogSourceError): string {
  if (error._tag === 'PlatformError') {
    return `Storage unavailable: ${error.reason._tag}`
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

/** The Claude source builder: resolve which project directories are in scope, then scan each. */
const buildClaudeTrees = Effect.fn('buildClaudeTrees')(function*(
  projectInput: string,
  hours: number,
) {
  const directories = yield* resolveProjectDirectories(projectInput)
  const trees = yield* buildTrees(
    directories.map(directory => directory.directory),
    hours,
  )
  return trees.map((tree, index) => ({
    directory: directories[index]!.directory,
    tree,
  }))
})

const buildSessionCatalog = Effect.fn('buildSessionCatalog')(function*(
  projectInput: string,
  hours: number,
) {
  const locatorCache = yield* SessionLocatorCache
  const projects = new Map<string, MutableProject>()
  const locators = new Map<string, SessionLocator>()
  const statuses: SessionSourceStatus[] = []
  const costSamples: CostUsageSample[] = []

  // The three sources read disjoint storage roots, so their scans overlap.
  const [claudeResult, codexResult, copilotResult] = yield* Effect.all([
    buildClaudeTrees(projectInput, hours),
    buildCodexTree(hours),
    buildCopilotTree(hours),
  ], { concurrency: 3, mode: 'result' })

  if (Result.isSuccess(claudeResult)) {
    let malformed = 0
    let sessions = 0
    for (const item of claudeResult.success) {
      costSamples.push(...item.tree.costSamples)
      malformed += item.tree.malformed
      sessions += item.tree.roots.length
      if (!item.tree.roots.length) continue
      const path = item.tree.cwd || item.directory
      const project = addProject(projects, path, item.tree.roots)
      for (const root of item.tree.roots) {
        visitNodes(root, node => locators.set(locatorKey(project.id, node.key), {
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
    for (const [key, scan] of tree.scanByKey) {
      costSamples.push(...scan.diagnostics().context.map(sample =>
        providerCostSample('codex', key, sample),
      ))
    }
    for (const root of tree.roots) {
      const project = addProject(projects, tree.cwdByKey.get(root.key) || '', [root])
      visitNodes(root, node => locators.set(locatorKey(project.id, node.key), {
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
    for (const [key, scan] of tree.scanByKey) {
      const diagnostic = scan.diagnostics()
      const node = tree.byKey.get(key)
      costSamples.push(providerCostSample('copilot', key, {
        ts: node?.lastTs || null,
        model: scan.model,
        usage: diagnostic.usage,
      }))
    }
    for (const root of tree.roots) {
      const project = addProject(projects, tree.cwdByKey.get(root.key) || '', [root])
      visitNodes(root, (node) => {
        // Every Copilot node the tree builder emits has a location; if one is
        // ever missing, skip the node (mirroring how a Codex node without a
        // transcript path is skipped) rather than fabricating a locator.
        const location = tree.locationByKey.get(node.key)
        if (!location) return
        locators.set(locatorKey(project.id, node.key), {
          source: 'copilot',
          projectId: project.id,
          tree,
          node,
          location,
        })
      })
    }
    if (tree.rootsPresent === 0) {
      statuses.push(sourceStatus(
        'copilot',
        0,
        0,
        'Copilot CLI and VS Code storage unavailable',
      ))
    } else {
      statuses.push(sourceStatus(
        'copilot',
        tree.roots.length,
        tree.malformed,
        '',
        tree.unreadable,
        'session file',
      ))
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
    project.roots.sort(bySubLastDesc)
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
    costSamples,
  } satisfies SessionCatalog
})

/**
 * Deduplicates catalog builds without ever serving a stale one.
 *
 * The UI polls the tree, run, and event endpoints on overlapping timers, so
 * several requests routinely ask for the same catalog at once. `Cache.get`
 * coalesces concurrent callers onto the one in-flight lookup fiber for a key,
 * and a zero time-to-live marks the entry expired the instant that fiber
 * exits — on success, on failure, or on interruption — so the next request
 * for the same key always starts a fresh build; no later request can ever
 * observe a stale result.
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
    Effect.gen(function*() {
      const cache = yield* Cache.makeWith(
        (key: string) => {
          const separator = key.indexOf('\0')
          return buildSessionCatalog(key.slice(0, separator), Number(key.slice(separator + 1)))
        },
        {
          capacity: Number.POSITIVE_INFINITY,
          timeToLive: () => Duration.zero,
          // Keep the *build's* service requirements (ScanCache, CodexScanCache,
          // SessionLocatorCache, ...) at each `Cache.get` call site rather than
          // at cache construction, since the merged layer graph only exposes
          // sibling services once every layer has finished building.
          requireServicesAt: 'lookup',
        },
      )
      return SessionCatalogCache.of({
        get: (projectInput, hours) => Cache.get(cache, catalogKey(projectInput, hours)),
        // `Cache.size` reports the raw map size, including entries whose zero
        // TTL already elapsed but that no later `Cache.get` has swept out yet.
        // `Cache.keys` is documented to evict expired entries as it filters
        // them, so it is the query that actually reflects live ownership.
        size: Effect.map(Cache.keys(cache), keys => Iterable.reduce(keys, 0, count => count + 1)),
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
  const nowMillis = yield* Clock.currentTimeMillis
  return {
    projects: catalog.projects,
    sources: catalog.sources,
    now: nowMillis / 1_000,
    hours,
    costs: summarizeCosts(
      catalog.costSamples.filter(sample => sample.source === 'claude'),
      nowMillis,
      hours,
    ),
  }
})

export const listCostOverview = Effect.fn('listCostOverview')(function*(
  projectInput: string,
  hours: number,
) {
  const catalog = yield* loadSessionCatalog(projectInput, hours)
  const nowMillis = yield* Clock.currentTimeMillis
  return buildCostOverview(catalog.costSamples, catalog.sources, nowMillis, hours)
})

/**
 * Which sessions skipped records, and why.
 *
 * The source-level `SessionSourceStatus` only carries a tally for a whole
 * provider, which cannot be acted on: it names neither the transcript nor the
 * cause. This walks the same catalog the dashboard already built and reports
 * per session, so a skipped record can be traced to a file, a line, and a
 * reason. Sessions that parsed cleanly are omitted — the page is a problem
 * list, not an inventory.
 */
export const listParseHealth = Effect.fn('listParseHealth')(function*(
  projectInput: string,
  hours: number,
) {
  const catalog = yield* loadSessionCatalog(projectInput, hours)
  const projectNames = new Map(catalog.projects.map(project => [project.id, project.name]))
  const sessions: SessionParseHealth[] = []

  for (const locator of catalog.locators.values()) {
    const scan = locator.tree.scanByKey.get(locator.node.key)
    if (!scan || !scan.parseIssues.skipped) continue
    sessions.push({
      source: locator.source,
      sourceDetail: locator.node.sourceDetail,
      projectId: locator.projectId,
      projectName: projectNames.get(locator.projectId) || locator.projectId,
      key: locator.node.key,
      label: locator.node.label,
      transcriptPath: scan.path,
      lastTs: locator.node.lastTs,
      skipped: scan.parseIssues.skipped,
      counts: scan.parseIssues.counts,
      samples: [...scan.parseIssues.samples],
    })
  }

  sessions.sort((a, b) => b.skipped - a.skipped || a.label.localeCompare(b.label))
  return {
    hours,
    sources: catalog.sources,
    sessions,
    skipped: sessions.reduce((total, session) => total + session.skipped, 0),
    sampleLimit: PARSE_ISSUE_SAMPLE_LIMIT,
  } satisfies ParseHealthResponse
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

  const copilotDiagnostics = Effect.fn('copilotDiagnostics')(function*(
    scan: CopilotSessionScan | undefined,
  ) {
    // The catalog build registers a scan for every Copilot locator; a missing
    // one means the run is no longer known rather than a server defect.
    if (!scan) return yield* new UnknownRun({ key })
    return copilotRunDiagnostics(scan)
  })
  const diagnostics = locator.source === 'claude'
    ? yield* runDiagnostics(locator.projectDirectory, root)
    : locator.source === 'codex'
      ? codexRunDiagnostics(root, locator.tree.scanByKey)
      : yield* copilotDiagnostics(locator.tree.scanByKey.get(locator.node.key))
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
  if (Option.isNone(location)) {
    yield* loadSessionCatalog(projectInput, hours)
    location = yield* locatorCache.get(projectInput, hours, project, key)
  }
  if (Option.isNone(location)) return yield* new UnknownRun({ key })

  const snapshot = yield* loadSessionEventSnapshot(location.value)
  const reset = location.value.source === 'copilot'
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
  visitNodes(root, (node, depth) => nodes.push({ node, depth }))

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
