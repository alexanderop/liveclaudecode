import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'
import { ApiUnreachable } from '~/api/errors'
import { makeRunAtoms, runKey } from '~/atoms/run-detail'
import { testAtoms } from '../../fixtures/atom-registry'
import { runNode, runResponse } from '../../fixtures/runs'
import { stubApi, type StubApiHandlers } from '../../fixtures/stub-api'

/** The cadence `app/atoms/run-detail.ts` chose, restated so a change fails here. */
const INTERVAL = '6 seconds'

const withRun = Effect.fn('withRun')(function*(handlers: StubApiHandlers) {
  const stub = stubApi(handlers)
  const atoms = yield* testAtoms(stub.layer)
  return { atoms, stub, run: makeRunAtoms(atoms.runtime).run }
})

const detail = (path: string) => {
  const root = runNode({})
  return Effect.succeed(runResponse({ root, node: root, transcriptPath: path }))
}

describe('run detail atoms', () => {
  it.effect('polls the selected agent on its own cadence', () =>
    Effect.gen(function*() {
      const { atoms, stub, run } = yield* withRun({ run: () => detail('/first') })
      const feed = run(runKey('/repo', 'session', 168))

      yield* atoms.mount(feed)
      yield* atoms.settled(feed)
      yield* TestClock.adjust(INTERVAL)

      assert.deepStrictEqual(
        yield* Effect.map(stub.calls.run.all, calls => calls.map(call => call.key)),
        ['session', 'session'],
      )
    }))

  it.effect('holds the last detail on screen when a poll fails', () =>
    Effect.gen(function*() {
      let polls = 0
      const { atoms, run } = yield* withRun({
        run: () => {
          polls += 1
          return polls === 1
            ? detail('/first')
            : Effect.fail(new ApiUnreachable({ url: '/api/run', detail: 'refused' }))
        },
      })
      const feed = run(runKey('/repo', 'session', 168))

      yield* atoms.mount(feed)
      yield* atoms.settled(feed)
      yield* TestClock.adjust(INTERVAL)

      const settled = yield* atoms.settled(feed)
      assert.strictEqual(settled.value?.transcriptPath, '/first')
      assert.strictEqual(settled.error?._tag, 'ApiUnreachable')
    }))

  it.effect('asks for nothing while no agent is selected', () =>
    Effect.gen(function*() {
      const { atoms, stub, run } = yield* withRun({ run: () => detail('/first') })

      yield* atoms.mount(run(runKey(null, null, 168)))
      yield* TestClock.adjust(INTERVAL)

      assert.strictEqual(yield* Effect.map(stub.calls.run.all, calls => calls.length), 0)
    }))
})
