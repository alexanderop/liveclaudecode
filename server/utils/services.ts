import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Cache, Clock, Context, Duration, Effect, Exit, Layer, Option, Schema, Semaphore } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type * as PlatformError from 'effect/PlatformError'
import { parseClaudeRecord } from '#shared/schemas/claude'
import { normalizeSessionLabel } from '#shared/utils/session-label'
import { TranscriptScan } from './transcript'
import { CodexTranscriptScan } from './codex-transcript'
import { CopilotCliTranscriptScan } from './copilot-cli-transcript'
import { CopilotTranscriptScan } from './copilot-transcript'
import { readHead } from './incremental-jsonl'
import { plainText } from './transcript-content'

/**
 * Root of Claude Code's transcript store.
 *
 * A `Context.Reference` rather than a plain constant so tests can point it at a
 * fixture directory without every function having to thread it through as a
 * parameter.
 */
export const ProjectsDirectory = Context.Reference<string>(
  'lcc/ProjectsDirectory',
  {
    defaultValue: () => process.env.LCC_CLAUDE_PROJECTS
      || join(homedir(), '.claude', 'projects'),
  },
)

/** Root shared by Codex CLI, desktop, exec sessions, and subagents. */
export const CodexSessionsDirectory = Context.Reference<string>(
  'lcc/CodexSessionsDirectory',
  {
    defaultValue: () => process.env.LCC_CODEX_SESSIONS
      || join(homedir(), '.codex', 'sessions'),
  },
)

/** VS Code user-data roots whose local chat session stores may be inspected. */
export const VsCodeUserDataDirectories = Context.Reference<ReadonlyArray<string>>(
  'lcc/VsCodeUserDataDirectories',
  {
    defaultValue: () => process.env.LCC_VSCODE_USER_DATA
      ? process.env.LCC_VSCODE_USER_DATA.split(delimiter).filter(Boolean)
      : [
          join(homedir(), 'Library', 'Application Support', 'Code', 'User'),
          join(homedir(), 'Library', 'Application Support', 'Code - Insiders', 'User'),
        ],
  },
)

/** Root of GitHub Copilot CLI's append-only local session event logs. */
export const CopilotSessionStateDirectory = Context.Reference<string>(
  'lcc/CopilotSessionStateDirectory',
  {
    defaultValue: () => process.env.LCC_COPILOT_SESSIONS
      || join(homedir(), '.copilot', 'session-state'),
  },
)

/** The process working directory, as a service so tests can override it. */
export const WorkingDirectory = Context.Reference<string>(
  'lcc/WorkingDirectory',
  { defaultValue: () => process.cwd() },
)

export class NoTranscriptsFound extends Schema.TaggedErrorClass<NoTranscriptsFound>()(
  'NoTranscriptsFound',
  { directory: Schema.String },
) {
  override get message(): string {
    return `No transcripts found under ${this.directory}`
  }
}

export class UnknownProject extends Schema.TaggedErrorClass<UnknownProject>()(
  'UnknownProject',
  { input: Schema.String, directory: Schema.String },
) {
  override get message(): string {
    return `No transcripts for ${JSON.stringify(this.input)} under ${this.directory}`
  }
}

/** A key that is malformed or escapes the project directory — a bad request. */
export class InvalidRunKey extends Schema.TaggedErrorClass<InvalidRunKey>()(
  'InvalidRunKey',
  { key: Schema.String },
) {
  override get message(): string {
    return 'Invalid run key'
  }
}

/** A well-formed key that matches no run — not found, distinct from malformed. */
export class UnknownRun extends Schema.TaggedErrorClass<UnknownRun>()(
  'UnknownRun',
  { key: Schema.String },
) {
  override get message(): string {
    return 'Unknown run key'
  }
}

interface RefreshableScan<A> {
  readonly refresh: () => Effect.Effect<A, PlatformError.PlatformError, FileSystem.FileSystem>
}

interface ScanEntry<A> {
  readonly scan: A
  readonly semaphore: Semaphore.Semaphore
  users: number
  lastAccess: number
}

const SCAN_CACHE_CAPACITY = 64
const SCAN_CACHE_IDLE_TTL_MILLIS = 30 * 60 * 1_000
const PROMPT_CACHE_CAPACITY = 256

function trimScanEntries<A>(
  entries: Map<string, ScanEntry<A>>,
  now: number,
  maximumSize: number,
): void {
  for (const [key, entry] of entries) {
    if (
      entry.users === 0
      && now - entry.lastAccess >= SCAN_CACHE_IDLE_TTL_MILLIS
    ) {
      entries.delete(key)
    }
  }
  if (entries.size <= maximumSize) return
  const idle = [...entries.entries()]
    .filter((entry): entry is [string, ScanEntry<A>] => entry[1].users === 0)
    .sort((left, right) => left[1].lastAccess - right[1].lastAccess)
  for (const [key] of idle) {
    if (entries.size <= maximumSize) break
    entries.delete(key)
  }
}

/**
 * Refresh one mutable scanner at a time for each transcript path.
 *
 * Tree, run, and event requests overlap in production. Without this per-entry
 * permit, two refreshes can observe the same byte offset and ingest one append
 * twice before either publishes its new offset.
 */
const refreshCachedScan = Effect.fn('refreshCachedScan')(function*<A extends RefreshableScan<A>>(
  entries: Map<string, ScanEntry<A>>,
  key: string,
  create: () => A,
): Effect.fn.Return<A, PlatformError.PlatformError, FileSystem.FileSystem> {
  const startedAt = yield* Clock.currentTimeMillis
  let entry = entries.get(key)
  if (!entry) {
    trimScanEntries(entries, startedAt, SCAN_CACHE_CAPACITY - 1)
    entry = {
      scan: create(),
      semaphore: Semaphore.makeUnsafe(1),
      users: 0,
      lastAccess: startedAt,
    }
    entries.set(key, entry)
  }
  entry.users += 1
  entry.lastAccess = startedAt
  const active = entry

  return yield* active.semaphore.withPermit(active.scan.refresh()).pipe(
    Effect.ensuring(Effect.gen(function*() {
      const finishedAt = yield* Clock.currentTimeMillis
      active.users -= 1
      active.lastAccess = finishedAt
      trimScanEntries(entries, finishedAt, SCAN_CACHE_CAPACITY)
    })),
  )
})

const peekCachedScan = Effect.fn('peekCachedScan')(function*<A>(
  entries: Map<string, ScanEntry<A>>,
  key: string,
): Effect.fn.Return<Option.Option<A>> {
  const now = yield* Clock.currentTimeMillis
  trimScanEntries(entries, now, SCAN_CACHE_CAPACITY)
  return Option.fromUndefinedOr(entries.get(key)?.scan)
})

/**
 * Incrementally-parsed transcripts, keyed by path.
 *
 * The cache lives inside the service instance rather than in a module-level
 * `Map`, so providing the layer per test replaces the old `resetScanCache()`.
 */
export class ScanCache extends Context.Service<ScanCache, {
  readonly get: (
    path: string,
  ) => Effect.Effect<TranscriptScan, PlatformError.PlatformError, FileSystem.FileSystem>
  readonly peek: (path: string) => Effect.Effect<Option.Option<TranscriptScan>>
}>()('lcc/ScanCache') {
  static readonly layer = Layer.effect(
    ScanCache,
    Effect.sync(() => {
      const entries = new Map<string, ScanEntry<TranscriptScan>>()
      return ScanCache.of({
        get: path => refreshCachedScan(entries, path, () => new TranscriptScan(path)),
        peek: path => peekCachedScan(entries, path),
      })
    }),
  )
}

/** Incrementally parsed Codex rollout files, scoped to the provided Layer. */
export class CodexScanCache extends Context.Service<CodexScanCache, {
  readonly get: (
    path: string,
  ) => Effect.Effect<CodexTranscriptScan, PlatformError.PlatformError, FileSystem.FileSystem>
  readonly peek: (path: string) => Effect.Effect<Option.Option<CodexTranscriptScan>>
}>()('lcc/CodexScanCache') {
  static readonly layer = Layer.effect(
    CodexScanCache,
    Effect.sync(() => {
      const entries = new Map<string, ScanEntry<CodexTranscriptScan>>()
      return CodexScanCache.of({
        get: path => refreshCachedScan(entries, path, () => new CodexTranscriptScan(path)),
        peek: path => peekCachedScan(entries, path),
      })
    }),
  )
}

export type CopilotSessionScan = CopilotTranscriptScan | CopilotCliTranscriptScan

export interface CopilotSessionLocation {
  path: string
  application: string
  workspace: string
  format: 'vscode' | 'cli'
}

/** Incrementally replayed Copilot CLI and VS Code logs, keyed by session path. */
export class CopilotScanCache extends Context.Service<CopilotScanCache, {
  readonly get: (
    location: CopilotSessionLocation,
  ) => Effect.Effect<CopilotSessionScan, PlatformError.PlatformError, FileSystem.FileSystem>
  readonly peek: (path: string) => Effect.Effect<Option.Option<CopilotSessionScan>>
}>()('lcc/CopilotScanCache') {
  static readonly layer = Layer.effect(
    CopilotScanCache,
    Effect.sync(() => {
      const entries = new Map<string, ScanEntry<CopilotSessionScan>>()
      return CopilotScanCache.of({
        get: location => refreshCachedScan(
          entries,
          location.path,
          () => location.format === 'cli'
            ? new CopilotCliTranscriptScan(location.path, location.application, location.workspace)
            : new CopilotTranscriptScan(location.path, location.application, location.workspace),
        ),
        peek: path => peekCachedScan(entries, path),
      })
    }),
  )
}

/**
 * The first prompt appears within the first records of a transcript, so only
 * this much of the file is read when labelling a session.
 */
const FIRST_PROMPT_BYTES = 256 * 1_024

/**
 * Read the first user prompt out of a transcript file, for use as a session
 * label. Lives here (rather than in `./runs`) so `PromptCache.layer` can bake
 * it in as the cache's lookup function.
 */
const readFirstPrompt = Effect.fn('readFirstPrompt')(function*(path: string) {
  const raw = yield* readHead(path, FIRST_PROMPT_BYTES)

  for (const line of raw.split('\n', 61)) {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    const parsed = parseClaudeRecord(value)
    if (!parsed.success || parsed.record.kind !== 'user') continue
    const candidate = normalizeSessionLabel(plainText(parsed.record.data.message.content))
    if (candidate) return candidate
  }
  return ''
})

/**
 * First user prompt per transcript. Values are immutable once read; the
 * process keeps only the most recently requested paths.
 */
export class PromptCache extends Context.Service<PromptCache, {
  readonly get: (path: string) => Effect.Effect<string, PlatformError.PlatformError>
}>()('lcc/PromptCache') {
  static readonly layer = Layer.effect(
    PromptCache,
    Effect.gen(function*() {
      const cache = yield* Cache.makeWith(readFirstPrompt, {
        capacity: PROMPT_CACHE_CAPACITY,
        // Failed lookups (a transient read error, a not-yet-flushed file) are
        // never worth caching: the next request should retry, not repeat the
        // failure until the entry is evicted.
        timeToLive: exit => Exit.isSuccess(exit) ? Duration.infinity : Duration.zero,
      })
      return PromptCache.of({
        get: path => Cache.get(cache, path),
      })
    }),
  )
}

// The full server layer is composed once in ./runtime, where catalog and chat
// services join these provider/storage services.
