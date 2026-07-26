import { Effect } from 'effect'
import { defineEventHandler, getQuery, setHeader } from 'h3'
import type { RunResponse } from '#shared/types/run'
import { UnknownRun } from '../utils/services'

export default defineEventHandler(async (event): Promise<RunResponse> => {
  setHeader(event, 'Cache-Control', 'no-store')
  const query = getQuery(event)
  const key = typeof query.key === 'string' ? query.key : ''

  return runRequest(Effect.gen(function*() {
    const { projectDirectory, hours } = yield* getRunContext(event)
    const { roots, byKey } = yield* buildTree(projectDirectory, hours)
    const node = byKey.get(key)
    const root = rootOf(roots, key)
    if (!node || !root) return yield* new UnknownRun({ key })
    const diagnostics = yield* runDiagnostics(projectDirectory, root)

    return {
      key,
      lanes: flatten(root),
      files: Object.entries(root.subFiles).sort((a, b) => b[1] - a[1]),
      phases: runPhases(root),
      diagnostics,
      node: stripNode(node),
      root: stripNode(root),
    }
  }))
})
