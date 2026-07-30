import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Context, Effect, Layer, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type * as PlatformError from 'effect/PlatformError'
import { TranscriptScan } from './transcript'
import { CodexTranscriptScan } from './codex-transcript'
import { CopilotCliTranscriptScan } from './copilot-cli-transcript'
import { CopilotTranscriptScan } from './copilot-transcript'
import type { RunNode, SessionSource } from '#shared/types/run'

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
      const scans = new Map<string, TranscriptScan>()
      return ScanCache.of({
        get: Effect.fn('ScanCache.get')(function*(path: string) {
          let scan = scans.get(path)
          if (!scan) {
            scan = new TranscriptScan(path)
            scans.set(path, scan)
          }
          return yield* scan.refresh
        }),
        peek: (path: string) => Effect.sync(() => scans.get(path)),
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
      const scans = new Map<string, CodexTranscriptScan>()
      return CodexScanCache.of({
        get: Effect.fn('CodexScanCache.get')(function*(path: string) {
          let scan = scans.get(path)
          if (!scan) {
            scan = new CodexTranscriptScan(path)
            scans.set(path, scan)
          }
          return yield* scan.refresh
        }),
        peek: (path: string) => Effect.sync(() => scans.get(path)),
      })
    }),
  )
}

export type CopilotSessionScan = CopilotTranscriptScan | CopilotCliTranscriptScan

/** Incrementally replayed Copilot CLI and VS Code logs, keyed by session path. */
export class CopilotScanCache extends Context.Service<CopilotScanCache, {
  readonly get: (location: {
    path: string
    application: string
    workspace: string
    format?: 'vscode' | 'cli'
  }) => Effect.Effect<CopilotSessionScan, PlatformError.PlatformError, FileSystem.FileSystem>
  readonly peek: (path: string) => Effect.Effect<CopilotSessionScan | undefined>
}>()('lcc/CopilotScanCache') {
  static readonly layer = Layer.effect(
    CopilotScanCache,
    Effect.sync(() => {
      const scans = new Map<string, CopilotSessionScan>()
      return CopilotScanCache.of({
        get: Effect.fn('CopilotScanCache.get')(function*(location) {
          let scan = scans.get(location.path)
          if (!scan) {
            scan = location.format === 'cli'
              ? new CopilotCliTranscriptScan(location.path, location.application, location.workspace)
              : new CopilotTranscriptScan(location.path, location.application, location.workspace)
            scans.set(location.path, scan)
          }
          return yield* scan.refresh
        }),
        peek: path => Effect.sync(() => scans.get(path)),
      })
    }),
  )
}

export interface SessionEventLocation {
  source: SessionSource
  projectId: string
  key: string
  node: RunNode
  projectDirectory: string
  transcriptPath: string
}

/**
 * Lightweight locators published by the latest tree scan.
 *
 * Event polling uses this index to refresh only the selected transcript rather
 * than rediscovering and rebuilding every session on each two-second poll.
 */
export class SessionLocatorCache extends Context.Service<SessionLocatorCache, {
  readonly replace: (locations: ReadonlyArray<SessionEventLocation>) => Effect.Effect<void>
  readonly get: (project: string, key: string) => Effect.Effect<SessionEventLocation | undefined>
}>()('lcc/SessionLocatorCache') {
  static readonly layer = Layer.effect(
    SessionLocatorCache,
    Effect.sync(() => {
      let locations = new Map<string, SessionEventLocation>()
      const indexKey = (project: string, key: string): string => `${project}\0${key}`
      return SessionLocatorCache.of({
        replace: next => Effect.sync(() => {
          locations = new Map(next.map(location => [
            indexKey(location.projectId, location.key),
            location,
          ]))
        }),
        get: (project, key) => Effect.sync(() => {
          if (project) return locations.get(indexKey(project, key))
          const matches = [...locations.values()].filter(location => location.key === key)
          return matches.length === 1 ? matches[0] : undefined
        }),
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
    read: Effect.Effect<string, never, FileSystem.FileSystem>,
  ) => Effect.Effect<string, never, FileSystem.FileSystem>
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

// The full server layer is composed once in ./runtime, which is also where
// the SessionCatalogCache defined in ./session-browser joins these services
// (importing it here would create a services ↔ session-browser cycle).
