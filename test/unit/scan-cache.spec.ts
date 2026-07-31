import { assert, describe, it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Layer } from 'effect'
import { TestClock } from 'effect/testing'
import { PromptCache, ScanCache } from '#server/utils/services'
import * as claude from '../fixtures/transcripts'
import { testFileSystem } from '../fixtures/filesystem'

const PATH = '/claude/projects/repo/session.jsonl'
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
      for (let index = 0; index < 64; index += 1) {
        yield* TestClock.setTime(index)
        yield* cache.get(cachePath(index))
      }

      yield* TestClock.setTime(100)
      const promoted = yield* cache.get(cachePath(0))
      yield* TestClock.setTime(101)
      yield* cache.get(cachePath(64))

      assert.strictEqual(yield* cache.peek(cachePath(0)), promoted)
      assert.strictEqual(yield* cache.peek(cachePath(1)), undefined)
      assert.isTrue((yield* cache.peek(cachePath(64))) !== undefined)
    }).pipe(Effect.provide(Layer.mergeAll(
      ScanCache.layer,
      testFileSystem(transcriptTree(65)),
    ))))

  it.effect('expires an idle scan after thirty minutes', () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(0)
      const cache = yield* ScanCache
      const scan = yield* cache.get(PATH)

      yield* TestClock.setTime(30 * 60 * 1_000 - 1)
      assert.strictEqual(yield* cache.peek(PATH), scan)
      yield* TestClock.setTime(30 * 60 * 1_000)
      assert.strictEqual(yield* cache.peek(PATH), undefined)
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

      for (let index = 1; index <= 64; index += 1) {
        yield* cache.get(cachePath(index))
      }
      assert.isTrue((yield* cache.peek(cachePath(0))) !== undefined)

      yield* Deferred.succeed(releaseRead, undefined)
      const scan = yield* Fiber.join(active)
      assert.strictEqual(yield* cache.peek(cachePath(0)), scan)
    }).pipe(Effect.provide(Layer.mergeAll(
      ScanCache.layer,
      testFileSystem(transcriptTree(65), { beforeRead }),
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

      for (let index = 1; index <= 64; index += 1) {
        yield* TestClock.setTime(index)
        yield* cache.get(cachePath(index))
      }
      assert.strictEqual(yield* cache.peek(cachePath(0)), undefined)
    }).pipe(Effect.provide(Layer.mergeAll(
      ScanCache.layer,
      testFileSystem(transcriptTree(65), { beforeRead }),
    )))
  })

  it.effect('releases ownership when a refresh fails', () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(0)
      const cache = yield* ScanCache
      yield* cache.get(cachePath(0)).pipe(Effect.flip)

      for (let index = 1; index <= 64; index += 1) {
        yield* TestClock.setTime(index)
        yield* cache.get(cachePath(index))
      }
      assert.strictEqual(yield* cache.peek(cachePath(0)), undefined)
    }).pipe(Effect.provide(Layer.mergeAll(
      ScanCache.layer,
      testFileSystem(transcriptTree(65), { denied: [cachePath(0)] }),
    ))))

  it.effect('converges to capacity after 65 simultaneous refreshes finish', () => {
    let allReadsStarted!: Deferred.Deferred<void>
    let releaseReads!: Deferred.Deferred<void>
    let started = 0
    const beforeRead = () => Effect.gen(function*() {
      started += 1
      if (started === 65) yield* Deferred.succeed(allReadsStarted, undefined)
      yield* Deferred.await(releaseReads)
    })

    return Effect.gen(function*() {
      allReadsStarted = yield* Deferred.make<void>()
      releaseReads = yield* Deferred.make<void>()
      const cache = yield* ScanCache
      const paths = Array.from({ length: 65 }, (_, index) => cachePath(index))
      const refreshing = yield* Effect.forkChild(
        Effect.forEach(paths, path => cache.get(path), { concurrency: 65 }),
      )
      yield* Deferred.await(allReadsStarted)
      yield* Deferred.succeed(releaseReads, undefined)
      yield* Fiber.join(refreshing)

      const retained = yield* Effect.forEach(paths, path => cache.peek(path))
      assert.strictEqual(retained.filter(scan => scan !== undefined).length, 64)
    }).pipe(Effect.provide(Layer.mergeAll(
      ScanCache.layer,
      testFileSystem(transcriptTree(65), { beforeRead }),
    )))
  })
})

describe('prompt cache', () => {
  it.effect('retains only the 256 most recently used prompts', () =>
    Effect.gen(function*() {
      const cache = yield* PromptCache
      for (let index = 0; index < 256; index += 1) {
        assert.strictEqual(
          yield* cache.get(`prompt-${index}`, Effect.succeed(`Prompt ${index}`)),
          `Prompt ${index}`,
        )
      }

      assert.strictEqual(
        yield* cache.get('prompt-0', Effect.die('promoted prompt was read again')),
        'Prompt 0',
      )
      yield* cache.get('prompt-256', Effect.succeed('Prompt 256'))

      let reread = false
      assert.strictEqual(
        yield* cache.get('prompt-1', Effect.sync(() => {
          reread = true
          return 'Replacement prompt'
        })),
        'Replacement prompt',
      )
      assert.isTrue(reread)
    }).pipe(Effect.provide(PromptCache.layer)))

  it.effect('promotes the winning value when a concurrent read finishes later', () =>
    Effect.gen(function*() {
      const cache = yield* PromptCache
      const losingReadStarted = yield* Deferred.make<void>()
      const releaseLosingRead = yield* Deferred.make<void>()
      const losing = yield* Effect.forkChild(cache.get('shared', Effect.gen(function*() {
        yield* Deferred.succeed(losingReadStarted, undefined)
        yield* Deferred.await(releaseLosingRead)
        return 'Losing value'
      })))
      yield* Deferred.await(losingReadStarted)

      assert.strictEqual(
        yield* cache.get('shared', Effect.succeed('Winning value')),
        'Winning value',
      )
      for (let index = 0; index < 255; index += 1) {
        yield* cache.get(`other-${index}`, Effect.succeed(`Other ${index}`))
      }

      yield* Deferred.succeed(releaseLosingRead, undefined)
      assert.strictEqual(yield* Fiber.join(losing), 'Winning value')
      yield* cache.get('other-255', Effect.succeed('Other 255'))

      assert.strictEqual(
        yield* cache.get('shared', Effect.die('shared prompt was evicted')),
        'Winning value',
      )
      let oldestReread = false
      yield* cache.get('other-0', Effect.sync(() => {
        oldestReread = true
        return 'Replacement'
      }))
      assert.isTrue(oldestReread)
    }).pipe(Effect.provide(PromptCache.layer)))
})
