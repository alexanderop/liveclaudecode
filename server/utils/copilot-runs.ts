import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Clock, Effect, Option, Result } from 'effect'
import * as Arr from 'effect/Array'
import * as FileSystem from 'effect/FileSystem'
import {
  CopilotScanCache,
  type CopilotSessionLocation,
  CopilotSessionStateDirectory,
  type CopilotSessionScan,
  VsCodeUserDataDirectories,
} from './services'
import { parseCopilotWorkspaceJson } from '#shared/schemas/copilot'
import type { RunNode } from '#shared/types/run'
import { normalizeSessionLabel } from '#shared/utils/session-label'
import { FILE_CONCURRENCY, FileDiscoveryLimiter, freshFilesIn, ignoreNotFound, statIfExists } from './filesystem-concurrency'
import { bySubLastDesc, countUnreadable, freshnessCutoff, isFreshFileInfo, selectLatestById } from './run-shared'

export interface CopilotDiscovery {
  locations: CopilotSessionLocation[]
  rootsPresent: number
  unreadable: number
}

export interface CopilotTree {
  roots: RunNode[]
  byKey: Map<string, RunNode>
  pathByKey: Map<string, string>
  locationByKey: Map<string, CopilotSessionLocation>
  scanByKey: Map<string, CopilotSessionScan>
  cwdByKey: Map<string, string>
  malformed: number
  unreadable: number
  duplicates: number
  rootsPresent: number
  genericExcluded: number
}

interface LocationResult {
  locations: CopilotSessionLocation[]
  unreadable: number
}

function applicationName(root: string): string {
  return root.includes('Code - Insiders') ? 'VS Code Insiders' : 'VS Code'
}

function normalizeWorkspace(value: string): string {
  if (!value) return ''
  if (value.startsWith('file:')) {
    try {
      return fileURLToPath(value)
    } catch {
      // A malformed or non-local URI throws TypeError (ERR_INVALID_URL /
      // ERR_INVALID_URL_SCHEME / ERR_INVALID_FILE_URL_HOST); the raw value is
      // still a usable display label, so keep it.
      return value
    }
  }
  return value
}

/** A directory that may not exist yet; `Option.none` stands in for "absent". */
const optionalDirectory = Effect.fn('optionalDirectory')(function*(path: string) {
  const fs = yield* FileSystem.FileSystem
  const limiter = yield* FileDiscoveryLimiter
  return yield* limiter.withPermit(fs.readDirectory(path)).pipe(
    Effect.map(Option.some),
    ignoreNotFound(() => Effect.succeed(Option.none<ReadonlyArray<string>>())),
  )
})

const workspaceFor = Effect.fn('workspaceFor')(function*(directory: string) {
  const fs = yield* FileSystem.FileSystem
  const limiter = yield* FileDiscoveryLimiter
  const path = join(directory, 'workspace.json')
  const raw = yield* limiter.withPermit(fs.readFileString(path)).pipe(
    ignoreNotFound(() => Effect.succeed('')),
  )
  if (!raw) return ''
  return yield* Result.match(parseCopilotWorkspaceJson(raw), {
    onSuccess: metadata => Effect.succeed(normalizeWorkspace(metadata.folder || metadata.workspace || '')),
    onFailure: error => Effect.logDebug('Failed to parse workspace.json', { path, error }).pipe(
      Effect.as(''),
    ),
  })
})

const sessionFiles = Effect.fn('sessionFiles')(function*(
  directory: string,
  application: string,
  workspace: string,
  cutoff: number,
) {
  const listed = yield* freshFilesIn(directory, name => name.endsWith('.jsonl'), cutoff).pipe(
    // A directory that does not exist yet is routine; one that cannot be read
    // counts as a single unreadable entry, as it always has.
    ignoreNotFound(() => Effect.succeed({ paths: [] as string[], unreadable: 0 })),
    Effect.catch(error => Effect.logDebug('Copilot session directory unreadable', { directory, error }).pipe(
      Effect.as({ paths: [] as string[], unreadable: 1 }),
    )),
  )
  return {
    locations: listed.paths.map(path => ({ path, application, workspace, format: 'vscode' as const })),
    unreadable: listed.unreadable,
  } satisfies LocationResult
})

const scanWorkspaceStorage = Effect.fn('scanWorkspaceStorage')(function*(
  root: string,
  storage: string,
  application: string,
  cutoff: number,
) {
  const directoryResult = yield* Effect.result(optionalDirectory(storage))
  if (Result.isFailure(directoryResult)) return { locations: [], unreadable: 1 } satisfies LocationResult
  if (Option.isNone(directoryResult.success)) return { locations: [], unreadable: 0 } satisfies LocationResult
  const [failures, perWorkspace] = yield* Effect.partition(
    directoryResult.success.value,
    name => Effect.gen(function*() {
      const directory = join(storage, name)
      const workspaceResult = yield* Effect.result(workspaceFor(directory))
      const sessions = yield* sessionFiles(
        join(directory, 'chatSessions'),
        application,
        Result.isSuccess(workspaceResult) ? workspaceResult.success : '',
        cutoff,
      )
      return {
        locations: sessions.locations,
        unreadable: sessions.unreadable + (Result.isFailure(workspaceResult) ? 1 : 0),
      } satisfies LocationResult
    }),
    { concurrency: FILE_CONCURRENCY },
  )
  return {
    locations: perWorkspace.flatMap(result => result.locations),
    unreadable: (yield* countUnreadable(`scanWorkspaceStorage(${storage})`, failures))
      + perWorkspace.reduce((total, result) => total + result.unreadable, 0),
  } satisfies LocationResult
})

const scanProfile = Effect.fn('scanProfile')(function*(
  root: string,
  profileDirectory: string,
  application: string,
  cutoff: number,
) {
  const stores = yield* Effect.all([
    sessionFiles(
      join(profileDirectory, 'globalStorage', 'emptyWindowChatSessions'),
      `${application} profile`,
      '',
      cutoff,
    ),
    scanWorkspaceStorage(
      root,
      join(profileDirectory, 'workspaceStorage'),
      `${application} profile`,
      cutoff,
    ),
  ], { concurrency: FILE_CONCURRENCY })
  return {
    locations: stores.flatMap(store => store.locations),
    unreadable: stores.reduce((total, store) => total + store.unreadable, 0),
  } satisfies LocationResult
})

const scanUserDataRoot = Effect.fn('scanUserDataRoot')(function*(root: string, cutoff: number) {
  const application = applicationName(root)
  const rootResult = yield* Effect.result(optionalDirectory(root))
  if (Result.isFailure(rootResult)) {
    return { present: false, failed: true, locations: [], unreadable: 1 }
  }
  if (Option.isNone(rootResult.success)) {
    return { present: false, failed: false, locations: [], unreadable: 0 }
  }
  const stores = yield* Effect.all([
    scanWorkspaceStorage(root, join(root, 'workspaceStorage'), application, cutoff),
    sessionFiles(join(root, 'globalStorage', 'emptyWindowChatSessions'), application, '', cutoff),
    sessionFiles(join(root, 'globalStorage', 'transferredChatSessions'), application, '', cutoff),
  ], { concurrency: FILE_CONCURRENCY })

  const profilesResult = yield* Effect.result(optionalDirectory(join(root, 'profiles')))
  const [profileFailures, profiles] = Result.isSuccess(profilesResult) && Option.isSome(profilesResult.success)
    ? yield* Effect.partition(
        profilesResult.success.value,
        name => scanProfile(root, join(root, 'profiles', name), application, cutoff),
        { concurrency: FILE_CONCURRENCY },
      )
    : [[], []] as [never[], LocationResult[]]
  return {
    present: true,
    failed: false,
    locations: [
      ...stores.flatMap(store => store.locations),
      ...profiles.flatMap(result => result.locations),
    ],
    unreadable: stores.reduce((total, store) => total + store.unreadable, 0)
      + (yield* countUnreadable(`scanUserDataRoot profiles(${root})`, profileFailures))
      + profiles.reduce((total, result) => total + result.unreadable, 0)
      + (Result.isFailure(profilesResult) ? 1 : 0),
  }
})

const scanCopilotCliRoot = Effect.fn('scanCopilotCliRoot')(function*(root: string, cutoff: number) {
  const fs = yield* FileSystem.FileSystem
  const limiter = yield* FileDiscoveryLimiter
  const rootResult = yield* Effect.result(optionalDirectory(root))
  if (Result.isFailure(rootResult)) {
    return { present: false, locations: [], unreadable: 1 }
  }
  if (Option.isNone(rootResult.success)) {
    return { present: false, locations: [], unreadable: 0 }
  }
  const [failures, entries] = yield* Effect.partition(rootResult.success.value, name => Effect.gen(function*() {
    const directory = join(root, name)
    const directoryInfo = yield* limiter.withPermit(fs.stat(directory))
    if (directoryInfo.type !== 'Directory') return Option.none<CopilotSessionLocation>()
    const path = join(directory, 'events.jsonl')
    const info = yield* limiter.withPermit(statIfExists(path))
    return Option.isSome(info) && isFreshFileInfo(info.value, cutoff)
      ? Option.some({ path, application: 'Copilot CLI', workspace: '', format: 'cli' as const })
      : Option.none<CopilotSessionLocation>()
  }), { concurrency: FILE_CONCURRENCY })
  return {
    present: true,
    locations: Arr.getSomes(entries),
    unreadable: yield* countUnreadable(`scanCopilotCliRoot(${root})`, failures),
  }
})

export const collectCopilotSessions = Effect.fn('collectCopilotSessions')(function*(maxAgeHours: number) {
  const roots = yield* VsCodeUserDataDirectories
  const cliRoot = yield* CopilotSessionStateDirectory
  const now = yield* Clock.currentTimeMillis
  const cutoff = freshnessCutoff(maxAgeHours, now)
  const [results, cli] = yield* Effect.all([
    Effect.forEach(
      roots,
      root => scanUserDataRoot(root, cutoff),
      { concurrency: FILE_CONCURRENCY },
    ),
    scanCopilotCliRoot(cliRoot, cutoff),
  ], { concurrency: FILE_CONCURRENCY })
  return {
    locations: [...results.flatMap(result => result.locations), ...cli.locations],
    rootsPresent: results.filter(result => result.present).length + (cli.present ? 1 : 0),
    unreadable: results.reduce((total, result) => total + result.unreadable, 0) + cli.unreadable,
  } satisfies CopilotDiscovery
})

export const buildCopilotTree = Effect.fn('buildCopilotTree')(function*(hours: number) {
  const cache = yield* CopilotScanCache
  const discovery = yield* collectCopilotSessions(hours)
  const [unreadableScans, readable] = yield* Effect.partition(
    discovery.locations,
    location => Effect.map(cache.get(location), scan => ({ location, scan })),
    { concurrency: FILE_CONCURRENCY },
  )
  const stats = yield* Effect.forEach(readable, item => item.scan.stats, { concurrency: 'unbounded' })
  const zipped = readable.map((item, index) => ({ ...item, stats: stats[index]! }))
  const genericExcluded = zipped.filter(item => !item.scan.supported).length
  const { selected, duplicates } = selectLatestById(
    zipped.filter(item => item.scan.supported),
    item => item.scan.sessionId || basename(item.location.path, '.jsonl'),
    item => item.stats.mtime,
  )

  const roots: RunNode[] = []
  const byKey = new Map<string, RunNode>()
  const pathByKey = new Map<string, string>()
  const locationByKey = new Map<string, CopilotSessionLocation>()
  const scanByKey = new Map<string, CopilotSessionScan>()
  const cwdByKey = new Map<string, string>()
  for (const [id, item] of selected) {
    const key = `copilot:${id}`
    const node: RunNode = {
      ...item.stats,
      source: 'copilot',
      sourceDetail: item.scan.sourceDetail,
      key,
      kind: 'session',
      sid: id,
      label: normalizeSessionLabel(item.scan.title, id.slice(0, 8)),
      title: normalizeSessionLabel(item.scan.customTitle, ''),
      openingPrompt: normalizeSessionLabel(item.scan.openingPrompt, ''),
      lastPrompt: '',
      agentType: '',
      toolUseId: null,
      model: item.scan.model,
      spawnDepth: null,
      parentAgentId: null,
      stoppedByUser: false,
      spawnState: '',
      children: [],
      subAgents: item.scan.subAgents,
      subRunning: 0,
      subErrors: item.stats.errors,
      subTools: item.stats.tools,
      subFiles: Object.fromEntries(item.stats.files.map(file => [file.path, file.ops])),
      subLast: item.stats.lastTs,
      subLive: item.stats.live,
    }
    roots.push(node)
    byKey.set(key, node)
    pathByKey.set(key, item.location.path)
    locationByKey.set(key, item.location)
    scanByKey.set(key, item.scan)
    cwdByKey.set(key, normalizeWorkspace(item.scan.workingDirectory || item.location.workspace))
  }
  roots.sort(bySubLastDesc)
  return {
    roots,
    byKey,
    pathByKey,
    locationByKey,
    scanByKey,
    cwdByKey,
    malformed: readable.reduce(
      (total, item) => total
        + item.scan.malformed
        + item.scan.malformedParts
        + item.scan.structuralMalformed,
      0,
    ),
    unreadable: discovery.unreadable
      + (yield* countUnreadable('buildCopilotTree scans', unreadableScans)),
    duplicates,
    rootsPresent: discovery.rootsPresent,
    genericExcluded,
  } satisfies CopilotTree
})

export function copilotRunDiagnostics(scan: CopilotSessionScan) {
  return scan.diagnostics()
}
