import { assert, describe, it } from '@effect/vitest'
import { Cause, Effect, Ref } from 'effect'
import { TestClock } from 'effect/testing'
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import type { CostOverviewResponse } from '#shared/types/run'
import type { RangeQuery } from '~/api/api'
import { ApiUnreachable } from '~/api/errors'
import type { Feed } from '~/atoms/feed'
import { costsKey, makeCostsAtoms } from '~/atoms/costs'
import { toFeedView } from '~/utils/feed-view'
import { testAtoms } from '../../fixtures/atom-registry'
import { costOverviewResponse } from '../../fixtures/runs'
import { stubApi, type StubApiHandlers } from '../../fixtures/stub-api'

/** The poll interval `app/atoms/costs.ts` chose, restated so a change fails here. */
const INTERVAL = '30 seconds'

/**
 * A registry, a runtime bound to a fresh stub, and a fresh costs family.
 *
 * The family is built per test on purpose: `makeCostsAtoms` is the seam that
 * lets a test own its atoms, and reusing the module-level `costsAtoms` would
 * share nodes between cases.
 */
const withCosts = Effect.fn('withCosts')(function*(handlers: StubApiHandlers) {
  const stub = stubApi(handlers)
  const atoms = yield* testAtoms(stub.layer)
  const { costs, refresh } = makeCostsAtoms(atoms.runtime)
  return { atoms, stub, costs, refresh }
})

/** Only the successful snapshots a feed published, oldest first. */
const feeds = <A>(
  values: ReadonlyArray<AsyncResult.AsyncResult<Feed<A>, unknown>>,
): ReadonlyArray<Feed<A>> =>
  values.flatMap(result => AsyncResult.isSuccess(result) ? [result.value] : [])

/** A successful answer. The mutable builder output is assignable to the wire type. */
const ok = (overrides: Partial<CostOverviewResponse> = {}) =>
  Effect.succeed(costOverviewResponse(overrides))

/**
 * Yields until the feed's subscription to the pulse atom is live.
 *
 * The merged pulse stream registers its listener in a forked fiber, one
 * scheduler turn after the feed publishes its first value, and a pulse fired
 * before then is not queued — it is simply not seen. Nothing in the browser can
 * click a button inside that window, but a test can, and the failure looks like
 * a hang rather than an assertion.
 */
const pulseIsLive = Effect.yieldNow

describe('costs atoms', () => {
  describe('the family key', () => {
    it.effect('sends the requested hours on the first poll', () =>
      Effect.gen(function*() {
        const { atoms, stub, costs } = yield* withCosts({ costs: () => ok() })

        yield* atoms.mount(costs(costsKey(24)))
        yield* atoms.settled(costs(costsKey(24)))

        assert.deepStrictEqual(yield* stub.calls.costs.all, [{ hours: 24 }])
      }).pipe(Effect.scoped))

    it.effect('sends hours=0, which means all time and is not a missing value', () =>
      Effect.gen(function*() {
        const { atoms, stub, costs } = yield* withCosts({ costs: () => ok() })

        yield* atoms.mount(costs(costsKey(0)))
        yield* atoms.settled(costs(costsKey(0)))

        const calls: ReadonlyArray<RangeQuery> = yield* stub.calls.costs.all
        assert.strictEqual(calls.length, 1)
        // Both halves matter: the key must be present, and it must be 0. An
        // `hours && …` anywhere on this path drops it and the server silently
        // applies its own default instead.
        assert.isTrue('hours' in calls[0]!, 'hours was dropped entirely')
        assert.strictEqual(calls[0]?.hours, 0)
      }).pipe(Effect.scoped))

    it.effect('memoises structurally, so the same range is the same atom', () =>
      Effect.gen(function*() {
        const { costs } = yield* withCosts({ costs: () => ok() })

        assert.strictEqual(costs(costsKey(168)), costs(costsKey(168)))
        assert.notStrictEqual(costs(costsKey(168)), costs(costsKey(720)))
      }).pipe(Effect.scoped))

    it.effect('a different range is a different atom with its own request', () =>
      Effect.gen(function*() {
        const { atoms, stub, costs } = yield* withCosts({
          costs: query => ok({ hours: query.hours }),
        })

        yield* atoms.mount(costs(costsKey(24)))
        yield* atoms.mount(costs(costsKey(720)))
        const first = yield* atoms.settled(costs(costsKey(24)))
        const second = yield* atoms.settled(costs(costsKey(720)))

        assert.deepStrictEqual(yield* stub.calls.costs.all, [{ hours: 24 }, { hours: 720 }])
        assert.strictEqual(first.value?.hours, 24)
        assert.strictEqual(second.value?.hours, 720)
      }).pipe(Effect.scoped))
  })

  describe('the poll loop', () => {
    it.effect('polls again on the interval, and not before', () =>
      Effect.gen(function*() {
        const { atoms, stub, costs } = yield* withCosts({ costs: () => ok() })
        const feed = costs(costsKey(24))

        yield* atoms.mount(feed)
        yield* atoms.settled(feed)
        assert.strictEqual(yield* stub.calls.costs.count, 1, 'ticks immediately')

        yield* TestClock.adjust('29 seconds')
        assert.strictEqual(yield* stub.calls.costs.count, 1, 'and not again early')

        yield* TestClock.adjust('1 second')
        assert.strictEqual(yield* stub.calls.costs.count, 2)
      }).pipe(Effect.scoped))

    it.effect('a failed poll keeps the previous value and reports the error', () =>
      Effect.gen(function*() {
        const attempts = yield* Ref.make(0)
        const { atoms, costs } = yield* withCosts({
          costs: () =>
            Ref.updateAndGet(attempts, n => n + 1).pipe(
              Effect.flatMap(n =>
                n === 2
                  ? Effect.fail(new ApiUnreachable({ url: '/api/costs', detail: 'connect refused' }))
                  : ok({ sessions: n })),
            ),
        })
        const feed = costs(costsKey(24))
        const read = yield* atoms.recorded(feed)

        yield* atoms.settled(feed)
        yield* TestClock.adjust(INTERVAL)

        const published = feeds(yield* read)
        const stale = published.at(-1)
        assert.strictEqual(stale?.value?.sessions, 1, 'the last good overview survived')
        assert.isNotNull(stale?.error, 'and the failure is reported alongside it')

        // The whole reason the page keeps rendering behind a banner.
        const view = toFeedView(yield* atoms.get(feed))
        assert.strictEqual(view.tag, 'stale')
        assert.strictEqual(
          view.tag === 'stale' ? view.message : '',
          '/api/costs is unreachable: connect refused',
        )
      }).pipe(Effect.scoped))

    it.effect('recovers on the next tick — a failure does not end the loop', () =>
      Effect.gen(function*() {
        const attempts = yield* Ref.make(0)
        const { atoms, stub, costs } = yield* withCosts({
          costs: () =>
            Ref.updateAndGet(attempts, n => n + 1).pipe(
              Effect.flatMap(n =>
                n === 2
                  ? Effect.fail(new ApiUnreachable({ url: '/api/costs', detail: 'down' }))
                  : ok({ sessions: n })),
            ),
        })
        const feed = costs(costsKey(24))
        yield* atoms.mount(feed)

        yield* atoms.settled(feed)
        yield* TestClock.adjust(INTERVAL)
        yield* TestClock.adjust(INTERVAL)

        assert.strictEqual(yield* stub.calls.costs.count, 3, 'the loop kept ticking')
        const view = toFeedView(yield* atoms.get(feed))
        assert.strictEqual(view.tag, 'ready', 'and the banner cleared itself')
        assert.strictEqual(view.tag === 'ready' ? view.value.sessions : -1, 3)
      }).pipe(Effect.scoped))

    it.effect('reports a failure with nothing on screen as an error, not a blank page', () =>
      Effect.gen(function*() {
        const { atoms, costs } = yield* withCosts({
          costs: () => Effect.fail(new ApiUnreachable({ url: '/api/costs', detail: 'offline' })),
        })
        const feed = costs(costsKey(720))

        yield* atoms.mount(feed)
        yield* atoms.settled(feed)

        const view = toFeedView(yield* atoms.get(feed))
        assert.strictEqual(view.tag, 'error')
        assert.strictEqual(
          view.tag === 'error' ? view.message : '',
          '/api/costs is unreachable: offline',
        )
      }).pipe(Effect.scoped))
  })

  describe('the refresh pulse', () => {
    it.effect('polls immediately, without waiting out the interval', () =>
      Effect.gen(function*() {
        const { atoms, stub, costs, refresh } = yield* withCosts({ costs: () => ok() })
        const feed = costs(costsKey(24))
        const next = yield* atoms.published(feed)

        yield* atoms.settled(feed)
        yield* next
        yield* pulseIsLive
        assert.strictEqual(yield* stub.calls.costs.count, 1)

        yield* atoms.set(refresh, undefined)
        yield* next
        // No `TestClock.adjust` anywhere above: the pulse is what polled.
        assert.strictEqual(yield* stub.calls.costs.count, 2)
      }).pipe(Effect.scoped))

    it.effect('leaves the data on screen when the refreshed poll fails', () =>
      Effect.gen(function*() {
        const attempts = yield* Ref.make(0)
        const { atoms, costs, refresh } = yield* withCosts({
          costs: () =>
            Ref.updateAndGet(attempts, n => n + 1).pipe(
              Effect.flatMap(n =>
                n === 1
                  ? ok({ sessions: 7 })
                  : Effect.fail(new ApiUnreachable({ url: '/api/costs', detail: 'connect refused' }))),
            ),
        })
        const feed = costs(costsKey(24))
        const next = yield* atoms.published(feed)

        yield* atoms.settled(feed)
        yield* next
        yield* pulseIsLive
        yield* atoms.set(refresh, undefined)
        yield* next

        // This is the whole reason the pulse exists. `registry.refresh` rebuilds
        // the node, which reconstructs the stream, which runs `initial()` again
        // and throws the accumulated value away — so the same click against the
        // same dead server would blank the page into `error` instead.
        const view = toFeedView(yield* atoms.get(feed))
        assert.strictEqual(view.tag, 'stale')
        assert.strictEqual(view.tag === 'stale' ? view.value.sessions : -1, 7)
      }).pipe(Effect.scoped))

    it.effect('does not poll on its own before anything asks it to', () =>
      Effect.gen(function*() {
        const { atoms, stub, costs, refresh } = yield* withCosts({ costs: () => ok() })
        const feed = costs(costsKey(24))

        yield* atoms.mount(feed)
        yield* atoms.settled(feed)
        // The pulse is a counter, and the feed subscribes without its initial
        // value — reading the current count on start would double the first poll.
        assert.strictEqual(yield* stub.calls.costs.count, 1)
        assert.strictEqual(yield* atoms.get(refresh), 0)
      }).pipe(Effect.scoped))

    it.effect('collapses a burst of clicks into one poll', () =>
      Effect.gen(function*() {
        const { atoms, stub, costs, refresh } = yield* withCosts({ costs: () => ok() })
        const feed = costs(costsKey(24))
        const next = yield* atoms.published(feed)

        yield* atoms.settled(feed)
        yield* next
        yield* pulseIsLive

        // Ten clicks with no chance to breathe between them — a double-click, or
        // an impatient user on a page that has not visibly changed yet.
        for (let click = 0; click < 10; click++) yield* atoms.set(refresh, undefined)
        yield* next

        // One. Each pulse is an element of the merged stream and `mapAccumEffect`
        // runs them one at a time, so unbuffered this would be ten *whole*
        // sequential fetches of the slowest route the dashboard has — the one
        // this file gave a thirty-second interval precisely because it re-reads
        // every transcript in the range. A queued "poll now" already answers
        // every later click behind it.
        assert.strictEqual(yield* stub.calls.costs.count, 2)

        // And the click still works: coalescing must not mean swallowing.
        yield* pulseIsLive
        yield* atoms.set(refresh, undefined)
        yield* next
        assert.strictEqual(yield* stub.calls.costs.count, 3)
      }).pipe(Effect.scoped))
  })

  describe('the stub itself', () => {
    it.effect('an endpoint the test did not script is a named defect', () =>
      Effect.gen(function*() {
        const { atoms, costs } = yield* withCosts({})
        const feed = costs(costsKey(24))

        yield* atoms.mount(feed)
        const exit = yield* Effect.exit(atoms.settled(feed))

        assert.isTrue(exit._tag === 'Failure', 'an unstubbed route must not answer')
        assert.include(
          exit._tag === 'Failure' ? String(Cause.squash(exit.cause)) : '',
          'Unimplemented method "costs"',
        )
      }).pipe(Effect.scoped))
  })
})
