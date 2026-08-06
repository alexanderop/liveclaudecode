import type { Duration } from 'effect'
import { Effect, Stream } from 'effect'
import type { ApiError } from '~/api/errors'

/**
 * One polled resource.
 *
 * `value` is the last thing the server returned and is never cleared by a
 * failure; `error` is the outcome of the most recent attempt. Together they are
 * the typed form of "keep showing stale data behind an offline banner", which
 * the hand-rolled pollers achieved by returning early on a `null` response.
 */
export interface Feed<A> {
  readonly value: A | null
  readonly error: ApiError | null
}

/**
 * Polls `fetch` on `interval`, threading the cursor state `S` across ticks.
 *
 * `Stream.tick` emits immediately on the first pull and delays only subsequent
 * ones (`repos/effect/packages/effect/src/Stream.ts:570-582`), which is the
 * load-then-interval behaviour the hand-rolled pollers have.
 *
 * The `Effect.catch` is load-bearing. A stream that fails is a stream that has
 * ENDED: `makeStream` writes the failure into the node and returns `Effect.void`
 * with nothing left to re-arm the loop
 * (`repos/effect/packages/effect/src/unstable/reactivity/Atom.ts:852-874`). A
 * poll loop that ends on the first hiccup never recovers, so a `pnpm dev`
 * restart would leave a frozen dashboard behind a banner that never clears.
 * Folding the failure into the emitted value keeps the loop alive and keeps the
 * last good value on screen.
 *
 * Defects still terminate the stream, which is correct — a defect is a bug, not
 * a network blip.
 */
export const pollingFeed = <S, A, R>(options: {
  readonly interval: Duration.Input
  readonly initial: () => S
  readonly fetch: (state: S) => Effect.Effect<readonly [S, A], ApiError, R>
}): Stream.Stream<Feed<A>, never, R> => {
  /** The cursor plus the newest value, threaded across ticks. */
  interface Accumulated {
    readonly state: S
    readonly last: A | null
  }

  const tick = (
    acc: Accumulated,
  ): Effect.Effect<readonly [Accumulated, ReadonlyArray<Feed<A>>], never, R> =>
    options.fetch(acc.state).pipe(
      Effect.map(([state, value]) => [{ state, last: value }, [{ value, error: null }]] as const),
      // Keep the cursor and the last value; report the failure alongside.
      Effect.catch(error => Effect.succeed([acc, [{ value: acc.last, error }]] as const)),
    )

  return Stream.tick(options.interval).pipe(
    Stream.mapAccumEffect((): Accumulated => ({ state: options.initial(), last: null }), tick),
  )
}
