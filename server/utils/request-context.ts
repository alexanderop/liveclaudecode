import type { H3Event } from 'h3'
import { getQuery } from 'h3'
import { Effect } from 'effect'
import { resolveProjectDirectories, type ProjectDirectory } from './project'
import { resolveHours } from './request-hours'
import { UnknownProject } from './services'

function hoursFor(event: H3Event): number {
  return resolveHours(useRuntimeConfig(event).lcc.hours, getQuery(event).hours)
}

export function browserOptionsFor(event: H3Event): { project: string, hours: number } {
  return {
    project: String(useRuntimeConfig(event).lcc.project || ''),
    hours: hoursFor(event),
  }
}

export const getProjectsContext = Effect.fn('getProjectsContext')(function*(event: H3Event) {
  const config = useRuntimeConfig(event)
  return {
    projects: yield* resolveProjectDirectories(config.lcc.project),
    hours: hoursFor(event),
  } satisfies { projects: ProjectDirectory[], hours: number }
})

export const getRunContext = Effect.fn('getRunContext')(function*(event: H3Event) {
  const { projects, hours } = yield* getProjectsContext(event)
  const requested = getQuery(event).project
  const projectId = typeof requested === 'string' ? requested : ''
  const project = projectId
    ? projects.find(candidate => candidate.id === projectId)
    : projects.length === 1 ? projects[0] : undefined

  if (!project) {
    return yield* new UnknownProject({
      input: projectId,
      directory: projects.map(candidate => candidate.id).join(', '),
    })
  }
  return { projectDirectory: project.directory, hours }
})
