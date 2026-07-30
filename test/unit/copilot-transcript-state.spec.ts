import { assert, describe, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { TranscriptFile } from '#server/utils/copilot-transcript-state'
import { testFileSystem } from '../fixtures/filesystem'

describe('Copilot transcript file state', () => {
  it.effect('does not read an unchanged file again', () => {
    const reads: string[] = []
    const path = '/copilot/session.jsonl'
    const file = new TranscriptFile(path)
    return Effect.gen(function*() {
      assert.isTrue(Option.isSome(yield* file.refresh()))
      assert.isTrue(Option.isNone(yield* file.refresh()))
      assert.deepStrictEqual(reads, [path])
    }).pipe(Effect.provide(testFileSystem({
      [path]: { content: '{}\n', mtime: 1 },
    }, { onRead: candidate => reads.push(candidate) })))
  })

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
