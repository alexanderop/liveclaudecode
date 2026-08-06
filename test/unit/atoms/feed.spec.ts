import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer, Ref, Stream } from 'effect'
import { TestClock } from 'effect/testing'
import { ApiUnreachable } from '~/api/errors'
import { type Feed, pollingFeed } from '~/atoms/feed'
import { testAtoms } from '../../fixtures/atom-registry'

const INTERVAL = '10 seconds'

/**
 * `pollingFeed` on its own, with no `Api` behind it.
 *
 * Every other atom spec exercises this helper through the feed it happens to
 * build, which is the right level for "does the run tree page correctly" and the
 * wrong one for the helper's own contract — the pause rule and the pulse rule
 * are shared by six feeds and belong to none of them.
 */
const withFeed = Effect.fn('withFeed')(function*(options: {
  readonly enabled?: (() => boolean) | undefined
  readonly pulses?: Stream.Stream<unknown> | undefined
  readonly fail?: ((attempt: number) => boolean) | undefined
} = {}) {
  const atoms = yield* testAtoms(Layer.empty)
  const attempts = yield* Ref.make(0)

  /**
   * Counts its calls and returns the count, so the emitted value doubles as
   * "how many requests reached the server" and the cursor doubles as proof the
   * accumulator survived.
   */
  const feed = atoms.runtime.atom(() =>
    pollingFeed({
      interval: INTERVAL,
      initial: () => 0,
      ...(options.enabled && { enabled: options.enabled }),
      ...(options.pulses && { pulses: options.pulses }),
      fetch: (cursor: number) =>
        Effect.gen(function*() {
          const attempt = yield* Ref.updateAndGet(attempts, n => n + 1)
          if (options.fail?.(attempt)) {
            return yield* new ApiUnreachable({ url: '/api/thing', detail: 'refused' })
          }
          return [cursor + 1, { cursor: cursor + 1, attempt }] as const
        }),
    }))

  return { atoms, feed, requests: Ref.get(attempts) }
})

/** The value a feed is holding, or null while it has none. */
const held = <A>(feed: Feed<A>): A | null => feed.value

describe('pollingFeed', () => {
  describe('pausing', () => {
    it.effect('makes no request on a tick it is turned away', () =>
      Effect.gen(function*() {
        const { atoms, feed, requests } = yield* withFeed({ enabled: () => false })

        yield* atoms.mount(feed)
        yield* TestClock.adjust(INTERVAL)
        yield* TestClock.adjust(INTERVAL)

        assert.strictEqual(yield* requests, 0)
      }).pipe(Effect.scoped))

    it.effect('publishes nothing while paused, rather than republishing the last value', () =>
      Effect.gen(function*() {
        let enabled = true
        const { atoms, feed } = yield* withFeed({ enabled: () => enabled })
        const read = yield* atoms.recorded(feed)

        yield* atoms.settled(feed)
        const whileRunning = (yield* read).length
        enabled = false
        yield* TestClock.adjust(INTERVAL)
        yield* TestClock.adjust(INTERVAL)

        // A paused feed has observed nothing, so it says nothing. Emitting the
        // held value again would re-render every subscriber on a timer for as
        // long as the panel stayed hidden.
        assert.strictEqual((yield* read).length, whileRunning)
      }).pipe(Effect.scoped))

    it.effect('resumes from the cursor it had, not from the beginning', () =>
      Effect.gen(function*() {
        let enabled = true
        const { atoms, feed } = yield* withFeed({ enabled: () => enabled })

        yield* atoms.mount(feed)
        yield* atoms.settled(feed)
        yield* TestClock.adjust(INTERVAL)
        enabled = false
        yield* TestClock.adjust(INTERVAL)
        yield* TestClock.adjust(INTERVAL)
        enabled = true
        yield* TestClock.adjust(INTERVAL)

        // Three requests, and the third carried the cursor the second left. This
        // is the difference between pausing a feed and re-keying it: re-keying
        // builds a second atom whose `initial()` starts over.
        assert.strictEqual(held(yield* atoms.settled(feed))?.cursor, 3)
      }).pipe(Effect.scoped))

    it.effect('keeps the value on screen while it is paused', () =>
      Effect.gen(function*() {
        let enabled = true
        const { atoms, feed } = yield* withFeed({ enabled: () => enabled })

        yield* atoms.mount(feed)
        yield* atoms.settled(feed)
        enabled = false
        yield* TestClock.adjust(INTERVAL)

        // Hiding a panel must not blank it. Coming back to a conversation shows
        // what it said before, at once, while the resumed poll catches up.
        assert.strictEqual(held(yield* atoms.settled(feed))?.attempt, 1)
      }).pipe(Effect.scoped))
  })

  describe('pulses', () => {
    it.effect('keeps ticking after its pulse stream ends', () =>
      Effect.gen(function*() {
        const { atoms, feed, requests } = yield* withFeed({
          // One pulse, and then the source completes.
          pulses: Stream.fromEffect(Effect.void),
        })

        yield* atoms.mount(feed)
        yield* atoms.settled(feed)
        // Let the one pulse land and the source complete before counting, so
        // what follows measures the interval alone.
        yield* TestClock.adjust('1 milli')
        const afterStart = yield* requests
        yield* TestClock.adjust(INTERVAL)
        yield* TestClock.adjust(INTERVAL)

        // `Stream.merge` halts when *both* sides do, and the tick side never
        // does. Were that default ever `"either"`, a pulse source that finished
        // would take the whole poll loop down with it and the feed would freeze
        // with nothing on screen to say why.
        assert.strictEqual(yield* requests, afterStart + 2)
      }).pipe(Effect.scoped))

    it.effect('collapses a burst into one extra poll', () =>
      Effect.gen(function*() {
        const { atoms, feed, requests } = yield* withFeed({
          pulses: Stream.fromArray(Array.from({ length: 10 }, () => undefined)),
        })

        yield* atoms.mount(feed)
        yield* atoms.settled(feed)
        yield* TestClock.adjust('1 milli')

        // Ten pulses ready at once buy one poll on top of the feed's own first
        // tick — not ten. Each pulse is an element of the merged stream and
        // `mapAccumEffect` runs one element at a time, so unbuffered this is ten
        // whole sequential fetches of whatever route the feed serves.
        assert.strictEqual(yield* requests, 2)
      }).pipe(Effect.scoped))
  })

  describe('failure', () => {
    it.effect('folds a failed request into the value and keeps ticking', () =>
      Effect.gen(function*() {
        const { atoms, feed, requests } = yield* withFeed({ fail: attempt => attempt === 2 })

        yield* atoms.mount(feed)
        yield* atoms.settled(feed)
        yield* TestClock.adjust(INTERVAL)
        yield* TestClock.adjust(INTERVAL)

        // A stream that fails is a stream that has ended, and nothing re-arms
        // the loop — so a single hiccup would freeze the dashboard behind a
        // banner that never clears.
        assert.strictEqual(yield* requests, 3)
        assert.strictEqual(held(yield* atoms.settled(feed))?.attempt, 3)
      }).pipe(Effect.scoped))

    it.effect('does not advance the cursor over a failed request', () =>
      Effect.gen(function*() {
        const { atoms, feed } = yield* withFeed({ fail: attempt => attempt === 2 })

        yield* atoms.mount(feed)
        yield* atoms.settled(feed)
        yield* TestClock.adjust(INTERVAL)
        yield* TestClock.adjust(INTERVAL)

        // Two successes over three attempts. A cursor advanced by the failed
        // one would have skipped whatever it was going to return.
        assert.strictEqual(held(yield* atoms.settled(feed))?.cursor, 2)
      }).pipe(Effect.scoped))
  })
})
