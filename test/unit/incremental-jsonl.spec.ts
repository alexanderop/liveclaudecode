import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  consumeNewRecords,
  readHead,
  type IncrementalScanState,
} from '../../server/utils/incremental-jsonl'
import { testFileSystem, type FakeEntry } from '../fixtures/filesystem'

const PATH = '/p/s.jsonl'

const initialState: IncrementalScanState = {
  line: 0,
  malformed: 0,
  mtime: 0,
  size: 0,
  bytesConsumed: 0,
  lastLoadedMtime: 0,
  lastLoadedSize: -1,
}

describe('readHead', () => {
  it.effect('reads at most the first maxBytes of a file', () =>
    Effect.gen(function*() {
      const layer = testFileSystem({ [PATH]: 'abcdefghij' })
      assert.strictEqual(yield* readHead(PATH, 4).pipe(Effect.provide(layer)), 'abcd')
      assert.strictEqual(yield* readHead(PATH, 100).pipe(Effect.provide(layer)), 'abcdefghij')
    }))
})

describe('consumeNewRecords', () => {
  it.effect('parses complete lines with their absolute indices', () =>
    Effect.gen(function*() {
      const layer = testFileSystem({ [PATH]: '{"n":1}\n{"n":2}\n' })
      const { records, next } = yield* consumeNewRecords(PATH, initialState).pipe(Effect.provide(layer))
      assert.deepStrictEqual(records, [[0, { n: 1 }], [1, { n: 2 }]])
      assert.strictEqual(next.line, 2)
      assert.strictEqual(next.malformed, 0)
      assert.strictEqual(next.bytesConsumed, '{"n":1}\n{"n":2}\n'.length)
    }))

  it.effect('returns only the appended records on a later call', () =>
    Effect.gen(function*() {
      const entry: FakeEntry = { content: '{"n":1}\n', mtime: 100 }
      const layer = testFileSystem({ [PATH]: entry })
      const first = yield* consumeNewRecords(PATH, initialState).pipe(Effect.provide(layer))

      entry.content += '{"n":2}\n'
      entry.mtime = 200
      const second = yield* consumeNewRecords(PATH, first.next).pipe(Effect.provide(layer))
      assert.deepStrictEqual(second.records, [[1, { n: 2 }]])
      assert.strictEqual(second.next.line, 2)
    }))

  it.effect('does not read again when size and mtime are unchanged', () =>
    Effect.gen(function*() {
      const reads: string[] = []
      const layer = testFileSystem(
        { [PATH]: { content: '{"n":1}\n', mtime: 100 } },
        { onRead: path => reads.push(path) },
      )
      const first = yield* consumeNewRecords(PATH, initialState).pipe(Effect.provide(layer))
      const second = yield* consumeNewRecords(PATH, first.next).pipe(Effect.provide(layer))
      assert.deepStrictEqual(second.records, [])
      assert.strictEqual(reads.length, 1)
    }))

  it.effect('leaves a trailing partial line for the next call', () =>
    Effect.gen(function*() {
      const entry: FakeEntry = { content: '{"n":1}\n{"n":2', mtime: 100 }
      const layer = testFileSystem({ [PATH]: entry })
      const first = yield* consumeNewRecords(PATH, initialState).pipe(Effect.provide(layer))
      assert.deepStrictEqual(first.records, [[0, { n: 1 }]])
      assert.strictEqual(first.next.bytesConsumed, '{"n":1}\n'.length)

      entry.content = '{"n":1}\n{"n":2}\n'
      entry.mtime = 200
      const second = yield* consumeNewRecords(PATH, first.next).pipe(Effect.provide(layer))
      assert.deepStrictEqual(second.records, [[1, { n: 2 }]])
    }))

  it.effect('re-reads from the start when the file shrinks (rewritten, not appended)', () =>
    Effect.gen(function*() {
      const entry: FakeEntry = { content: '{"n":1}\n{"n":2}\n{"n":3}\n', mtime: 100 }
      const layer = testFileSystem({ [PATH]: entry })
      const first = yield* consumeNewRecords(PATH, initialState).pipe(Effect.provide(layer))
      assert.strictEqual(first.next.line, 3)

      // Rewritten shorter: previously consumed line indices no longer exist.
      entry.content = '{"n":1}\n'
      entry.mtime = 200
      const second = yield* consumeNewRecords(PATH, first.next).pipe(Effect.provide(layer))
      assert.deepStrictEqual(second.records, [])
      assert.strictEqual(second.next.line, 1)
      assert.strictEqual(second.next.bytesConsumed, '{"n":1}\n'.length)

      // Growing again from the rewritten content resumes normally.
      entry.content = '{"n":1}\n{"n":9}\n'
      entry.mtime = 300
      const third = yield* consumeNewRecords(PATH, second.next).pipe(Effect.provide(layer))
      assert.deepStrictEqual(third.records, [[1, { n: 9 }]])
    }))

  it.effect('counts malformed lines instead of failing', () =>
    Effect.gen(function*() {
      const layer = testFileSystem({ [PATH]: '{"broken"\n{"n":2}\n' })
      const { records, next } = yield* consumeNewRecords(PATH, initialState).pipe(Effect.provide(layer))
      assert.deepStrictEqual(records, [[1, { n: 2 }]])
      assert.strictEqual(next.malformed, 1)
    }))

  it.effect('treats a missing file as unchanged state', () =>
    Effect.gen(function*() {
      const { records, next } = yield* consumeNewRecords('/p/absent.jsonl', initialState)
        .pipe(Effect.provide(testFileSystem({})))
      assert.deepStrictEqual(records, [])
      assert.deepStrictEqual(next, initialState)
    }))
})
