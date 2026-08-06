import { Effect } from 'effect'
import * as Atom from 'effect/unstable/reactivity/Atom'
import { Api } from '~/api/api'
import { pollingFeed } from './feed'
import { appRuntime } from './runtime'

/**
 * How often the cost overview re-reads the server.
 *
 * Deliberately far slower than the run tree's four seconds. `/api/costs`
 * aggregates every transcript of every harness across the whole selected range,
 * so it is the most expensive route the dashboard has, and the page it feeds is
 * a review surface — nobody watches a thirty-day spend total tick. The refresh
 * button covers "I want it now".
 *
 * It is not zero, though, and that is the point of having an interval at all:
 * the loop is what makes the offline banner clear itself. Stop the dev server
 * and the page goes stale over the data it already has; start it again and the
 * next tick restores it without a reload. Thirty seconds keeps that recovery
 * inside a single page view without polling like a live tail.
 */
const POLL_INTERVAL = '30 seconds'

/**
 * The family key for the costs feed.
 *
 * `hours: 0` means "all time". It is a real value the server is asked for, not
 * a missing one — never treat it as falsy.
 */
export interface CostsKey {
  readonly hours: number
}

/**
 * The one constructor for a {@link CostsKey}; call sites never inline a literal.
 *
 * `Atom.family` memoises on structural equality, so an explicitly-`undefined`
 * property is a *different* key from an absent one and an optional spread would
 * silently split the cache. Funnelling every key through one function is what
 * keeps that from happening.
 */
export const costsKey = (hours: number): CostsKey => ({ hours })

/**
 * The cost overview, polled per range.
 *
 * `costs(key)` is a stream-backed atom, so its `AsyncResult` is permanently
 * `waiting` and its per-tick effect cannot fail. Read it through `toFeedView`,
 * never through `matchWithWaiting` or `result.waiting`.
 *
 * Nothing else is derived here except `refresh`: everything the page computes on
 * top of this response also depends on which harness the user has selected,
 * which is view-local state and stays in the component.
 */
export const makeCostsAtoms = (runtime: Atom.AtomRuntime<Api>) => {
  /**
   * "Poll now." Every mounted range feed merges this into its tick stream.
   *
   * A counter rather than a signal because the registry only notifies
   * subscribers when a value actually changes; writing the same value twice
   * would be one pulse. The number itself is never read by anything.
   *
   * `keepAlive` so a refresh issued while nothing is mounted — or between the
   * two renders of a range change — does not resurrect the node at 0 and lose
   * the pulse.
   */
  const refresh: Atom.Writable<number, void> = Atom.writable<number, void>(
    () => 0,
    ctx => ctx.setSelf(ctx.get(refresh) + 1),
  ).pipe(Atom.keepAlive)

  return {
    refresh,
    costs: Atom.family((key: CostsKey) =>
      runtime.atom((get) => {
        // Materialise the pulse before subscribing to it. A node that has never
        // been read is evaluated by its first *write*, which notifies listeners
        // with the initial value and then again with the written one — so the
        // first click of Refresh would poll twice. `once` reads without making
        // the pulse a dependency, which would rebuild this atom per pulse.
        get.once(refresh)
        return pollingFeed({
          interval: POLL_INTERVAL,
          // No cursor: every poll returns the whole overview for the range.
          initial: () => null,
          // `withoutInitialValue` or the counter's current value would poll a
          // second time the moment the feed starts.
          pulses: get.stream(refresh, { withoutInitialValue: true }),
          fetch: () =>
            Effect.gen(function*() {
              const api = yield* Api
              const response = yield* api.costs({ hours: key.hours })
              return [null, response] as const
            }),
        })
      })),
  }
}

/** The live instance every component reads. Tests call the factory instead. */
export const costsAtoms = makeCostsAtoms(appRuntime)
