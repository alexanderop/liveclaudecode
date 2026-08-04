import { assert, describe, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { TranscriptFile } from '#server/utils/copilot-transcript-state'
import { makeCallLog } from '../fixtures/call-log'
import { testFileSystem } from '../fixtures/filesystem'

describe('Copilot transcript file state', () => {
  it.effect('does not read an unchanged file again', () =>
    Effect.gen(function*() {
      const reads = yield* makeCallLog<string>()
      const path = '/copilot/session.jsonl'
      const file = new TranscriptFile(path)

      yield* Effect.gen(function*() {
        assert.isTrue(Option.isSome(yield* file.refresh()))
        assert.isTrue(Option.isNone(yield* file.refresh()))
      }).pipe(Effect.provide(testFileSystem({
        [path]: { content: '{}\n', mtime: 1 },
      }, { onRead: reads.record })))

      assert.deepStrictEqual(yield* reads.all, [path])
    }))

  it.effect('marks a shortened file as rewritten', () => {
    const path = '/copilot/session.jsonl'
    const entry = { content: '{"long":"value"}\n', mtime: 1 }
    const file = new TranscriptFile(path)
    return Effect.gen(function*() {
      const initial = yield* file.refresh()
      assert.isTrue(Option.isSome(initial))
      if (Option.isSome(initial)) assert.isFalse(initial.value.rewritten)

      entry.content = '{}\n'
      entry.mtime = 2
      const changed = yield* file.refresh()
      assert.isTrue(Option.isSome(changed))
      if (Option.isSome(changed)) assert.isTrue(changed.value.rewritten)
    }).pipe(Effect.provide(testFileSystem({ [path]: entry })))
  })
})
