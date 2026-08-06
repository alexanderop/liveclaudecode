import type { SessionSource } from '#shared/types/run'
import type { ProjectRunsWire, RunNodeWire } from '#shared/schemas/api'

export type SessionSort = 'updated' | 'subagents'

export interface SessionFilterOptions {
  query: string
  source: 'all' | SessionSource
  project: 'all' | string
  liveOnly: boolean
  attentionOnly: boolean
  hideIdle: boolean
  minimumSubagents: number
  sort: SessionSort
}

/**
 * Orders session roots by the active sort: most subagents first (falling back
 * to recency for ties), or most recently updated first.
 */
export function compareRoots(left: RunNodeWire, right: RunNodeWire, sort: SessionSort): number {
  const leftSubagents = left.subAgents ?? 0
  const rightSubagents = right.subAgents ?? 0
  if (sort === 'subagents' && leftSubagents !== rightSubagents) {
    return rightSubagents - leftSubagents
  }
  return (right.subLast || '').localeCompare(left.subLast || '')
}

export function filterSessionProjects(
  projects: ReadonlyArray<ProjectRunsWire>,
  options: SessionFilterOptions,
): ProjectRunsWire[] {
  const needle = options.query.trim().toLowerCase()

  const filterNode = (node: RunNodeWire, projectMatches: boolean): RunNodeWire | null => {
    const children = node.children
      .map(child => filterNode(child, projectMatches))
      .filter((child): child is RunNodeWire => Boolean(child))
    const self = (!options.liveOnly || node.subLive)
      && (!options.attentionOnly || (node.subErrors > 0 && !node.subLive))
      && (!options.hideIdle || node.records > 0 || children.length > 0)
      && (options.source === 'all' || node.source === options.source)
      && (!needle
        || projectMatches
        || node.label.toLowerCase().includes(needle)
        || node.agentType.toLowerCase().includes(needle)
        || node.sourceDetail.toLowerCase().includes(needle)
        || node.source.includes(needle))
    return self || children.length ? { ...node, children } : null
  }

  return projects
    .filter(project => options.project === 'all' || project.id === options.project)
    .map((project) => {
      const projectMatches = project.name.toLowerCase().includes(needle)
      return {
        ...project,
        roots: project.roots
          .map(root => filterNode(root, projectMatches))
          .filter((root): root is RunNodeWire => Boolean(root))
          .filter(root => (root.subAgents ?? 0) >= options.minimumSubagents)
          .sort((left, right) => compareRoots(left, right, options.sort)),
      }
    })
    .filter(project => !needle || project.name.toLowerCase().includes(needle) || project.roots.length > 0)
    .sort((left, right) => {
      if (options.sort !== 'subagents') return 0
      const leftMost = left.roots[0]?.subAgents ?? -1
      const rightMost = right.roots[0]?.subAgents ?? -1
      return rightMost - leftMost
    })
}
