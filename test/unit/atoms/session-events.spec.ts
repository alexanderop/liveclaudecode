import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'
import { makeSessionEventsAtoms, sessionEventsKey } from '~/atoms/session-events'
import { testAtoms } from '../../fixtures/atom-registry'
import { sessionEventsResponse } from '../../fixtures/runs'
import { stubApi, type StubApiHandlers } from '../../fixtures/stub-api'

/** The cadence `app/atoms/session-events.ts` chose. */
const INTERVAL = '4 seconds'

const withSessionEvents = Effect.fn('withSessionEvents')(function*(handlers: StubApiHandlers) {
  const stub = stubApi(handlers)
  const atoms = yield* testAtoms(stub.layer)
  return { atoms, stub, sessionEvents: makeSessionEventsAtoms(atoms.runtime).sessionEvents }
})

describe('session activity atoms', () => {
  it.effect('replaces the merged feed on every poll and reports truncation', () =>
    Effect.gen(function*() {
      let poll = 0
      const { atoms, stub, sessionEvents } = yield* withSessionEvents({
        sessionEvents: () => {
          poll += 1
          return Effect.succeed(sessionEventsResponse('session', [`merge ${poll}`], {
            truncated: poll === 2,
          }))
        },
      })
      const feed = sessionEvents(sessionEventsKey('/repo', 'session', 168))

      yield* atoms.mount(feed)
      yield* atoms.settled(feed)
      yield* TestClock.adjust(INTERVAL)

      // A snapshot, not a cursor: the server re-merges every agent of the
      // session each time, so the newest answer replaces the previous one.
      const settled = yield* atoms.settled(feed)
      assert.deepStrictEqual(settled.value?.events.map(event => event.body), ['merge 2'])
      assert.strictEqual(settled.value?.truncated, true)
      // Every poll asks for the whole session, capped at the same limit.
      assert.deepStrictEqual(
        yield* Effect.map(stub.calls.sessionEvents.all, calls => calls.map(call => call.limit)),
        [800, 800],
      )
    }))

  it.effect('asks for nothing until a session root is known', () =>
    Effect.gen(function*() {
      const { atoms, stub, sessionEvents } = yield* withSessionEvents({
        sessionEvents: () => Effect.succeed(sessionEventsResponse('session')),
      })

      yield* atoms.mount(sessionEvents(sessionEventsKey('/repo', null, 168)))
      yield* TestClock.adjust(INTERVAL)

      assert.strictEqual(
        yield* Effect.map(stub.calls.sessionEvents.all, calls => calls.length),
        0,
      )
    }))
})
