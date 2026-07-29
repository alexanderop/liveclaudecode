import { basename } from 'node:path'
import { Cache, Clock, Context, Effect, Layer, Result } from 'effect'
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
  buildTree,
  FILE_CONCURRENCY,
  flatten,
  pathFor,
  rootOf,
  runDiagnostics,
  runPhases,
  settleReturnedAgent,
  stripNode,
} from './runs'
import { projectName, resolveProjectDirectories } from './project'
import {
  CodexScanCache,
  CopilotScanCache,
  ScanCache,
  SessionLocatorCache,
  UnknownRun,
} from './services'
import type {
  EventsResponse,
  ProjectRuns,
  RunNode,
  RunResponse,
  SessionEventsResponse,
  SessionSourceStatus,
  TreeResponse,
} from '#shared/types/run'

interface ClaudeTree {
  roots: RunNode[]
  byKey: Map<string, RunNode>
  cwd: string
  malformed: number
}

type SessionLocator =
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
    }

interface SessionCatalog {
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

const UNASSIGNED_PROJECT = '__unassigned__'

function locatorKey(project: string, key: string): string {
  return `${project}\0${key}`
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
      return yield* Effect.forEach(directories, directory => Effect.gen(function*() {
        const tree = yield* buildTree(directory.directory, hours)
        return { directory: directory.directory, tree }
      }), { concurrency: FILE_CONCURRENCY })
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
    statuses.push(sourceStatus('claude', sessions, malformed))
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
      }))
    }
    if (tree.rootsPresent === 0) {
      statuses.push(sourceStatus(
        'copilot',
        0,
        0,
        'VS Code Stable and Insiders storage unavailable',
      ))
    } else {
      const suffix = tree.duplicates
        ? `; ${tree.duplicates} duplicate session${tree.duplicates === 1 ? '' : 's'} deduplicated`
        : ''
      const status = sourceStatus(
        'copilot',
        tree.roots.length,
        tree.malformed,
        '',
        tree.unreadable,
        'session file',
      )
      statuses.push(suffix
        ? { ...status, message: `${status.message}${suffix}`.replace(/^; /, '') }
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

  yield* locatorCache.replace([...locators.values()].flatMap((locator) => {
    const transcriptPath = locator.source === 'claude'
      ? ''
      : locator.tree.pathByKey.get(locator.node.key) || ''
    if (locator.source !== 'claude' && !transcriptPath) return []
    return [{
      source: locator.source,
      projectId: locator.projectId,
      key: locator.node.key,
      node: locator.node,
      projectDirectory: locator.source === 'claude' ? locator.projectDirectory : '',
      transcriptPath,
    }]
  }))

  return {
    projects: visible.map(({ id, name, roots }) => ({ id, name, roots })),
    sources: statuses,
    locators,
  } satisfies SessionCatalog
})

interface CatalogKey {
  readonly projectInput: string
  readonly hours: number
}

/**
 * Deduplicates catalog builds without ever serving a stale one.
 *
 * The UI polls the tree, run, and event endpoints on overlapping timers, so
 * several requests routinely ask for the same catalog at once. A zero
 * time-to-live makes every completed build expire immediately while concurrent
 * callers still share the single in-flight build, so responses always reflect
 * the transcripts as they are on disk. Only in-flight builds ever occupy an
 * entry, so the capacity is a formality.
 */
export class SessionCatalogCache extends Context.Service<SessionCatalogCache, {
  readonly get: (
    projectInput: string,
    hours: number,
  ) => ReturnType<typeof buildSessionCatalog>
}>()('lcc/SessionCatalogCache') {
  static readonly layer = Layer.effect(
    SessionCatalogCache,
    Effect.gen(function*() {
      const cache = yield* Cache.makeWith(
        (key: CatalogKey) => buildSessionCatalog(key.projectInput, key.hours),
        // `Cache.make` treats a literal 0 time-to-live as "not set" and would
        // cache forever, so the duration is provided as a function instead.
        { capacity: 8, timeToLive: () => 0, requireServicesAt: 'lookup' },
      )
      return SessionCatalogCache.of({
        get: (projectInput, hours) => Cache.get(cache, { projectInput, hours }),
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

function findLocator(catalog: SessionCatalog, project: string, key: string): SessionLocator | null {
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
  }
})

export const getSessionRun = Effect.fn('getSessionRun')(function*(
  projectInput: string,
  hours: number,
  project: string,
  key: string,
) {
  const catalog = yield* loadSessionCatalog(projectInput, hours)
  const locator = findLocator(catalog, project, key)
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

export const getSessionEvents = Effect.fn('getSessionEvents')(function*(
  projectInput: string,
  hours: number,
  project: string,
  key: string,
  since: number,
  revision: number,
) {
  const locatorCache = yield* SessionLocatorCache
  let location = yield* locatorCache.get(project, key)
  if (!location) {
    yield* loadSessionCatalog(projectInput, hours)
    location = yield* locatorCache.get(project, key)
  }
  if (!location) return yield* new UnknownRun({ key })

  if (location.source === 'codex') {
    const cache = yield* CodexScanCache
    const scan = yield* cache.get(location.transcriptPath)
    const node = { ...location.node, ...(yield* scan.stats) }
    return {
      key,
      events: scan.events.slice(since),
      next: scan.events.length,
      revision: 0,
      reset: false,
      node: stripNode(node),
    }
  }

  if (location.source === 'copilot') {
    const cache = yield* CopilotScanCache
    const scan = yield* cache.get({
      path: location.transcriptPath,
      application: location.node.sourceDetail.split(' · ')[0] || 'VS Code',
      workspace: location.projectId === UNASSIGNED_PROJECT ? '' : location.projectId,
    })
    const node = { ...location.node, ...(yield* scan.stats) }
    const reset = revision !== scan.eventRevision || since > scan.events.length
    return {
      key,
      events: reset ? [...scan.events] : scan.events.slice(since),
      next: scan.events.length,
      revision: scan.eventRevision,
      reset,
      node: stripNode(node),
    }
  }

  const cache = yield* ScanCache
  const scan = yield* cache.get(yield* pathFor(location.projectDirectory, key))
  const node = settleReturnedAgent({ ...location.node, ...(yield* scan.stats) })
  const childByToolId = new Map(
    location.node.children
      .filter(child => child.toolUseId)
      .map(child => [child.toolUseId!, child.key]),
  )
  const events = scan.events.slice(since).map((entry) => {
    const childKey = entry.spawn && entry.id ? childByToolId.get(entry.id) : undefined
    return childKey ? { ...entry, childKey } : entry
  })
  return {
    key,
    events,
    next: scan.events.length,
    revision: 0,
    reset: false,
    node: stripNode(node),
  }
})

export const getSessionActivity = Effect.fn('getSessionActivity')(function*(
  projectInput: string,
  hours: number,
  project: string,
  key: string,
  limit: number,
) {
  const catalog = yield* loadSessionCatalog(projectInput, hours)
  const locator = findLocator(catalog, project, key)
  if (!locator) return yield* new UnknownRun({ key })
  const root = rootOf(locator.tree.roots, key)
  if (!root) return yield* new UnknownRun({ key })

  const nodes: Array<{ node: RunNode, depth: number }> = []
  const gather = (node: RunNode, depth: number): void => {
    nodes.push({ node, depth })
    node.children.forEach(child => gather(child, depth + 1))
  }
  gather(root, 0)

  const responses = yield* Effect.forEach(
    nodes,
    ({ node }) => getSessionEvents(projectInput, hours, project, node.key, 0, 0),
    { concurrency: FILE_CONCURRENCY },
  )
  const events = responses.flatMap((response, index) => {
    const entry = nodes[index]!
    return response.events.map(event => ({
      ...event,
      agentKey: entry.node.key,
      agentLabel: entry.node.label,
      agentType: entry.node.agentType || (entry.depth ? 'Subagent' : 'Main session'),
      agentDepth: entry.depth,
    }))
  }).sort((left, right) => {
    const byTime = (left.ts || '').localeCompare(right.ts || '')
    if (byTime) return byTime
    const byDepth = (left.agentDepth || 0) - (right.agentDepth || 0)
    return byDepth || left.line - right.line
  })
  const selected = events.slice(-limit)

  return {
    key: root.key,
    events: selected,
    total: events.length,
    truncated: selected.length < events.length,
  } satisfies SessionEventsResponse
})
