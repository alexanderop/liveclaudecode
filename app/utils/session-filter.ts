import type { ProjectRuns, RunNode, SessionSource } from '#shared/types/run'

export interface SessionFilterOptions {
  query: string
  source: 'all' | SessionSource
  project: 'all' | string
  liveOnly: boolean
  attentionOnly: boolean
  hideIdle: boolean
}

export function filterSessionProjects(
  projects: ProjectRuns[],
  options: SessionFilterOptions,
): ProjectRuns[] {
  const needle = options.query.trim().toLowerCase()

  const filterNode = (node: RunNode, projectMatches: boolean): RunNode | null => {
    const children = node.children
      .map(child => filterNode(child, projectMatches))
      .filter((child): child is RunNode => Boolean(child))
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
          .filter((root): root is RunNode => Boolean(root)),
      }
    })
    .filter(project => !needle || project.name.toLowerCase().includes(needle) || project.roots.length > 0)
}
