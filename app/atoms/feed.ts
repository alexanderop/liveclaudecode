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
 *
 * `pulses` is how a refresh button asks for a poll *now*. It must be an
 * out-of-band stream rather than `registry.refresh`, because refreshing a stream
 * atom rebuilds the node: the stream is constructed again, `initial()` runs
 * again, and the accumulated `last` value is lost — so a refresh against a
 * server that is down would empty the screen instead of going stale over the
 * data already on it. Merging into the running stream keeps the accumulator.
 * `AtomContext.stream` is the source to hand in: it subscribes rather than
 * registering a parent, so the pulse cannot rebuild the node either
 * (`repos/effect/packages/effect/src/unstable/reactivity/AtomRegistry.ts:973`).
 *
 * `enabled` is how a feed stops without dying. It is read per tick, and a tick
 * it turns away emits **nothing** — the accumulator is handed straight back, so
 * the cursor survives and a resumed feed continues where it left off instead of
 * refetching from zero. Re-keying the family would achieve the pause and lose
 * exactly that; see §3.9. The predicate is synchronous because the only caller
 * reads an atom with `AtomContext.once`, which is synchronous and observes the
 * live registry value from inside the running stream (experiment E7).
 */
export const pollingFeed = <S, A, R>(options: {
  readonly interval: Duration.Input
  readonly initial: () => S
  readonly fetch: (state: S) => Effect.Effect<readonly [S, A], ApiError, R>
  readonly pulses?: Stream.Stream<unknown> | undefined
  readonly enabled?: (() => boolean) | undefined
}): Stream.Stream<Feed<A>, never, R> => {
  /** The cursor plus the newest value, threaded across ticks. */
  interface Accumulated {
    readonly state: S
    readonly last: A | null
  }

  const tick = (
    acc: Accumulated,
  ): Effect.Effect<readonly [Accumulated, ReadonlyArray<Feed<A>>], never, R> =>
    options.enabled && !options.enabled()
      // No request, and no emission either: a paused feed has observed nothing,
      // so republishing the last value would only re-render every subscriber on
      // a timer for as long as the panel stays hidden.
      ? Effect.succeed([acc, []] as const)
      : options.fetch(acc.state).pipe(
          Effect.map(([state, value]) =>
            [{ state, last: value }, [{ value, error: null }]] as const),
          // Keep the cursor and the last value; report the failure alongside.
          Effect.catch(error => Effect.succeed([acc, [{ value: acc.last, error }]] as const)),
        )

  const ticks: Stream.Stream<unknown> = options.pulses
    ? Stream.merge(Stream.tick(options.interval), options.pulses)
    : Stream.tick(options.interval)

  // `mapAccumEffect` is sequential over the merged stream, so a pulse that lands
  // mid-request queues behind it rather than racing it.
  return ticks.pipe(
    Stream.mapAccumEffect((): Accumulated => ({ state: options.initial(), last: null }), tick),
  )
}
