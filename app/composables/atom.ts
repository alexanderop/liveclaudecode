import type * as Atom from 'effect/unstable/reactivity/Atom'
import type { WritableComputedRef } from 'vue'
import { injectRegistry, useAtom } from '@effect/atom-vue'
import { computed, watchEffect } from 'vue'

/**
 * Keeps `atom` mounted for the lifetime of the calling component and returns a
 * function that rebuilds it.
 *
 * The Vue binding ships four composables where the React binding ships eleven;
 * this mirrors react `Hooks.ts`'s `useAtomRefresh`. Like every binding
 * composable it must be called during `setup()` — `injectRegistry` falls back
 * to a module-level singleton rather than throwing.
 *
 * **Not for a polling feed.** Refreshing rebuilds the node, so a stream atom's
 * stream is constructed again from scratch: `pollingFeed`'s `initial()` runs
 * again and the value it was holding is gone, which means a refresh against a
 * server that is down empties the screen instead of going stale over the data
 * already on it. Give the feed a `pulses` stream instead — see
 * `app/atoms/costs.ts`.
 */
export const useAtomRefresh = <A>(atom: () => Atom.Atom<A>): (() => void) => {
  const registry = injectRegistry()
  const atomRef = computed(atom)
  watchEffect((onCleanup) => {
    onCleanup(registry.mount(atomRef.value))
  })
  return () => registry.refresh(atomRef.value)
}

/**
 * Keeps `atom` warm without reading its value, so an unobserved node is not torn
 * down between the components that do read it. Mirrors react `Hooks.ts`'s
 * `useAtomMount`.
 */
export const useAtomMount = <A>(atom: () => Atom.Atom<A>): void => {
  const registry = injectRegistry()
  const atomRef = computed(atom)
  watchEffect((onCleanup) => {
    onCleanup(registry.mount(atomRef.value))
  })
}

/**
 * `v-model` adapter for a writable atom.
 *
 * `useAtom` returns a readonly `Ref` plus a separate setter and the binding
 * ships no writable-ref helper, so every two-way binding in the dashboard needs
 * this shim.
 */
export const useAtomModel = <A>(atom: () => Atom.Writable<A, A>): WritableComputedRef<A> => {
  const [value, set] = useAtom(atom)
  return computed({ get: () => value.value, set })
}
