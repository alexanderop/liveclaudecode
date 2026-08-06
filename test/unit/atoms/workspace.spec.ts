import * as AtomRegistry from 'effect/unstable/reactivity/AtomRegistry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeWorkspaceAtoms } from '~/atoms/workspace'
import { openAsk, openPrimary, toggleFocus } from '~/utils/workspace-state'

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
  workspace: makeWorkspaceAtoms(),
})

/**
 * The workspace atom holds one value that `app/utils/workspace-state.ts` already
 * tests thirteen transitions of. What is left to check here is what the atom
 * adds: that the value is one dashboard's, and that it survives the two things
 * that would quietly reset it.
 */
describe('workspace atoms', () => {
  it('opens on the same view the page always opened on', () => {
    const { registry, workspace } = setup()

    expect(registry.get(workspace.workspace)).toEqual({
      primary: 'overview',
      context: { kind: 'closed' },
      launcher: { kind: 'closed' },
      investigation: {},
      focused: false,
    })
  })

  it('gives every reader the same workspace', () => {
    const { registry, workspace } = setup()
    // Materialised before subscribing, deliberately. A node that has never been
    // read is evaluated by its first *write*, and the subscriber is then handed
    // the initial value and the written one — two notifications for one change,
    // which for a poll pulse means two requests.
    const opening = registry.get(workspace.workspace)
    const seen: string[] = []
    const unsubscribe = registry.subscribe(
      workspace.workspace,
      value => void seen.push(value.primary),
    )

    registry.set(workspace.workspace, openPrimary(opening, 'activity'))
    unsubscribe()

    expect(seen).toEqual(['activity'])
    expect(registry.get(workspace.workspace).primary).toBe('activity')
  })

  it('does not hand back a fresh state object to a caller that mutates it', () => {
    const { registry, workspace } = setup()

    const before = registry.get(workspace.workspace)
    registry.set(workspace.workspace, toggleFocus(before))

    // The transitions are pure and return new objects; the atom stores what it
    // is given. If either ever mutated in place, this equality would hold and
    // no subscriber would be notified of anything.
    expect(registry.get(workspace.workspace)).not.toBe(before)
    expect(before.focused).toBe(false)
    expect(registry.get(workspace.workspace).focused).toBe(true)
  })

  it('keeps the open view when nothing is reading it', async () => {
    vi.useFakeTimers()
    const { registry, workspace } = setup()

    const unmount = registry.mount(workspace.workspace)
    registry.set(
      workspace.workspace,
      openAsk(openPrimary(registry.get(workspace.workspace), 'changes'), 'session'),
    )
    unmount()
    await vi.advanceTimersByTimeAsync(IDLE_TTL_MS * 4)

    // Leaving for the costs page and coming back must not drop the user into
    // Overview with the Ask panel shut. Without `keepAlive` the idle sweep
    // collects the node during the route transition and the next read rebuilds
    // it from `initialWorkspaceState()`.
    const state = registry.get(workspace.workspace)
    expect(state.primary).toBe('changes')
    expect(state.context).toEqual({ kind: 'ask', sessionId: 'session' })
  })

  it('starts each registry at its own initial state', () => {
    const first = setup()
    const second = setup()

    first.registry.set(
      first.workspace.workspace,
      openPrimary(first.registry.get(first.workspace.workspace), 'diagnostics'),
    )

    // `initialWorkspaceState()` is called per read rather than shared, so one
    // registry's workspace cannot leak into another's — the property every
    // mounted spec depends on to not be order-dependent.
    expect(second.registry.get(second.workspace.workspace).primary).toBe('overview')
  })
})
