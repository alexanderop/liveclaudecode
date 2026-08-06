import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'
import type { EventsQuery } from '~/api/api'
import { ApiUnreachable } from '~/api/errors'
import { type EventsKey, eventsKey, makeEventsAtoms } from '~/atoms/events'
import { testAtoms } from '../../fixtures/atom-registry'
import { eventsResponse } from '../../fixtures/runs'
import { stubApi, type StubApiHandlers } from '../../fixtures/stub-api'

/** The cadence `app/atoms/events.ts` chose, restated so a change fails here. */
const INTERVAL = '2 seconds'

const SESSION = eventsKey('/repo', 'session', 168)

const withEvents = Effect.fn('withEvents')(function*(handlers: StubApiHandlers) {
  const stub = stubApi(handlers)
  const atoms = yield* testAtoms(stub.layer)
  const { active, events } = makeEventsAtoms(atoms.runtime)

  /** Stands in for a component announcing that it is rendering `key`. */
  const show = (key: EventsKey) => atoms.set(active, { target: key, delta: 1 })
  const hide = (key: EventsKey) => atoms.set(active, { target: key, delta: -1 })

  /**
   * Announce, then mount — the order `useTranscriptActivation` guarantees, and
   * the order that matters: mounting starts the stream and its first tick reads
   * the map, so announcing afterwards costs a whole interval.
   */
  const watching = (key: EventsKey) => Effect.andThen(show(key), atoms.mount(events(key)))

  return { atoms, stub, events, active, show, hide, watching }
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
      const { atoms, stub, events, watching } = yield* withEvents({
        events: () => {
          poll += 1
          return Effect.succeed(eventsResponse('session', [`page ${poll}`], {
            next: poll,
            revision: 1,
          }))
        },
      })
      const feed = events(SESSION)

      yield* watching(SESSION)
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
      const { atoms, events, watching } = yield* withEvents({
        events: () => {
          poll += 1
          return Effect.succeed(poll === 1
            ? eventsResponse('session', ['before'], { next: 1, revision: 1 })
            : eventsResponse('session', ['after'], { next: 1, revision: 2, reset: true }))
        },
      })
      const feed = events(SESSION)

      yield* watching(SESSION)
      yield* atoms.settled(feed)
      yield* TestClock.adjust(INTERVAL)

      // `reset` means the events after the cursor belong to a transcript this
      // buffer is not a prefix of, so extending it would interleave two runs.
      assert.deepStrictEqual(bodies((yield* atoms.settled(feed)).value ?? []), ['after'])
    }))

  it.effect('keeps two agents apart, with no shared cursor', () =>
    Effect.gen(function*() {
      const { atoms, stub, events, watching } = yield* withEvents({
        events: query => Effect.succeed(eventsResponse(query.key, [`${query.key} said something`], {
          next: 1,
          revision: 1,
        })),
      })
      const alpha = eventsKey('/repo', 'agent-a', 168)
      const beta = eventsKey('/repo', 'agent-b', 168)

      yield* watching(alpha)
      yield* watching(beta)
      yield* atoms.settled(events(alpha))
      yield* atoms.settled(events(beta))

      // A different agent is a different atom. There is no staleness question
      // to answer, which is what `latest-request-gate.ts` existed for.
      assert.deepStrictEqual(bodies((yield* atoms.settled(events(alpha))).value ?? []), [
        'agent-a said something',
      ])
      assert.deepStrictEqual(bodies((yield* atoms.settled(events(beta))).value ?? []), [
        'agent-b said something',
      ])
      assert.deepStrictEqual(yield* cursors(stub.calls.events), ['agent-a@0/0', 'agent-b@0/0'])
    }))

  it.effect('keeps the buffer and the cursor across a failed poll', () =>
    Effect.gen(function*() {
      let poll = 0
      const { atoms, stub, events, watching } = yield* withEvents({
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
      const feed = events(SESSION)

      yield* watching(SESSION)
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
      const { stub, watching } = yield* withEvents({
        events: () => Effect.succeed(eventsResponse('session', [])),
      })

      yield* watching(eventsKey(null, null, 168))
      yield* TestClock.adjust(INTERVAL)

      // The empty selection is a real key with a gated feed, which is what lets
      // a component subscribe unconditionally during `setup()`. Announced or
      // not, a key with nothing in it never reaches the server.
      assert.strictEqual(yield* stub.calls.events.count, 0)
    }))

  describe('the activation gate', () => {
    it.effect('asks for nothing until something says it is on screen', () =>
      Effect.gen(function*() {
        const { atoms, stub, events, show } = yield* withEvents({
          events: () => Effect.succeed(eventsResponse('session', ['page 1'], { next: 1 })),
        })
        const feed = events(SESSION)

        yield* atoms.mount(feed)
        yield* TestClock.adjust(INTERVAL)
        yield* TestClock.adjust(INTERVAL)

        // Mounted, ticking, and deliberately silent. A subscriber is not the
        // same claim as a reader: `activityAtoms.feed` subscribes to whichever
        // transcript the selection names, including while the page is showing
        // Overview and nothing is rendering a transcript at all.
        assert.strictEqual(yield* stub.calls.events.count, 0)

        yield* show(SESSION)
        yield* TestClock.adjust(INTERVAL)

        assert.strictEqual(yield* stub.calls.events.count, 1)
      }))

    it.effect('stops fetching for a transcript nobody is showing any more', () =>
      Effect.gen(function*() {
        let poll = 0
        const { atoms, stub, events, hide, watching } = yield* withEvents({
          events: () => {
            poll += 1
            return Effect.succeed(eventsResponse('session', [`page ${poll}`], {
              next: poll,
              revision: 1,
            }))
          },
        })
        const feed = events(SESSION)

        yield* watching(SESSION)
        yield* atoms.settled(feed)
        assert.strictEqual(yield* stub.calls.events.count, 1)

        yield* hide(SESSION)
        yield* TestClock.adjust('60 seconds')

        // This is the regression the gate exists for. `setIdleTTL('2 minutes')`
        // keeps the node — and so the stream — alive well past the last reader,
        // so a transcript the user clicked away from would otherwise spend two
        // minutes polling at this interval. Thirty ticks, none of them a
        // request.
        assert.strictEqual(yield* stub.calls.events.count, 1)
      }))

    it.effect('resumes from the cursor rather than refetching the transcript', () =>
      Effect.gen(function*() {
        let poll = 0
        const { atoms, stub, events, show, hide, watching } = yield* withEvents({
          events: () => {
            poll += 1
            return Effect.succeed(eventsResponse('session', [`page ${poll}`], {
              next: poll,
              revision: 1,
            }))
          },
        })
        const feed = events(SESSION)

        yield* watching(SESSION)
        yield* atoms.settled(feed)
        yield* hide(SESSION)
        yield* TestClock.adjust('60 seconds')
        yield* show(SESSION)
        yield* TestClock.adjust(INTERVAL)

        // Pausing is not the same as re-keying, and this is the difference.
        // The second request carried the cursor the first one earned, and the
        // buffer still has the page from before the pause — where making
        // visibility part of the family key would have produced a second atom
        // asking `session@0/0` for the whole transcript again.
        assert.deepStrictEqual(yield* cursors(stub.calls.events), [
          'session@0/0',
          'session@1/1',
        ])
        assert.deepStrictEqual(bodies((yield* atoms.settled(feed)).value ?? []), [
          'page 1',
          'page 2',
        ])
      }))

    it.effect('keeps polling while a second reader still has it open', () =>
      Effect.gen(function*() {
        const { atoms, stub, events, show, hide, watching } = yield* withEvents({
          events: () => Effect.succeed(eventsResponse('session', ['page'], { next: 1 })),
        })

        // The activity view and the inspector overlay, on the same transcript.
        yield* watching(SESSION)
        yield* show(SESSION)
        yield* atoms.settled(events(SESSION))
        yield* hide(SESSION)
        yield* TestClock.adjust(INTERVAL)

        // A flag would have read this as "hidden" and stopped a feed that is
        // still on screen. The count is why it is a count.
        assert.strictEqual(yield* stub.calls.events.count, 2)
      }))
  })
})
