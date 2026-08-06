import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import type { RangeQuery } from '~/api/api'
import { ApiUnreachable } from '~/api/errors'
import { makeRangeAtoms } from '~/atoms/range'
import { makeTreeAtoms } from '~/atoms/tree'
import { testAtoms } from '../../fixtures/atom-registry'
import { runNode, treeResponse } from '../../fixtures/runs'
import { stubApi, type StubApiHandlers } from '../../fixtures/stub-api'

/** The cadence `app/atoms/tree.ts` chose, restated so a change fails here. */
const INTERVAL = '4 seconds'

/** A registry, a runtime over a fresh stub, and a tree bound to a fresh range. */
const withTree = Effect.fn('withTree')(function*(handlers: StubApiHandlers) {
  const stub = stubApi(handlers)
  const atoms = yield* testAtoms(stub.layer)
  const range = makeRangeAtoms()
  return { atoms, stub, range, tree: makeTreeAtoms(atoms.runtime, range) }
})

/** Every range the tree asked the server for, oldest first. */
const asked = (log: { readonly all: Effect.Effect<ReadonlyArray<RangeQuery>> }) =>
  Effect.map(log.all, calls => calls.map(call => call.hours))

const ok = (hours = 168) => Effect.succeed(treeResponse(runNode({}), hours))

describe('tree atoms', () => {
  it.effect('asks for no range at all on the first poll', () =>
    Effect.gen(function*() {
      const { atoms, stub, tree } = yield* withTree({ tree: () => ok(72) })

      yield* atoms.mount(tree.tree)
      yield* atoms.settled(tree.tree)

      // The dashboard's range is the server's. Sending a guessed default would
      // override the one `liveclaudecode --hours 72` configured, because
      // `parseHours` lets a client value win outright.
      assert.deepStrictEqual(yield* asked(stub.calls.tree), [undefined])
    }))

  it.effect('adopts the effective range the first response reports', () =>
    Effect.gen(function*() {
      const { atoms, range, stub, tree } = yield* withTree({ tree: () => ok(72) })

      yield* atoms.mount(tree.tree)
      yield* atoms.settled(tree.tree)

      assert.strictEqual(yield* atoms.get(range.server), 72)
      assert.strictEqual(yield* atoms.get(range.hours), 72)
      // Adopting is not a range change: the loop must not have been rebuilt.
      assert.deepStrictEqual(yield* asked(stub.calls.tree), [undefined])
    }))

  it.effect('re-polls at the interval, keeping the last tree between ticks', () =>
    Effect.gen(function*() {
      const { atoms, stub, tree } = yield* withTree({ tree: () => ok() })

      yield* atoms.mount(tree.tree)
      yield* atoms.settled(tree.tree)
      yield* TestClock.adjust(INTERVAL)
      yield* TestClock.adjust(INTERVAL)

      assert.deepStrictEqual(yield* asked(stub.calls.tree), [undefined, undefined, undefined])
    }))

  it.effect('refetches immediately when the user picks a different range', () =>
    Effect.gen(function*() {
      const { atoms, range, stub, tree } = yield* withTree({ tree: () => ok() })

      yield* atoms.mount(tree.tree)
      yield* atoms.settled(tree.tree)
      yield* atoms.set(range.hours, 24)
      yield* atoms.settled(tree.tree)

      // A different range is a different loop, not a flag the next tick reads:
      // the user does not wait four seconds to see the window they chose.
      assert.deepStrictEqual(yield* asked(stub.calls.tree), [undefined, 24])
      assert.strictEqual(yield* atoms.get(range.hours), 24)
    }))

  it.effect('keeps the tree on screen when a poll fails, and recovers', () =>
    Effect.gen(function*() {
      let polls = 0
      const { atoms, tree } = yield* withTree({
        tree: () => {
          polls += 1
          return polls === 2
            ? Effect.fail(new ApiUnreachable({ url: '/api/tree', detail: 'refused' }))
            : ok()
        },
      })

      const values = yield* atoms.recorded(tree.tree)
      yield* atoms.settled(tree.tree)
      yield* TestClock.adjust(INTERVAL)
      yield* TestClock.adjust(INTERVAL)

      const feeds = (yield* values).flatMap(result =>
        AsyncResult.isSuccess(result) ? [result.value] : [])
      // Three polls: the loop did not end when one of them failed.
      assert.strictEqual(polls, 3)
      // The failed poll kept the previous tree and reported the failure beside
      // it — the offline banner over data that is merely stale.
      const failed = feeds[feeds.length - 2]!
      assert.isNotNull(failed.value)
      assert.strictEqual(failed.error?._tag, 'ApiUnreachable')
      const recovered = feeds[feeds.length - 1]!
      assert.isNotNull(recovered.value)
      assert.isNull(recovered.error)
    }))

  it.effect('reports offline while the poll is failing and clears it on success', () =>
    Effect.gen(function*() {
      let polls = 0
      const { atoms, tree } = yield* withTree({
        tree: () => {
          polls += 1
          return polls === 1
            ? Effect.fail(new ApiUnreachable({ url: '/api/tree', detail: 'refused' }))
            : ok()
        },
      })

      yield* atoms.mount(tree.offline)
      yield* atoms.settled(tree.tree)
      assert.strictEqual(yield* atoms.get(tree.offline), true)
      // Nothing arrived, but the poll has answered: the dashboard is not loading
      // any more, it is disconnected.
      assert.strictEqual(yield* atoms.get(tree.loading), false)
      assert.deepStrictEqual(yield* atoms.get(tree.projects), [])

      yield* TestClock.adjust(INTERVAL)

      assert.strictEqual(yield* atoms.get(tree.offline), false)
      assert.strictEqual((yield* atoms.get(tree.projects)).length, 1)
    }))
})
