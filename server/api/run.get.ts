import { createError, defineEventHandler, getQuery, setHeader } from 'h3'
import type { RunResponse } from '#shared/types/run'

export default defineEventHandler(async (event): Promise<RunResponse> => {
  setHeader(event, 'Cache-Control', 'no-store')
  const query = getQuery(event)
  const key = typeof query.key === 'string' ? query.key : ''
  const { projectDirectory, hours } = await getRunContext(event)
  const { roots, byKey } = await buildTree(projectDirectory, hours)
  const node = byKey.get(key)
  if (!node) throw createError({ statusCode: 404, statusMessage: 'Unknown run key' })
  const root = rootOf(roots, key)
  if (!root) throw createError({ statusCode: 404, statusMessage: 'Unknown run key' })
  const diagnostics = await runDiagnostics(projectDirectory, root)

  return {
    key,
    lanes: flatten(root),
    files: Object.entries(root.subFiles).sort((a, b) => b[1] - a[1]),
    phases: runPhases(root),
    diagnostics,
    node: stripNode(node),
    root: stripNode(root),
  }
})
