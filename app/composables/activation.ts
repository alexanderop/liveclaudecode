import type { Activation } from '~/atoms/activation'
import { useAtomSet } from '@effect/atom-vue'
import { tryOnScopeDispose, watchImmediate } from '@vueuse/core'
import { eventsAtoms, type EventsKey } from '~/atoms/events'

/**
 * Tells a gated feed that this component is showing `target`, for as long as it
 * is, and stops telling it when the component goes away.
 *
 * The pairing is the whole job. A feed's activation map counts holders, so an
 * unmatched `+1` pins a transcript nobody is reading into polling forever and an
 * unmatched `-1` stops one that is on screen. Two rules make the pair safe, and
 * both are easy to get wrong by hand:
 *
 * - **The previous target is remembered, not recomputed.** `watchImmediate`
 *   hands over the old value, and that — never the current `target()` — is what
 *   gets the `-1`. Reading the ref at teardown time would decrement whatever the
 *   component happens to be showing *now*, which after a change is the entry
 *   that still needs its `+1`.
 * - **The first `+1` happens during `setup()`.** `watchImmediate` runs its
 *   callback synchronously rather than waiting for the mount, which matters
 *   because subscribing to the feed starts its stream and the stream's first
 *   tick reads the map. Announcing from `onMounted` would let that first tick
 *   find nothing on screen and skip, so the panel would sit empty for a whole
 *   interval before anything appeared.
 *
 * Call it during `setup()`, above the `useAtomValue` that reads the feed, and
 * once per target the component displays.
 */
export const useActivation = <T>(
  set: (activation: Activation<T>) => void,
  target: () => T,
): void => {
  let announced: T | null = null

  const release = (): void => {
    if (announced === null) return
    set({ target: announced, delta: -1 })
    announced = null
  }

  watchImmediate(target, (next) => {
    release()
    announced = next
    set({ target: next, delta: 1 })
  })

  tryOnScopeDispose(release)
}

/**
 * Announces one transcript as being on screen.
 *
 * `eventsKey(project, null, hours)` is a real key with a gated feed rather than
 * an absent one, so a component with nothing selected still announces — the
 * empty key is refused by the feed's own guard and never reaches the server.
 * That is what lets this be called unconditionally during `setup()`.
 */
export const useTranscriptActivation = (target: () => EventsKey): void => {
  const set = useAtomSet(() => eventsAtoms.active)
  useActivation(set, target)
}
