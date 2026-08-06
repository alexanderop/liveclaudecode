import * as AtomRegistry from 'effect/unstable/reactivity/AtomRegistry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makePreferencesAtoms } from '~/atoms/preferences'

/**
 * The grace period `app/plugins/atom-registry.ts` gives an unobserved atom,
 * restated so a change to it fails here.
 */
const IDLE_TTL_MS = 400

afterEach(() => {
  vi.useRealTimers()
})

/** A registry configured exactly like the app's, and a fresh set of atoms. */
const setup = () => ({
  registry: AtomRegistry.make({ defaultIdleTTL: IDLE_TTL_MS }),
  preferences: makePreferencesAtoms(),
})

describe('display preferences', () => {
  it('starts at the settings the dashboard has always opened with', () => {
    const { registry, preferences } = setup()

    expect(registry.get(preferences.density)).toBe('normal')
    expect(registry.get(preferences.errorsOnly)).toBe(false)
    expect(registry.get(preferences.followOutput)).toBe(true)
    expect(registry.get(preferences.followActive)).toBe(false)
  })

  it('shows one panel what another panel set', () => {
    const { registry, preferences } = setup()
    // The activity workspace's density segments and the inspector's copy of the
    // same control are two readers of one setting; that is the whole reason it
    // is an atom rather than three props and two emits.
    const seen: string[] = []
    const unsubscribe = registry.subscribe(preferences.density, value => void seen.push(value))

    registry.set(preferences.density, 'raw')
    unsubscribe()

    expect(seen).toEqual(['raw'])
    expect(registry.get(preferences.density)).toBe('raw')
  })

  it('keeps a preference after the last panel reading it goes away', async () => {
    vi.useFakeTimers()
    const { registry, preferences } = setup()

    const unmount = registry.mount(preferences.errorsOnly)
    registry.set(preferences.errorsOnly, true)
    unmount()
    await vi.advanceTimersByTimeAsync(IDLE_TTL_MS * 4)

    // Switching from Activity to Overview leaves nobody reading this. Without
    // `keepAlive` the idle sweep would collect the node and the next panel to
    // open would silently show the default again.
    expect(registry.get(preferences.errorsOnly)).toBe(true)
  })
})
