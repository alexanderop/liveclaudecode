import { Effect, Semaphore } from 'effect'

/**
 * One discovery pass may traverse several nested directory levels. Every leaf
 * filesystem operation shares this budget so nested fan-outs cannot multiply
 * the number of open descriptors.
 */
export const FILE_CONCURRENCY = 16

export const makeFileDiscoveryLimiter = Effect.fn('makeFileDiscoveryLimiter')(
  function*() {
    return yield* Semaphore.make(FILE_CONCURRENCY)
  },
)

export type FileDiscoveryLimiter = Semaphore.Semaphore
