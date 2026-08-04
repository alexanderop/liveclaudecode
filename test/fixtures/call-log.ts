import { Effect, Ref } from 'effect'

/**
 * An append-only record of the calls a stub observed.
 *
 * Stubs that need to prove *what* they were called with reach for this instead
 * of a captured array. The state lives in a `Ref` created when the log is
 * created, so every construction gets its own — which is what keeps the
 * observation out of module scope and off any `beforeEach` reset list, and
 * keeps `it.only` behaving the same as a full run.
 */
export interface CallLog<A> {
  /** Append one observed call. */
  readonly record: (value: A) => Effect.Effect<void>
  /** Everything recorded so far, oldest first. */
  readonly all: Effect.Effect<ReadonlyArray<A>>
  /** How many calls have been recorded. */
  readonly count: Effect.Effect<number>
}

/** Create a fresh call log. Build one per layer, never per module. */
export function makeCallLog<A>(): Effect.Effect<CallLog<A>> {
  return Effect.gen(function*() {
    const entries = yield* Ref.make<ReadonlyArray<A>>([])
    return {
      record: value => Ref.update(entries, current => [...current, value]),
      all: Ref.get(entries),
      count: Ref.get(entries).pipe(Effect.map(current => current.length)),
    }
  })
}
