import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context, Effect, Layer, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type * as PlatformError from 'effect/PlatformError'
import { NodeFileSystem } from '@effect/platform-node'
import { TranscriptScan } from './transcript'

/**
 * Root of Claude Code's transcript store.
 *
 * A `Context.Reference` rather than a plain constant so tests can point it at a
 * fixture directory without every function having to thread it through as a
 * parameter.
 */
export const ProjectsDirectory = Context.Reference<string>(
  'lcc/ProjectsDirectory',
  { defaultValue: () => join(homedir(), '.claude', 'projects') },
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

/** Everything the server needs, backed by the real filesystem. */
export const AppLayer = Layer.mergeAll(
  ScanCache.layer,
  PromptCache.layer,
).pipe(Layer.provideMerge(NodeFileSystem.layer))
