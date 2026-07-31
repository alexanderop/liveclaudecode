import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Context, Effect, Layer, Schema, Semaphore } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type * as PlatformError from 'effect/PlatformError'
import { TranscriptScan } from './transcript'
import { CodexTranscriptScan } from './codex-transcript'
import { CopilotCliTranscriptScan } from './copilot-cli-transcript'
import { CopilotTranscriptScan } from './copilot-transcript'

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
  readonly refresh: Effect.Effect<A, PlatformError.PlatformError, FileSystem.FileSystem>
}

interface ScanEntry<A> {
  readonly scan: A
  readonly semaphore: Semaphore.Semaphore
}

/**
 * Refresh one mutable scanner at a time for each transcript path.
 *
 * Tree, run, and event requests overlap in production. Without this per-entry
 * permit, two refreshes can observe the same byte offset and ingest one append
 * twice before either publishes its new offset.
 */
function refreshCachedScan<A extends RefreshableScan<A>>(
  entries: Map<string, ScanEntry<A>>,
  key: string,
  create: () => A,
): Effect.Effect<A, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.suspend(() => {
    let entry = entries.get(key)
    if (!entry) {
      entry = {
        scan: create(),
        semaphore: Semaphore.makeUnsafe(1),
      }
      entries.set(key, entry)
    }
    return entry.semaphore.withPermit(entry.scan.refresh)
  })
}

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
  readonly peek: (path: string) => Effect.Effect<TranscriptScan | undefined>
}>()('lcc/ScanCache') {
  static readonly layer = Layer.effect(
    ScanCache,
    Effect.sync(() => {
      const entries = new Map<string, ScanEntry<TranscriptScan>>()
      return ScanCache.of({
        get: path => refreshCachedScan(entries, path, () => new TranscriptScan(path)),
        peek: path => Effect.sync(() => entries.get(path)?.scan),
      })
    }),
  )
}

/** Incrementally parsed Codex rollout files, scoped to the provided Layer. */
export class CodexScanCache extends Context.Service<CodexScanCache, {
  readonly get: (
    path: string,
  ) => Effect.Effect<CodexTranscriptScan, PlatformError.PlatformError, FileSystem.FileSystem>
  readonly peek: (path: string) => Effect.Effect<CodexTranscriptScan | undefined>
}>()('lcc/CodexScanCache') {
  static readonly layer = Layer.effect(
    CodexScanCache,
    Effect.sync(() => {
      const entries = new Map<string, ScanEntry<CodexTranscriptScan>>()
      return CodexScanCache.of({
        get: path => refreshCachedScan(entries, path, () => new CodexTranscriptScan(path)),
        peek: path => Effect.sync(() => entries.get(path)?.scan),
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
  readonly peek: (path: string) => Effect.Effect<CopilotSessionScan | undefined>
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
        peek: path => Effect.sync(() => entries.get(path)?.scan),
      })
    }),
  )
}

/**
 * First user prompt per transcript. Immutable once read, so it is cached for
 * the lifetime of the layer.
 */
export class PromptCache extends Context.Service<PromptCache, {
  readonly get: (
    path: string,
    read: Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem>,
  ) => Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem>
}>()('lcc/PromptCache') {
  static readonly layer = Layer.effect(
    PromptCache,
    Effect.sync(() => {
      const prompts = new Map<string, string>()
      return PromptCache.of({
        get: Effect.fn('PromptCache.get')(function*(path, read) {
          const cached = prompts.get(path)
          if (cached !== undefined) return cached
          const text = yield* read
          prompts.set(path, text)
          return text
        }),
      })
    }),
  )
}

// The full server layer is composed once in ./runtime, where catalog and chat
// services join these provider/storage services.
