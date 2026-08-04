import { join } from 'node:path'
import { Context, Effect, Layer, Option, Semaphore } from 'effect'
import * as Arr from 'effect/Array'
import * as FileSystem from 'effect/FileSystem'
import type * as PlatformError from 'effect/PlatformError'
import { countUnreadable, isFreshFileInfo } from './run-shared'

/**
 * One discovery pass may traverse several nested directory levels. Every leaf
 * filesystem operation shares this budget so nested fan-outs cannot multiply
 * the number of open descriptors.
 */
export const FILE_CONCURRENCY = 16

/**
 * One permit pool per runtime, not one per discovery pass.
 *
 * Concurrent tree builds and background polls all draw from this single
 * descriptor budget instead of each opening their own. It lives in the layer
 * rather than at module scope so the permits belong to the runtime that built
 * them: a test gets a fresh pool instead of drawing down one the rest of the
 * process is already using, and a lost permit cannot stall every later caller
 * in the process.
 */
export class FileDiscoveryLimiter extends Context.Service<
  FileDiscoveryLimiter,
  Semaphore.Semaphore
>()('lcc/FileDiscoveryLimiter') {
  static readonly layer = Layer.effect(FileDiscoveryLimiter, Semaphore.make(FILE_CONCURRENCY))
}

/**
 * Recover a `NotFound` platform failure with `onNotFound`; every other
 * failure — and every other reason on the same error — propagates unchanged.
 *
 * Filesystem scans and discovery walks treat a missing file or directory as
 * routine (the writer hasn't created it yet, or a project was removed), so
 * this is the one place that distinction is made.
 */
export const ignoreNotFound = <A2, E2, R2>(onNotFound: () => Effect.Effect<A2, E2, R2>) =>
  <A, R>(
    self: Effect.Effect<A, PlatformError.PlatformError, R>,
  ): Effect.Effect<A | A2, E2 | PlatformError.PlatformError, R | R2> =>
    Effect.catchReason(self, 'PlatformError', 'NotFound', onNotFound)

/**
 * `stat` a path, treating a missing file or directory as `Option.none`
 * instead of a typed failure.
 */
export const statIfExists = Effect.fn('statIfExists')(function*(path: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.stat(path).pipe(
    Effect.map(Option.some),
    ignoreNotFound(() => Effect.succeed(Option.none<FileSystem.File.Info>())),
  )
})

/** The mtime/size bookkeeping a stateful scan compares a fresh stat against. */
export interface FileChangeState {
  readonly mtime: number
  readonly lastLoadedMtime: number
  readonly lastLoadedSize: number
}

export type DetectedFileChange =
  | { readonly _tag: 'Missing' }
  | { readonly _tag: 'Unchanged', readonly mtime: number, readonly size: number }
  | { readonly _tag: 'Changed', readonly mtime: number, readonly size: number }

/**
 * Stat-based change detection shared by the incremental JSONL reader and the
 * replay-based Copilot scanners: a missing (or non-file) path is `Missing`, a
 * path whose size and mtime match the last load is `Unchanged`, and anything
 * else is `Changed` and worth reading. A stat without an mtime keeps the
 * previously observed one.
 */
export const detectFileChange = Effect.fn('detectFileChange')(function*(
  path: string,
  previous: FileChangeState,
) {
  const info = yield* statIfExists(path)
  if (Option.isNone(info) || info.value.type !== 'File') {
    return { _tag: 'Missing' } as const satisfies DetectedFileChange
  }
  const mtime = Option.match(info.value.mtime, {
    onNone: () => previous.mtime,
    onSome: value => value.getTime() / 1_000,
  })
  const size = Number(info.value.size)
  return size === previous.lastLoadedSize && mtime === previous.lastLoadedMtime
    ? { _tag: 'Unchanged', mtime, size } as const satisfies DetectedFileChange
    : { _tag: 'Changed', mtime, size } as const satisfies DetectedFileChange
})

/**
 * Whether `path` is a regular file whose mtime is at or after `cutoff`.
 * Stat failures (including a file removed mid-discovery) propagate so the
 * caller can count the entry as unreadable.
 */
export const isFreshFile = Effect.fn('isFreshFile')(function*(path: string, cutoff: number) {
  const fs = yield* FileSystem.FileSystem
  const limiter = yield* FileDiscoveryLimiter
  const info = yield* limiter.withPermit(fs.stat(path))
  return isFreshFileInfo(info, cutoff)
})

export interface FreshFiles {
  paths: string[]
  unreadable: number
}

/**
 * List the fresh regular files in `directory` whose names pass `filter`.
 *
 * A failure to read the directory itself propagates (callers decide whether a
 * missing or unreadable directory is routine); per-file stat failures are
 * logged and counted into `unreadable` instead of failing the discovery.
 */
export const freshFilesIn = Effect.fn('freshFilesIn')(function*(
  directory: string,
  filter: (name: string) => boolean,
  cutoff: number,
) {
  const fs = yield* FileSystem.FileSystem
  const limiter = yield* FileDiscoveryLimiter
  const names = yield* limiter.withPermit(fs.readDirectory(directory))
  const [failures, fresh] = yield* Effect.partition(
    names.filter(filter),
    name => Effect.gen(function*() {
      const path = join(directory, name)
      return (yield* isFreshFile(path, cutoff)) ? Option.some(path) : Option.none<string>()
    }),
    { concurrency: FILE_CONCURRENCY },
  )
  return {
    paths: Arr.getSomes(fresh),
    unreadable: yield* countUnreadable(`freshFilesIn(${directory})`, failures),
  } satisfies FreshFiles
})
