import { defineEventHandler, setHeader } from 'h3'
import type { TreeResponse } from '#shared/types/run'

export default defineEventHandler(async (event): Promise<TreeResponse> => {
  setHeader(event, 'Cache-Control', 'no-store')
  const { projects, hours } = await getProjectsContext(event)
  const trees = (await Promise.all(projects.map(async (project) => {
    const { roots, cwd } = await buildTree(project.directory, hours)
    return {
      id: project.id,
      name: cwd ? projectName(cwd) : projectName(project.directory),
      roots,
    }
  }))).filter(project => project.roots.length > 0)
  trees.sort((a, b) => {
    const aLast = a.roots[0]?.subLast || ''
    const bLast = b.roots[0]?.subLast || ''
    return bLast.localeCompare(aLast) || a.name.localeCompare(b.name)
  })
  return {
    projects: trees,
    now: Date.now() / 1_000,
  }
})
