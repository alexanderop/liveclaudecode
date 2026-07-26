import { Clock, Effect } from 'effect'
import { defineEventHandler, setHeader } from 'h3'
import type { TreeResponse } from '#shared/types/run'

export default defineEventHandler(async (event): Promise<TreeResponse> => {
  setHeader(event, 'Cache-Control', 'no-store')

  return runRequest(Effect.gen(function*() {
    const { projects, hours } = yield* getProjectsContext(event)
    const trees = yield* Effect.forEach(projects, project =>
      Effect.map(buildTree(project.directory, hours), ({ roots, cwd }) => ({
        id: project.id,
        name: cwd ? projectName(cwd) : projectName(project.directory),
        roots,
      })))

    const populated = trees.filter(project => project.roots.length > 0)
    populated.sort((a, b) => {
      const aLast = a.roots[0]?.subLast || ''
      const bLast = b.roots[0]?.subLast || ''
      return bLast.localeCompare(aLast) || a.name.localeCompare(b.name)
    })

    return {
      projects: populated,
      now: (yield* Clock.currentTimeMillis) / 1_000,
    }
  }))
})
