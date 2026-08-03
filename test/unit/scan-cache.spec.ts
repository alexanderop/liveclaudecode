import { assert, describe, it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Layer, Option } from 'effect'
import { TestClock } from 'effect/testing'
import { PromptCache, ScanCache, ScanCacheCapacity } from '#server/utils/services'
import * as claude from '../fixtures/transcripts'
import { testFileSystem } from '../fixtures/filesystem'

const PATH = '/claude/projects/repo/session.jsonl'
/**
 * Eviction is exercised at a deliberately small capacity so a test needs a
 * handful of transcripts rather than one per production cache slot.
 */
const CAPACITY = 64
const capacity = Layer.succeed(ScanCacheCapacity)(CAPACITY)
const cachePath = (index: number) => `/claude/projects/repo/session-${index}.jsonl`
const transcriptTree = (count: number) => Object.fromEntries(
  Array.from({ length: count }, (_, index) => [
    cachePath(index),
    claude.transcript([claude.userText(`Prompt ${index}`)]),
  ]),
)

describe('transcript scan cache', () => {
  it.effect('serializes concurrent refreshes for one transcript path', () => {
    let activeReads = 0
    let maximumActiveReads = 0
    let reads = 0

    const beforeRead = () => Effect.gen(function*() {
      activeReads += 1
      maximumActiveReads = Math.max(maximumActiveReads, activeReads)
      yield* Effect.yieldNow
      activeReads -= 1
    })

    return Effect.gen(function*() {
      const cache = yield* ScanCache
      const scans = yield* Effect.all(
        [cache.get(PATH), cache.get(PATH)],
        { concurrency: 2 },
      )

      assert.strictEqual(scans[0], scans[1])
      assert.strictEqual(reads, 1)
      assert.strictEqual(maximumActiveReads, 1)
      assert.strictEqual(scans[0]?.events.length, 1)
    }).pipe(Effect.provide(Layer.mergeAll(
      ScanCache.layer,
      testFileSystem({
        [PATH]: claude.transcript([
          claude.userText('One prompt'),
        ]),
      }, {
        beforeRead,
        onRead: () => { reads += 1 },
      }),
    )))
  })

  it.effect('evicts the least recently used idle scan at capacity', () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(0)
      const cache = yield* ScanCache
      for (let index = 0; index < CAPACITY; index += 1) {
        yield* TestClock.setTime(index)
        yield* cache.get(cachePath(index))
      }

      yield* TestClock.setTime(100)
      const promoted = yield* cache.get(cachePath(0))
      yield* TestClock.setTime(101)
      yield* cache.get(cachePath(CAPACITY))

      assert.strictEqual(Option.getOrUndefined(yield* cache.peek(cachePath(0))), promoted)
      assert.isTrue(Option.isNone(yield* cache.peek(cachePath(1))))
      assert.isTrue(Option.isSome(yield* cache.peek(cachePath(CAPACITY))))
    }).pipe(Effect.provide(Layer.mergeAll(
      ScanCache.layer,
      capacity,
      testFileSystem(transcriptTree(CAPACITY + 1)),
    ))))

  it.effect('expires an idle scan after thirty minutes', () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(0)
      const cache = yield* ScanCache
      const scan = yield* cache.get(PATH)

      yield* TestClock.setTime(30 * 60 * 1_000 - 1)
      assert.strictEqual(Option.getOrUndefined(yield* cache.peek(PATH)), scan)
      yield* TestClock.setTime(30 * 60 * 1_000)
      assert.isTrue(Option.isNone(yield* cache.peek(PATH)))
    }).pipe(Effect.provide(Layer.mergeAll(
      ScanCache.layer,
      testFileSystem({
        [PATH]: claude.transcript([claude.userText('One prompt')]),
      }),
    ))))

  it.effect('never evicts a scan with an active refresh', () => {
    let readStarted!: Deferred.Deferred<void>
    let releaseRead!: Deferred.Deferred<void>
    const beforeRead = (path: string) => path === cachePath(0)
      ? Effect.gen(function*() {
          yield* Deferred.succeed(readStarted, undefined)
          yield* Deferred.await(releaseRead)
        })
      : Effect.void

    return Effect.gen(function*() {
      readStarted = yield* Deferred.make<void>()
      releaseRead = yield* Deferred.make<void>()
      const cache = yield* ScanCache
      const active = yield* Effect.forkChild(cache.get(cachePath(0)))
      yield* Deferred.await(readStarted)

      for (let index = 1; index <= CAPACITY; index += 1) {
        yield* cache.get(cachePath(index))
      }
      assert.isTrue(Option.isSome(yield* cache.peek(cachePath(0))))

      yield* Deferred.succeed(releaseRead, undefined)
      const scan = yield* Fiber.join(active)
      assert.strictEqual(Option.getOrUndefined(yield* cache.peek(cachePath(0))), scan)
    }).pipe(Effect.provide(Layer.mergeAll(
      ScanCache.layer,
      capacity,
      testFileSystem(transcriptTree(CAPACITY + 1), { beforeRead }),
    )))
  })

  it.effect('releases ownership when a queued same-path refresh is interrupted', () => {
    let readStarted!: Deferred.Deferred<void>
    let releaseRead!: Deferred.Deferred<void>
    const beforeRead = (path: string) => path === cachePath(0)
      ? Effect.gen(function*() {
          yield* Deferred.succeed(readStarted, undefined)
          yield* Deferred.await(releaseRead)
        })
      : Effect.void

    return Effect.gen(function*() {
      yield* TestClock.setTime(0)
      readStarted = yield* Deferred.make<void>()
      releaseRead = yield* Deferred.make<void>()
      const cache = yield* ScanCache
      const active = yield* Effect.forkChild(cache.get(cachePath(0)))
      yield* Deferred.await(readStarted)
      const queued = yield* Effect.forkChild(cache.get(cachePath(0)))
      yield* Effect.yieldNow
      yield* Fiber.interrupt(queued)
      yield* Deferred.succeed(releaseRead, undefined)
      yield* Fiber.join(active)

      for (let index = 1; index <= CAPACITY; index += 1) {
        yield* TestClock.setTime(index)
        yield* cache.get(cachePath(index))
      }
      assert.isTrue(Option.isNone(yield* cache.peek(cachePath(0))))
    }).pipe(Effect.provide(Layer.mergeAll(
      ScanCache.layer,
      capacity,
      testFileSystem(transcriptTree(CAPACITY + 1), { beforeRead }),
    )))
  })

  it.effect('releases ownership when a refresh fails', () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(0)
      const cache = yield* ScanCache
      yield* cache.get(cachePath(0)).pipe(Effect.flip)

      for (let index = 1; index <= CAPACITY; index += 1) {
        yield* TestClock.setTime(index)
        yield* cache.get(cachePath(index))
      }
      assert.isTrue(Option.isNone(yield* cache.peek(cachePath(0))))
    }).pipe(Effect.provide(Layer.mergeAll(
      ScanCache.layer,
      capacity,
      testFileSystem(transcriptTree(CAPACITY + 1), { denied: [cachePath(0)] }),
    ))))

  it.effect('converges to capacity after one more simultaneous refresh than fits', () => {
    let allReadsStarted!: Deferred.Deferred<void>
    let releaseReads!: Deferred.Deferred<void>
    let started = 0
    const beforeRead = () => Effect.gen(function*() {
      started += 1
      if (started === CAPACITY + 1) yield* Deferred.succeed(allReadsStarted, undefined)
      yield* Deferred.await(releaseReads)
    })

    return Effect.gen(function*() {
      allReadsStarted = yield* Deferred.make<void>()
      releaseReads = yield* Deferred.make<void>()
      const cache = yield* ScanCache
      const paths = Array.from({ length: CAPACITY + 1 }, (_, index) => cachePath(index))
      const refreshing = yield* Effect.forkChild(
        Effect.forEach(paths, path => cache.get(path), { concurrency: CAPACITY + 1 }),
      )
      yield* Deferred.await(allReadsStarted)
      yield* Deferred.succeed(releaseReads, undefined)
      yield* Fiber.join(refreshing)

      const retained = yield* Effect.forEach(paths, path => cache.peek(path))
      assert.strictEqual(retained.filter(Option.isSome).length, CAPACITY)
    }).pipe(Effect.provide(Layer.mergeAll(
      ScanCache.layer,
      capacity,
      testFileSystem(transcriptTree(CAPACITY + 1), { beforeRead }),
    )))
  })
})

describe('prompt cache', () => {
  const promptPath = (index: number) => `/claude/projects/repo/prompt-${index}.jsonl`
  const promptTree = (count: number) => Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      promptPath(index),
      claude.transcript([claude.userText(`Prompt ${index}`)]),
    ]),
  )

  it.effect('retains only the 256 most recently used prompts', () => {
    const reads = new Map<string, number>()
    const onRead = (path: string) => reads.set(path, (reads.get(path) ?? 0) + 1)

    return Effect.gen(function*() {
      const cache = yield* PromptCache
      for (let index = 0; index < 256; index += 1) {
        assert.strictEqual(yield* cache.get(promptPath(index)), `Prompt ${index}`)
      }

      // Touch prompt-0 again so it becomes the most recently used entry.
      assert.strictEqual(yield* cache.get(promptPath(0)), 'Prompt 0')
      assert.strictEqual(reads.get(promptPath(0)), 1)

      // Filling one more slot evicts the least recently used entry, prompt-1,
      // but prompt-0 survives because it was just promoted.
      yield* cache.get(promptPath(256))
      yield* cache.get(promptPath(0))
      assert.strictEqual(reads.get(promptPath(0)), 1)

      yield* cache.get(promptPath(1))
      assert.strictEqual(reads.get(promptPath(1)), 2)
    }).pipe(Effect.provide(
      PromptCache.layer.pipe(Layer.provideMerge(testFileSystem(promptTree(257), { onRead }))),
    ))
  })

  it.effect('coalesces concurrent lookups for the same path', () => {
    let activeReads = 0
    let maximumActiveReads = 0
    let reads = 0
    const beforeRead = () => Effect.gen(function*() {
      activeReads += 1
      maximumActiveReads = Math.max(maximumActiveReads, activeReads)
      yield* Effect.yieldNow
      activeReads -= 1
    })

    return Effect.gen(function*() {
      const cache = yield* PromptCache
      const results = yield* Effect.all([cache.get(PATH), cache.get(PATH)], { concurrency: 2 })

      assert.deepStrictEqual(results, ['One prompt', 'One prompt'])
      assert.strictEqual(reads, 1)
      assert.strictEqual(maximumActiveReads, 1)
    }).pipe(Effect.provide(
      PromptCache.layer.pipe(Layer.provideMerge(testFileSystem({
        [PATH]: claude.transcript([claude.userText('One prompt')]),
      }, {
        beforeRead,
        onRead: () => { reads += 1 },
      }))),
    ))
  })
})
