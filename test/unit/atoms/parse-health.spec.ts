import { assert, describe, it } from '@effect/vitest'
import { Effect, Ref } from 'effect'
import { TestClock } from 'effect/testing'
import type { RangeQuery } from '~/api/api'
import { ApiUnreachable } from '~/api/errors'
import { makeParseHealthAtoms, parseHealthKey } from '~/atoms/parse-health'
import { toFeedView } from '~/utils/feed-view'
import { testAtoms } from '../../fixtures/atom-registry'
import { parseHealthResponse, sessionParseHealth } from '../../fixtures/runs'
import { stubApi, type StubApiHandlers } from '../../fixtures/stub-api'

/** The cadence `app/atoms/parse-health.ts` chose, restated so a change fails here. */
const INTERVAL = '30 seconds'

const withParseHealth = Effect.fn('withParseHealth')(function*(handlers: StubApiHandlers) {
  const stub = stubApi(handlers)
  const atoms = yield* testAtoms(stub.layer)
  const { parseHealth, refresh } = makeParseHealthAtoms(atoms.runtime)
  return { atoms, stub, parseHealth, refresh }
})

const ok = (sessions = [sessionParseHealth()]) =>
  Effect.succeed(parseHealthResponse(sessions))

/**
 * Yields until the feed's subscription to the pulse atom is live.
 *
 * The merged pulse stream registers its listener in a forked fiber, a scheduler
 * turn after the feed publishes its first value, and a pulse fired before then
 * is not queued — it is simply not seen. Nothing in the browser can click a
 * button inside that window, but a test can, and the failure looks like a hang.
 */
const pulseIsLive = Effect.yieldNow

describe('parse health atoms', () => {
  describe('the family key', () => {
    it.effect('sends the requested hours on the first poll', () =>
      Effect.gen(function*() {
        const { atoms, stub, parseHealth } = yield* withParseHealth({ parseHealth: () => ok() })
        const feed = parseHealth(parseHealthKey(24))

        yield* atoms.mount(feed)
        yield* atoms.settled(feed)

        assert.deepStrictEqual(yield* stub.calls.parseHealth.all, [{ hours: 24 }])
      }).pipe(Effect.scoped))

    it.effect('sends hours=0, which means all time and is not a missing value', () =>
      Effect.gen(function*() {
        const { atoms, stub, parseHealth } = yield* withParseHealth({ parseHealth: () => ok() })
        const feed = parseHealth(parseHealthKey(0))

        yield* atoms.mount(feed)
        yield* atoms.settled(feed)

        const calls: ReadonlyArray<RangeQuery> = yield* stub.calls.parseHealth.all
        // Both halves matter: the key must be present, and it must be 0. An
        // `hours && …` anywhere on this path drops it and the server quietly
        // applies its own default instead — the debug page would then report
        // parse health for a range nobody asked for.
        assert.isTrue('hours' in calls[0]!, 'hours was dropped entirely')
        assert.strictEqual(calls[0]?.hours, 0)
      }).pipe(Effect.scoped))

    it.effect('memoises structurally, so the same range is the same atom', () =>
      Effect.gen(function*() {
        const { parseHealth } = yield* withParseHealth({ parseHealth: () => ok() })

        assert.strictEqual(parseHealth(parseHealthKey(168)), parseHealth(parseHealthKey(168)))
        assert.notStrictEqual(parseHealth(parseHealthKey(168)), parseHealth(parseHealthKey(720)))
      }).pipe(Effect.scoped))
  })

  describe('the poll loop', () => {
    it.effect('polls again on the interval, and not before', () =>
      Effect.gen(function*() {
        const { atoms, stub, parseHealth } = yield* withParseHealth({ parseHealth: () => ok() })
        const feed = parseHealth(parseHealthKey(24))

        yield* atoms.mount(feed)
        yield* atoms.settled(feed)
        assert.strictEqual(yield* stub.calls.parseHealth.count, 1, 'ticks immediately')

        yield* TestClock.adjust('29 seconds')
        assert.strictEqual(yield* stub.calls.parseHealth.count, 1, 'and not again early')

        yield* TestClock.adjust('1 second')
        assert.strictEqual(yield* stub.calls.parseHealth.count, 2)
      }).pipe(Effect.scoped))

    it.effect('keeps the last report on screen when a poll fails', () =>
      Effect.gen(function*() {
        const attempts = yield* Ref.make(0)
        const { atoms, parseHealth } = yield* withParseHealth({
          parseHealth: () =>
            Ref.updateAndGet(attempts, n => n + 1).pipe(
              Effect.flatMap(n =>
                n === 2
                  ? Effect.fail(new ApiUnreachable({ url: '/api/debug', detail: 'connect refused' }))
                  : ok([sessionParseHealth({ key: `session-${n}` })])),
            ),
        })
        const feed = parseHealth(parseHealthKey(24))

        yield* atoms.mount(feed)
        yield* atoms.settled(feed)
        yield* TestClock.adjust(INTERVAL)

        // The page goes stale over what it has rather than blanking. This is
        // the whole reason the loop folds failures into the value instead of
        // failing the stream.
        const view = toFeedView(yield* atoms.get(feed))
        assert.strictEqual(view.tag, 'stale')
        assert.strictEqual(
          view.tag === 'stale' ? view.value.sessions[0]?.key : '',
          'session-1',
        )
        assert.strictEqual(
          view.tag === 'stale' ? view.message : '',
          '/api/debug is unreachable: connect refused',
        )
      }).pipe(Effect.scoped))

    it.effect('recovers on the next tick — a failure does not end the loop', () =>
      Effect.gen(function*() {
        const attempts = yield* Ref.make(0)
        const { atoms, stub, parseHealth } = yield* withParseHealth({
          parseHealth: () =>
            Ref.updateAndGet(attempts, n => n + 1).pipe(
              Effect.flatMap(n =>
                n === 2
                  ? Effect.fail(new ApiUnreachable({ url: '/api/debug', detail: 'down' }))
                  : ok()),
            ),
        })
        const feed = parseHealth(parseHealthKey(24))

        yield* atoms.mount(feed)
        yield* atoms.settled(feed)
        yield* TestClock.adjust(INTERVAL)
        yield* TestClock.adjust(INTERVAL)

        // Thirty seconds is slow enough that this is the only thing making the
        // banner clear itself: the page has no other reason to re-read.
        assert.strictEqual(yield* stub.calls.parseHealth.count, 3, 'the loop kept ticking')
        assert.strictEqual(toFeedView(yield* atoms.get(feed)).tag, 'ready')
      }).pipe(Effect.scoped))

    it.effect('reports a failure with nothing on screen as an error', () =>
      Effect.gen(function*() {
        const { atoms, parseHealth } = yield* withParseHealth({
          parseHealth: () => Effect.fail(new ApiUnreachable({ url: '/api/debug', detail: 'offline' })),
        })
        const feed = parseHealth(parseHealthKey(720))

        yield* atoms.mount(feed)
        yield* atoms.settled(feed)

        const view = toFeedView(yield* atoms.get(feed))
        assert.strictEqual(view.tag, 'error')
        assert.strictEqual(
          view.tag === 'error' ? view.message : '',
          '/api/debug is unreachable: offline',
        )
      }).pipe(Effect.scoped))
  })

  describe('the refresh pulse', () => {
    it.effect('re-reads at once, without waiting out the interval', () =>
      Effect.gen(function*() {
        const { atoms, stub, parseHealth, refresh } = yield* withParseHealth({
          parseHealth: () => ok(),
        })
        const feed = parseHealth(parseHealthKey(24))
        const next = yield* atoms.published(feed)

        yield* atoms.settled(feed)
        yield* next
        yield* pulseIsLive
        assert.strictEqual(yield* stub.calls.parseHealth.count, 1)

        yield* atoms.set(refresh, undefined)
        yield* next

        // No `TestClock.adjust` anywhere above: the pulse is what polled.
        assert.strictEqual(yield* stub.calls.parseHealth.count, 2)
      }).pipe(Effect.scoped))

    it.effect('leaves the report on screen when the refreshed read fails', () =>
      Effect.gen(function*() {
        const attempts = yield* Ref.make(0)
        const { atoms, parseHealth, refresh } = yield* withParseHealth({
          parseHealth: () =>
            Ref.updateAndGet(attempts, n => n + 1).pipe(
              Effect.flatMap(n =>
                n === 1
                  ? ok([sessionParseHealth({ key: 'session-kept' })])
                  : Effect.fail(new ApiUnreachable({ url: '/api/debug', detail: 'connect refused' }))),
            ),
        })
        const feed = parseHealth(parseHealthKey(24))
        const next = yield* atoms.published(feed)

        yield* atoms.settled(feed)
        yield* next
        yield* pulseIsLive
        yield* atoms.set(refresh, undefined)
        yield* next

        // Why the pulse exists rather than `registry.refresh`. Refreshing
        // rebuilds the node, which reconstructs the stream, which runs
        // `initial()` again and throws the accumulated value away — so the same
        // click against the same dead server would blank the page into `error`.
        const view = toFeedView(yield* atoms.get(feed))
        assert.strictEqual(view.tag, 'stale')
        assert.strictEqual(view.tag === 'stale' ? view.value.sessions[0]?.key : '', 'session-kept')
      }).pipe(Effect.scoped))

    it.effect('does not poll on its own before anything asks it to', () =>
      Effect.gen(function*() {
        const { atoms, stub, parseHealth, refresh } = yield* withParseHealth({
          parseHealth: () => ok(),
        })
        const feed = parseHealth(parseHealthKey(24))

        yield* atoms.mount(feed)
        yield* atoms.settled(feed)

        // The pulse is a counter, and the feed subscribes without its initial
        // value — reading the current count on start would double the first
        // read. The `get.once` in the atom is what keeps the *first* click from
        // doing the same: an unevaluated node is evaluated by its first write,
        // which notifies with the initial value and then the written one.
        assert.strictEqual(yield* stub.calls.parseHealth.count, 1)
        assert.strictEqual(yield* atoms.get(refresh), 0)
      }).pipe(Effect.scoped))

    it.effect('collapses a burst of clicks into one read', () =>
      Effect.gen(function*() {
        const { atoms, stub, parseHealth, refresh } = yield* withParseHealth({
          parseHealth: () => ok(),
        })
        const feed = parseHealth(parseHealthKey(24))
        const next = yield* atoms.published(feed)

        yield* atoms.settled(feed)
        yield* next
        yield* pulseIsLive

        for (let click = 0; click < 10; click++) yield* atoms.set(refresh, undefined)
        yield* next

        // `/api/debug` re-scans every transcript in the range. Ten clicks used
        // to mean ten of those, run one after another.
        assert.strictEqual(yield* stub.calls.parseHealth.count, 2)
      }).pipe(Effect.scoped))
  })
})
