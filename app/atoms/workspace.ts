import * as Atom from 'effect/unstable/reactivity/Atom'
import { initialWorkspaceState, type WorkspaceState } from '~/utils/workspace-state'

/**
 * Which workspace the dashboard is showing, and what is docked beside it.
 *
 * Held here rather than in `index.vue` for the same reason the filters are:
 * it is one dashboard's state, the thirteen transitions that write it are
 * already pure functions in `app/utils/workspace-state.ts`, and a page that owns
 * no state at all is a page whose behaviour can be read off its template.
 *
 * `keepAlive` — leaving for the costs page and coming back should not reset
 * which view the user was in. The `?view=` seeding in `index.vue` still wins on
 * a fresh load, because that is a URL the user actually asked for.
 */
export const makeWorkspaceAtoms = () => ({
  workspace: Atom.make<WorkspaceState>(initialWorkspaceState()).pipe(Atom.keepAlive),
})

/** The workspace atoms, as one bundle. */
export type WorkspaceAtoms = ReturnType<typeof makeWorkspaceAtoms>

/** The live instance every component reads. Tests call the factory instead. */
export const workspaceAtoms: WorkspaceAtoms = makeWorkspaceAtoms()
