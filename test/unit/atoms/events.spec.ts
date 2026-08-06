import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'
import type { EventsQuery } from '~/api/api'
import { ApiUnreachable } from '~/api/errors'
import { eventsKey, makeEventsAtoms } from '~/atoms/events'
import { testAtoms } from '../../fixtures/atom-registry'
import { eventsResponse } from '../../fixtures/runs'
import { stubApi, type StubApiHandlers } from '../../fixtures/stub-api'

/** The cadence `app/atoms/events.ts` chose, restated so a change fails here. */
const INTERVAL = '2 seconds'

const withEvents = Effect.fn('withEvents')(function*(handlers: StubApiHandlers) {
  const stub = stubApi(handlers)
  const atoms = yield* testAtoms(stub.layer)
  return { atoms, stub, events: makeEventsAtoms(atoms.runtime).events }
})

/** Every cursor the feed sent, oldest first. */
const cursors = (log: { readonly all: Effect.Effect<ReadonlyArray<EventsQuery>> }) =>
  Effect.map(log.all, calls => calls.map(call => `${call.key}@${call.since}/${call.revision}`))

const bodies = (events: ReadonlyArray<{ readonly body?: string | undefined }>) =>
  events.map(event => event.body)

describe('transcript atoms', () => {
  it.effect('appends each page to the buffer and advances the cursor', () =>
    Effect.gen(function*() {
      let poll = 0
      const { atoms, stub, events } = yield* withEvents({
        events: () => {
          poll += 1
          return Effect.succeed(eventsResponse('session', [`page ${poll}`], {
            next: poll,
            revision: 1,
          }))
        },
      })
      const feed = events(eventsKey('/repo', 'session', 168))

      yield* atoms.mount(feed)
      yield* atoms.settled(feed)
      yield* TestClock.adjust(INTERVAL)

      assert.deepStrictEqual(bodies((yield* atoms.settled(feed)).value ?? []), [
        'page 1',
        'page 2',
      ])
      // The second poll asked for what it had not seen, not for everything.
      assert.deepStrictEqual(yield* cursors(stub.calls.events), [
        'session@0/0',
        'session@1/1',
      ])
    }))

  it.effect('replaces the buffer when the provider rewrites the transcript', () =>
    Effect.gen(function*() {
      let poll = 0
      const { atoms, events } = yield* withEvents({
        events: () => {
          poll += 1
          return Effect.succeed(poll === 1
            ? eventsResponse('session', ['before'], { next: 1, revision: 1 })
            : eventsResponse('session', ['after'], { next: 1, revision: 2, reset: true }))
        },
      })
      const feed = events(eventsKey('/repo', 'session', 168))

      yield* atoms.mount(feed)
      yield* atoms.settled(feed)
      yield* TestClock.adjust(INTERVAL)

      // `reset` means the events after the cursor belong to a transcript this
      // buffer is not a prefix of, so extending it would interleave two runs.
      assert.deepStrictEqual(bodies((yield* atoms.settled(feed)).value ?? []), ['after'])
    }))

  it.effect('keeps two agents apart, with no shared cursor', () =>
    Effect.gen(function*() {
      const { atoms, stub, events } = yield* withEvents({
        events: query => Effect.succeed(eventsResponse(query.key, [`${query.key} said something`], {
          next: 1,
          revision: 1,
        })),
      })
      const first = events(eventsKey('/repo', 'agent-a', 168))
      const second = events(eventsKey('/repo', 'agent-b', 168))

      yield* atoms.mount(first)
      yield* atoms.mount(second)
      yield* atoms.settled(first)
      yield* atoms.settled(second)

      // A different agent is a different atom. There is no staleness question
      // to answer, which is what `latest-request-gate.ts` existed for.
      assert.deepStrictEqual(bodies((yield* atoms.settled(first)).value ?? []), [
        'agent-a said something',
      ])
      assert.deepStrictEqual(bodies((yield* atoms.settled(second)).value ?? []), [
        'agent-b said something',
      ])
      assert.deepStrictEqual(yield* cursors(stub.calls.events), ['agent-a@0/0', 'agent-b@0/0'])
    }))

  it.effect('keeps the buffer and the cursor across a failed poll', () =>
    Effect.gen(function*() {
      let poll = 0
      const { atoms, stub, events } = yield* withEvents({
        events: () => {
          poll += 1
          if (poll === 2) {
            return Effect.fail(new ApiUnreachable({ url: '/api/events', detail: 'refused' }))
          }
          return Effect.succeed(eventsResponse('session', [`page ${poll}`], {
            next: poll === 1 ? 1 : 2,
            revision: 1,
          }))
        },
      })
      const feed = events(eventsKey('/repo', 'session', 168))

      yield* atoms.mount(feed)
      yield* atoms.settled(feed)
      yield* TestClock.adjust(INTERVAL)
      yield* TestClock.adjust(INTERVAL)

      // The loop survived, the buffer survived, and the retry resumed from the
      // cursor rather than refetching the whole transcript.
      assert.deepStrictEqual(bodies((yield* atoms.settled(feed)).value ?? []), [
        'page 1',
        'page 3',
      ])
      assert.deepStrictEqual(yield* cursors(stub.calls.events), [
        'session@0/0',
        'session@1/1',
        'session@1/1',
      ])
    }))

  it.effect('asks for nothing while no agent is selected', () =>
    Effect.gen(function*() {
      const { atoms, stub, events } = yield* withEvents({
        events: () => Effect.succeed(eventsResponse('session', [])),
      })
      const feed = events(eventsKey(null, null, 168))

      yield* atoms.mount(feed)
      yield* TestClock.adjust(INTERVAL)

      // The empty selection is a real key with a gated feed, which is what lets
      // a component subscribe unconditionally during `setup()`.
      assert.deepStrictEqual(yield* Effect.map(stub.calls.events.all, calls => calls.length), 0)
    }))
})
