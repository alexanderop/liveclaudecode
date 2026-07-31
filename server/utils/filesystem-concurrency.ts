import { Context, Effect, Option, Semaphore } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type * as PlatformError from 'effect/PlatformError'

/**
 * One discovery pass may traverse several nested directory levels. Every leaf
 * filesystem operation shares this budget so nested fan-outs cannot multiply
 * the number of open descriptors.
 */
export const FILE_CONCURRENCY = 16

/**
 * One semaphore for the whole process, not one per discovery pass.
 *
 * A `Context.Reference` rather than a per-call constructor: its default value
 * is computed once and reused by every subsequent lookup that doesn't
 * override it, so concurrent tree builds and background polls all draw from
 * the same descriptor budget instead of each opening their own.
 */
export const FileDiscoveryLimiter = Context.Reference<Semaphore.Semaphore>(
  'lcc/FileDiscoveryLimiter',
  { defaultValue: () => Semaphore.makeUnsafe(FILE_CONCURRENCY) },
)

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
