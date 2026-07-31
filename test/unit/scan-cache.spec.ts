import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { ScanCache } from '#server/utils/services'
import * as claude from '../fixtures/transcripts'
import { testFileSystem } from '../fixtures/filesystem'

const PATH = '/claude/projects/repo/session.jsonl'

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
})
