import * as AtomRegistry from 'effect/unstable/reactivity/AtomRegistry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeFiltersAtoms } from '~/atoms/filters'

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
  filters: makeFiltersAtoms(),
})

describe('sidebar filters', () => {
  it('opens on every session the range contains, minus the empty ones', () => {
    const { registry, filters } = setup()

    expect(registry.get(filters.query)).toBe('')
    expect(registry.get(filters.source)).toBe('all')
    expect(registry.get(filters.project)).toBe('all')
    expect(registry.get(filters.liveOnly)).toBe(false)
    expect(registry.get(filters.attentionOnly)).toBe(false)
    expect(registry.get(filters.minimumSubagents)).toBe(0)
    expect(registry.get(filters.sort)).toBe('updated')
    // The one default that is not "show everything": a session that recorded no
    // activity at all is noise in the browser.
    expect(registry.get(filters.hideIdle)).toBe(true)
  })

  it('keeps what the user typed when the sidebar stops being read', async () => {
    vi.useFakeTimers()
    const { registry, filters } = setup()

    const unmount = registry.mount(filters.query)
    registry.set(filters.query, 'dashboard')
    unmount()
    await vi.advanceTimersByTimeAsync(IDLE_TTL_MS * 4)

    // A search someone typed is state, not a cache. Without `keepAlive` the idle
    // sweep would drop it and the sidebar would quietly widen back out.
    expect(registry.get(filters.query)).toBe('dashboard')
  })
})
