import type { ComputedRef, ShallowRef } from 'vue'
import type { ProjectRuns, SessionSource } from '#shared/types/run'
import type { SessionSort } from '~/utils/session-filter'

export type SessionSourceFilter = 'all' | SessionSource

export interface ProjectOption {
  readonly id: string
  readonly name: string
}

export interface UseSessionFiltersReturn {
  /** Free-text search across projects, session labels, and agents. */
  readonly query: ShallowRef<string>
  /** Restrict sessions to one transcript source. */
  readonly sourceFilter: ShallowRef<SessionSourceFilter>
  /** Restrict sessions to one project id, or `'all'`. */
  readonly projectFilter: ShallowRef<string>
  /** Show only sessions with live activity. */
  readonly liveOnly: ShallowRef<boolean>
  /** Show only finished sessions that ended with errors. */
  readonly attentionOnly: ShallowRef<boolean>
  /**
   * Hide empty sessions that never recorded any activity.
   *
   * Defaults to `true`.
   */
  readonly hideIdle: ShallowRef<boolean>
  /** Minimum number of subagents a session must have spawned. */
  readonly minimumSubagents: ShallowRef<number>
  /** Session ordering within a project. */
  readonly sessionSort: ShallowRef<SessionSort>
  /** Projects with the active filters applied. */
  readonly visibleProjects: ComputedRef<ProjectRuns[]>
  /** All known projects as name-sorted select options, unfiltered. */
  readonly projectOptions: ComputedRef<ProjectOption[]>
}

/**
 * Filter and sort state for the session sidebar, derived from the unfiltered
 * project tree.
 */
export function useSessionFilters(
  projects: Readonly<ShallowRef<ProjectRuns[]>>,
): UseSessionFiltersReturn {
  const query = shallowRef('')
  const sourceFilter = shallowRef<SessionSourceFilter>('all')
  const projectFilter = shallowRef('all')
  const liveOnly = shallowRef(false)
  const attentionOnly = shallowRef(false)
  const hideIdle = shallowRef(true)
  const minimumSubagents = shallowRef(0)
  const sessionSort = shallowRef<SessionSort>('updated')

  const visibleProjects = computed(() => filterSessionProjects(projects.value, {
    query: query.value,
    source: sourceFilter.value,
    project: projectFilter.value,
    liveOnly: liveOnly.value,
    attentionOnly: attentionOnly.value,
    hideIdle: hideIdle.value,
    minimumSubagents: minimumSubagents.value,
    sort: sessionSort.value,
  }))

  const projectOptions = computed(() => projects.value
    .map(project => ({ id: project.id, name: project.name }))
    .sort((a, b) => a.name.localeCompare(b.name)))

  return {
    query,
    sourceFilter,
    projectFilter,
    liveOnly,
    attentionOnly,
    hideIdle,
    minimumSubagents,
    sessionSort,
    visibleProjects,
    projectOptions,
  }
}
