import * as Atom from 'effect/unstable/reactivity/Atom'

/**
 * One holder of a target appearing (`1`) or disappearing (`-1`).
 *
 * A `-1` must pair with exactly one `+1`, which is why the components that write
 * these remember what they announced rather than recomputing it at teardown: a
 * target that changed between the two calls would otherwise decrement the wrong
 * entry and strand the old one at a permanent `+1`.
 */
export interface Activation<T> {
  readonly target: T
  readonly delta: 1 | -1
}

/** A counted record of what is on screen, and the per-tick question about it. */
export interface ActivationAtoms<T> {
  /** Write an {@link Activation} here; nothing subscribes to the value. */
  readonly atom: Atom.Writable<ReadonlyMap<string, number>, Activation<T>>
  /**
   * Whether anything is currently showing `target`.
   *
   * Reads with `AtomContext.once`, which is synchronous and observes the live
   * registry value from inside a running stream. A tracked `get` would make the
   * feed a dependent of this map and rebuild its stream every time any panel
   * appeared or vanished, discarding the cursor the gate exists to protect.
   */
  readonly shows: (get: Atom.AtomContext, target: T) => boolean
}

/**
 * A counted map of which targets are being shown, by identity.
 *
 * Counted rather than a flag because two panels can be showing the *same*
 * target at once — the session panel and the inspector are routinely handed the
 * same session key, and the activity view and the inspector overlay can be
 * reading the same transcript. A shared boolean would let either one's teardown
 * stop the other's poll.
 *
 * This is what lets a feed **pause without dying**. The alternative — putting
 * "is anyone looking" in the `Atom.family` key — makes a hidden feed a different
 * atom and a different node, so resuming refetches everything the cursor had
 * already collected. Here the flag is read per tick, a tick it turns away emits
 * nothing, and the accumulator is handed straight back.
 *
 * `keepAlive` is load-bearing, not an optimisation: nothing ever *subscribes* to
 * this map. It is written by whatever is on screen and read with `once` from
 * inside running streams, so the registry's idle sweep would otherwise discard
 * it between a write and the next tick and hand every reader an empty map —
 * every visible panel silently stops polling.
 */
export const makeActivation = <T>(identify: (target: T) => string): ActivationAtoms<T> => {
  const atom: Atom.Writable<ReadonlyMap<string, number>, Activation<T>> = Atom.writable<
    ReadonlyMap<string, number>,
    Activation<T>
  >(
    () => new Map(),
    (ctx, activation) => {
      const id = identify(activation.target)
      const next = new Map(ctx.get(atom))
      const count = (next.get(id) ?? 0) + activation.delta
      // Deleted rather than left at zero: the map is read as "what is on
      // screen", and an entry that is only ever compared against zero would
      // grow one key per target the dashboard has ever shown.
      if (count > 0) next.set(id, count)
      else next.delete(id)
      ctx.setSelf(next)
    },
  ).pipe(Atom.keepAlive)

  return {
    atom,
    shows: (get, target) => (get.once(atom).get(identify(target)) ?? 0) > 0,
  }
}
