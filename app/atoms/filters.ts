import type { SessionSource } from '#shared/types/run'
import * as Atom from 'effect/unstable/reactivity/Atom'
import type { SessionSort } from '~/utils/session-filter'

/** One transcript source, or every source at once. */
export type SessionSourceFilter = 'all' | SessionSource

/** A project as the sidebar's project picker lists it. */
export interface ProjectOption {
  readonly id: string
  readonly name: string
}

/**
 * The eight sidebar filters.
 *
 * They were eight `shallowRef`s inside `useSessionFilters`, handed up through
 * `useLiveRuns` and back down as eight `v-model`s. Nothing about them is
 * per-instance: there is one session browser and one set of filters, and the
 * only reason they travelled through two composables and a prop list was that
 * there was nowhere else to put them.
 *
 * `keepAlive` for the reason the preferences need it — a filter the user typed
 * is state, and the registry's 400 ms idle sweep would otherwise reset it the
 * moment nothing is reading it.
 *
 * **`visibleProjects` and `projectOptions` are deliberately not here yet.** Both
 * derive from the run tree, which is still `useLiveRuns`'s `shallowRef`; they
 * land in this file in Stage 5, on top of `app/atoms/tree.ts`. Bridging the tree
 * through a writable atom in the meantime would duplicate it — the same list in
 * a ref and in an atom, written from a poll callback — which is a worse thing to
 * own for one stage than a computed that has to move once.
 */
export const makeFiltersAtoms = () => ({
  /** Free-text search across projects, session labels, and agents. */
  query: Atom.make('').pipe(Atom.keepAlive),
  /** Restrict sessions to one transcript source. */
  source: Atom.make<SessionSourceFilter>('all').pipe(Atom.keepAlive),
  /** Restrict sessions to one project id, or `'all'`. */
  project: Atom.make('all').pipe(Atom.keepAlive),
  /** Show only sessions with live activity. */
  liveOnly: Atom.make(false).pipe(Atom.keepAlive),
  /** Show only finished sessions that ended with errors. */
  attentionOnly: Atom.make(false).pipe(Atom.keepAlive),
  /** Hide empty sessions that never recorded any activity. */
  hideIdle: Atom.make(true).pipe(Atom.keepAlive),
  /** Minimum number of subagents a session must have spawned. */
  minimumSubagents: Atom.make(0).pipe(Atom.keepAlive),
  /** Session ordering within a project. */
  sort: Atom.make<SessionSort>('updated').pipe(Atom.keepAlive),
})

/** The live instance every component reads. Tests call the factory instead. */
export const filtersAtoms = makeFiltersAtoms()
