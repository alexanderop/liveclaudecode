import type { SessionSource } from '#shared/types/run'
import * as Atom from 'effect/unstable/reactivity/Atom'
import { filterSessionProjects, type SessionSort } from '~/utils/session-filter'
import { treeAtoms, type TreeAtoms } from './tree'

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
 * The two projections at the bottom are why this file reads `tree`: filtering
 * is the one thing the session browser does to the tree, and putting the result
 * anywhere else would mean two files knowing the filter set.
 */
export const makeFiltersAtoms = (tree: TreeAtoms = treeAtoms) => {
  /** Free-text search across projects, session labels, and agents. */
  const query = Atom.make('').pipe(Atom.keepAlive)
  /** Restrict sessions to one transcript source. */
  const source = Atom.make<SessionSourceFilter>('all').pipe(Atom.keepAlive)
  /** Restrict sessions to one project id, or `'all'`. */
  const project = Atom.make('all').pipe(Atom.keepAlive)
  /** Show only sessions with live activity. */
  const liveOnly = Atom.make(false).pipe(Atom.keepAlive)
  /** Show only finished sessions that ended with errors. */
  const attentionOnly = Atom.make(false).pipe(Atom.keepAlive)
  /** Hide empty sessions that never recorded any activity. */
  const hideIdle = Atom.make(true).pipe(Atom.keepAlive)
  /** Minimum number of subagents a session must have spawned. */
  const minimumSubagents = Atom.make(0).pipe(Atom.keepAlive)
  /** Session ordering within a project. */
  const sort = Atom.make<SessionSort>('updated').pipe(Atom.keepAlive)

  return {
    query,
    source,
    project,
    liveOnly,
    attentionOnly,
    hideIdle,
    minimumSubagents,
    sort,
    /** The tree with the active filters applied, as the sidebar lists it. */
    visibleProjects: Atom.make(get => filterSessionProjects(get(tree.projects), {
      query: get(query),
      source: get(source),
      project: get(project),
      liveOnly: get(liveOnly),
      attentionOnly: get(attentionOnly),
      hideIdle: get(hideIdle),
      minimumSubagents: get(minimumSubagents),
      sort: get(sort),
    })),
    /**
     * Every known project as a name-sorted option, *unfiltered* — the project
     * picker must keep offering the project you filtered yourself out of.
     */
    projectOptions: Atom.make((get): ProjectOption[] => get(tree.projects)
      .map(entry => ({ id: entry.id, name: entry.name }))
      .sort((left, right) => left.name.localeCompare(right.name))),
  }
}

/** The filter atoms and their two projections, as one bundle. */
export type FiltersAtoms = ReturnType<typeof makeFiltersAtoms>

/** The live instance every component reads. Tests call the factory instead. */
export const filtersAtoms: FiltersAtoms = makeFiltersAtoms()
