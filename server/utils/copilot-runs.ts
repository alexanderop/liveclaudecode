import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Clock, Effect, Option, Result } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { FILE_CONCURRENCY } from './runs'
import {
  CopilotScanCache,
  type CopilotSessionLocation,
  CopilotSessionStateDirectory,
  type CopilotSessionScan,
  VsCodeUserDataDirectories,
} from './services'
import { parseCopilotWorkspace } from '#shared/schemas/copilot'
import type { RunNode, TranscriptStats } from '#shared/types/run'
import { normalizeSessionLabel } from '#shared/utils/session-label'

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

interface SelectedSession {
  location: CopilotSessionLocation
  scan: CopilotSessionScan
  stats: TranscriptStats
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
      return value
    }
  }
  return value
}

const optionalDirectory = Effect.fn('optionalDirectory')(function*(path: string) {
  const fs = yield* FileSystem.FileSystem
  const result = yield* Effect.result(fs.readDirectory(path))
  if (Result.isSuccess(result)) return { exists: true, names: result.success }
  if (result.failure.reason._tag === 'NotFound') return { exists: false, names: [] }
  return yield* result.failure
})

const workspaceFor = Effect.fn('workspaceFor')(function*(directory: string) {
  const fs = yield* FileSystem.FileSystem
  const path = join(directory, 'workspace.json')
  const result = yield* Effect.result(fs.readFileString(path))
  if (Result.isFailure(result)) {
    if (result.failure.reason._tag === 'NotFound') return ''
    return yield* result.failure
  }
  let value: unknown
  try {
    value = JSON.parse(result.success) as unknown
  } catch {
    return ''
  }
  const metadata = parseCopilotWorkspace(value)
  return normalizeWorkspace(metadata?.folder || metadata?.workspace || '')
})

const sessionFiles = Effect.fn('sessionFiles')(function*(
  directory: string,
  application: string,
  workspace: string,
  cutoff: number,
) {
  const fs = yield* FileSystem.FileSystem
  const directoryResult = yield* Effect.result(optionalDirectory(directory))
  if (Result.isFailure(directoryResult)) return { locations: [], unreadable: 1 } satisfies LocationResult
  if (!directoryResult.success.exists) return { locations: [], unreadable: 0 } satisfies LocationResult
  const names = directoryResult.success.names.filter(name => name.endsWith('.jsonl'))
  const results = yield* Effect.forEach(names, name => Effect.result(Effect.gen(function*() {
    const path = join(directory, name)
    const info = yield* fs.stat(path)
    if (info.type !== 'File') return []
    const fresh = Option.match(info.mtime, {
      onNone: () => true,
      onSome: value => value.getTime() >= cutoff,
    })
    return fresh ? [{ path, application, workspace, format: 'vscode' as const }] : []
  })), { concurrency: 'unbounded' })
  return {
    locations: results.flatMap(result => Result.isSuccess(result) ? result.success : []),
    unreadable: results.filter(Result.isFailure).length,
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
  if (!directoryResult.success.exists) return { locations: [], unreadable: 0 } satisfies LocationResult
  const results = yield* Effect.forEach(directoryResult.success.names, name => Effect.result(Effect.gen(function*() {
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
  })), { concurrency: 'unbounded' })
  return {
    locations: results.flatMap(result => Result.isSuccess(result) ? result.success.locations : []),
    unreadable: results.reduce(
      (total, result) => total + (Result.isSuccess(result) ? result.success.unreadable : 1),
      0,
    ),
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
    scanWorkspaceStorage(root, join(profileDirectory, 'workspaceStorage'), `${application} profile`, cutoff),
  ], { concurrency: 'unbounded' })
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
  if (!rootResult.success.exists) {
    return { present: false, failed: false, locations: [], unreadable: 0 }
  }
  const stores = yield* Effect.all([
    scanWorkspaceStorage(root, join(root, 'workspaceStorage'), application, cutoff),
    sessionFiles(join(root, 'globalStorage', 'emptyWindowChatSessions'), application, '', cutoff),
    sessionFiles(join(root, 'globalStorage', 'transferredChatSessions'), application, '', cutoff),
  ], { concurrency: 'unbounded' })

  const profilesResult = yield* Effect.result(optionalDirectory(join(root, 'profiles')))
  const profiles = Result.isSuccess(profilesResult) && profilesResult.success.exists
    ? yield* Effect.forEach(
        profilesResult.success.names,
        name => Effect.result(scanProfile(root, join(root, 'profiles', name), application, cutoff)),
        { concurrency: 'unbounded' },
      )
    : []
  return {
    present: true,
    failed: false,
    locations: [
      ...stores.flatMap(store => store.locations),
      ...profiles.flatMap(result => Result.isSuccess(result) ? result.success.locations : []),
    ],
    unreadable: stores.reduce((total, store) => total + store.unreadable, 0)
      + profiles.reduce(
        (total, result) => total + (Result.isSuccess(result) ? result.success.unreadable : 1),
        0,
      )
      + (Result.isFailure(profilesResult) ? 1 : 0),
  }
})

const scanCopilotCliRoot = Effect.fn('scanCopilotCliRoot')(function*(root: string, cutoff: number) {
  const fs = yield* FileSystem.FileSystem
  const rootResult = yield* Effect.result(optionalDirectory(root))
  if (Result.isFailure(rootResult)) {
    return { present: false, locations: [], unreadable: 1 }
  }
  if (!rootResult.success.exists) {
    return { present: false, locations: [], unreadable: 0 }
  }
  const results = yield* Effect.forEach(rootResult.success.names, name => Effect.result(Effect.gen(function*() {
    const directory = join(root, name)
    const directoryInfo = yield* fs.stat(directory)
    if (directoryInfo.type !== 'Directory') return []
    const path = join(directory, 'events.jsonl')
    const infoResult = yield* Effect.result(fs.stat(path))
    if (Result.isFailure(infoResult)) {
      if (infoResult.failure.reason._tag === 'NotFound') return []
      return yield* infoResult.failure
    }
    if (infoResult.success.type !== 'File') return []
    const fresh = Option.match(infoResult.success.mtime, {
      onNone: () => true,
      onSome: value => value.getTime() >= cutoff,
    })
    return fresh
      ? [{ path, application: 'Copilot CLI', workspace: '', format: 'cli' as const }]
      : []
  })), { concurrency: 'unbounded' })
  return {
    present: true,
    locations: results.flatMap(result => Result.isSuccess(result) ? result.success : []),
    unreadable: results.filter(Result.isFailure).length,
  }
})

export const collectCopilotSessions = Effect.fn('collectCopilotSessions')(function*(maxAgeHours: number) {
  const roots = yield* VsCodeUserDataDirectories
  const cliRoot = yield* CopilotSessionStateDirectory
  const now = yield* Clock.currentTimeMillis
  const cutoff = maxAgeHours <= 0 ? Number.NEGATIVE_INFINITY : now - maxAgeHours * 3_600_000
  const [results, cli] = yield* Effect.all([
    Effect.forEach(roots, root => scanUserDataRoot(root, cutoff), { concurrency: 'unbounded' }),
    scanCopilotCliRoot(cliRoot, cutoff),
  ], { concurrency: 'unbounded' })
  return {
    locations: [...results.flatMap(result => result.locations), ...cli.locations],
    rootsPresent: results.filter(result => result.present).length + (cli.present ? 1 : 0),
    unreadable: results.reduce((total, result) => total + result.unreadable, 0) + cli.unreadable,
  } satisfies CopilotDiscovery
})

export const buildCopilotTree = Effect.fn('buildCopilotTree')(function*(hours: number) {
  const cache = yield* CopilotScanCache
  const discovery = yield* collectCopilotSessions(hours)
  const results = yield* Effect.forEach(
    discovery.locations,
    location => Effect.result(cache.get(location)),
    { concurrency: FILE_CONCURRENCY },
  )
  const readable = results.flatMap((result, index) => Result.isSuccess(result)
    ? [{ location: discovery.locations[index]!, scan: result.success }]
    : [])
  const stats = yield* Effect.forEach(readable, item => item.scan.stats)
  const selected = new Map<string, SelectedSession>()
  let duplicates = 0
  let genericExcluded = 0

  readable.forEach((item, index) => {
    if (!item.scan.supported) {
      genericExcluded += 1
      return
    }
    const id = item.scan.sessionId || basename(item.location.path, '.jsonl')
    if (!id) return
    const candidate = { ...item, stats: stats[index]! }
    const existing = selected.get(id)
    if (existing) {
      duplicates += 1
      if (candidate.stats.mtime > existing.stats.mtime) selected.set(id, candidate)
    } else {
      selected.set(id, candidate)
    }
  })

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
      agentType: '',
      toolUseId: null,
      model: item.scan.model,
      spawnDepth: null,
      parentAgentId: null,
      stoppedByUser: false,
      spawnState: '',
      children: [],
      subAgents: 0,
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
  roots.sort((a, b) => (b.subLast || '').localeCompare(a.subLast || ''))
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
    unreadable: discovery.unreadable + results.filter(Result.isFailure).length,
    duplicates,
    rootsPresent: discovery.rootsPresent,
    genericExcluded,
  } satisfies CopilotTree
})

export function copilotRunDiagnostics(scan: CopilotSessionScan) {
  return scan.diagnostics()
}
