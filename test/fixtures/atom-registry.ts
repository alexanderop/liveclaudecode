import type { Scope } from 'effect'
import { Clock, Effect, Layer, Queue } from 'effect'
import type * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import * as Atom from 'effect/unstable/reactivity/Atom'
import * as AtomRegistry from 'effect/unstable/reactivity/AtomRegistry'

export interface TestAtoms<R> {
  /** The registry every helper below reads and writes through. */
  readonly registry: AtomRegistry.AtomRegistry
  /** A runtime bound to this test's layer and this test's `Layer.MemoMap`. */
  readonly runtime: Atom.AtomRuntime<R>
  readonly get: <A>(atom: Atom.Atom<A>) => Effect.Effect<A>
  readonly set: <R2, W>(atom: Atom.Writable<R2, W>, value: W) => Effect.Effect<void>
  readonly refresh: <A>(atom: Atom.Atom<A>) => Effect.Effect<void>
  /**
   * Suspends until the atom leaves `Initial`.
   *
   * Deliberately not `suspendOnWaiting: true`: a stream-backed atom sets
   * `waiting` on every chunk and clears it only when the stream ends
   * (`Atom.ts:846-849`), so suspending on `waiting` never returns for a poll
   * loop.
   */
  readonly settled: <A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) => Effect.Effect<A, E>
  /** Keeps an atom alive for the rest of the test scope, the way a mount would. */
  readonly mount: <A>(atom: Atom.Atom<A>) => Effect.Effect<void, never, Scope.Scope>
  /** Mounts the atom and records every value it publishes, oldest first. */
  readonly recorded: <A>(
    atom: Atom.Atom<A>,
  ) => Effect.Effect<Effect.Effect<ReadonlyArray<A>>, never, Scope.Scope>
  /**
   * Mounts the atom and hands back "take the next value it publishes".
   *
   * `recorded` answers what an atom has published *so far*, which needs the test
   * to know when to look. This suspends until it publishes again, which is what
   * an out-of-band trigger needs: there is no interval to advance and no request
   * effect to await. Values published before the take are buffered, so drain the
   * first poll before triggering the second.
   */
  readonly published: <A>(
    atom: Atom.Atom<A>,
  ) => Effect.Effect<Effect.Effect<A>, never, Scope.Scope>
}

/**
 * An isolated atom runtime and registry for one `it.effect` case.
 *
 * The runtime gets its own `Layer.MemoMap`, so no service build is memoized
 * across tests — `Atom.defaultMemoMap` is a process-wide singleton with no way
 * to clear it, which is exactly what `Atom.runtime` uses.
 *
 * The runtime is also handed the *ambient* `Clock`. Under `it.effect` that is
 * the `TestClock`, and it is what makes `TestClock.adjust` drive an
 * `Effect.sleep` inside an atom: `makeStream` forks the stream with the services
 * map derived from the layer's context (`Atom.ts:876-885`), so a `Clock`
 * override in the layer reaches the poll loop. Without the
 * `Layer.succeed(Clock.Clock, clock)` line the atom silently gets the live clock
 * and every timing assertion becomes a real-time race that usually passes.
 *
 * Note this does NOT reach `Atom.setIdleTTL` or the registry's `defaultIdleTTL`,
 * which use raw `setTimeout` and `Date.now()` (`AtomRegistry.ts:501-508`), nor
 * node removal, which is scheduled as a macrotask. Those need real time.
 *
 * The registry is disposed with the test scope.
 */
export const testAtoms = Effect.fn('testAtoms')(function* <R>(layer: Layer.Layer<R>) {
  const clock = yield* Clock.clockWith(Effect.succeed)
  const runtime: Atom.AtomRuntime<R> = Atom.context({ memoMap: Layer.makeMemoMapUnsafe() })(
    Layer.provideMerge(layer, Layer.succeed(Clock.Clock, clock)),
  )
  const registry = AtomRegistry.make()
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()))

  const mount = <A>(atom: Atom.Atom<A>) =>
    Effect.acquireRelease(
      Effect.sync(() => registry.mount(atom)),
      unmount => Effect.sync(unmount),
    ).pipe(Effect.asVoid)

  return {
    registry,
    runtime,
    get: <A>(atom: Atom.Atom<A>) => Effect.sync(() => registry.get(atom)),
    set: <R2, W>(atom: Atom.Writable<R2, W>, value: W) =>
      Effect.sync(() => registry.set(atom, value)),
    refresh: <A>(atom: Atom.Atom<A>) => Effect.sync(() => registry.refresh(atom)),
    settled: <A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) =>
      AtomRegistry.getResult(registry, atom),
    mount,
    recorded: <A>(atom: Atom.Atom<A>) =>
      Effect.sync(() => {
        const values: Array<A> = []
        const unsubscribe = registry.subscribe(atom, value => void values.push(value), {
          immediate: true,
        })
        return { values, unsubscribe }
      }).pipe(
        Effect.tap(({ unsubscribe }) => Effect.addFinalizer(() => Effect.sync(unsubscribe))),
        Effect.map(({ values }) => Effect.sync((): ReadonlyArray<A> => [...values])),
      ),
    published: <A>(atom: Atom.Atom<A>) =>
      Effect.gen(function*() {
        const queue = yield* Queue.make<A>()
        const unsubscribe = registry.subscribe(atom, value => void Queue.offerUnsafe(queue, value))
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe))
        return Queue.take(queue)
      }),
  } satisfies TestAtoms<R>
})
