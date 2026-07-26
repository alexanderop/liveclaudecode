import type { H3Event } from 'h3'
import { createError, getQuery } from 'h3'
import { resolveProjectDirectories, type ProjectDirectory } from './project'

function hoursFor(event: H3Event): number {
  const hours = Number(useRuntimeConfig(event).lcc.hours)
  return Number.isFinite(hours) && hours >= 0 ? hours : 24
}

export async function getProjectsContext(event: H3Event): Promise<{
  projects: ProjectDirectory[]
  hours: number
}> {
  const config = useRuntimeConfig(event)
  return {
    projects: await resolveProjectDirectories(config.lcc.project),
    hours: hoursFor(event),
  }
}

export async function getRunContext(event: H3Event): Promise<{
  projectDirectory: string
  hours: number
}> {
  const { projects, hours } = await getProjectsContext(event)
  const requested = getQuery(event).project
  const projectId = typeof requested === 'string' ? requested : ''
  const project = projectId
    ? projects.find(candidate => candidate.id === projectId)
    : projects.length === 1 ? projects[0] : undefined
  if (!project) {
    throw createError({
      statusCode: 400,
      statusMessage: projectId ? 'Unknown project' : 'Project is required',
    })
  }
  return {
    projectDirectory: project.directory,
    hours,
  }
}
