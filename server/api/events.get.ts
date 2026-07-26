import { createError, defineEventHandler, getQuery, setHeader } from 'h3'
import type { EventsResponse } from '#shared/types/run'

export default defineEventHandler(async (event): Promise<EventsResponse> => {
  setHeader(event, 'Cache-Control', 'no-store')
  const query = getQuery(event)
  const key = typeof query.key === 'string' ? query.key : ''
  const parsedSince = Number.parseInt(typeof query.since === 'string' ? query.since : '0', 10)
  const since = Number.isFinite(parsedSince) && parsedSince > 0 ? parsedSince : 0
  const { projectDirectory, hours } = await getRunContext(event)
  const { byKey } = await buildTree(projectDirectory, hours)
  const node = byKey.get(key)
  if (!node) throw createError({ statusCode: 404, statusMessage: 'Unknown run key' })

  const scan = await getScan(pathFor(projectDirectory, key))
  const childByToolId = new Map(
    node.children
      .filter(child => child.toolUseId)
      .map(child => [child.toolUseId!, child.key]),
  )
  const events = scan.events.slice(since).map((entry) => {
    const childKey = entry.spawn && entry.id ? childByToolId.get(entry.id) : undefined
    return childKey ? { ...entry, childKey } : entry
  })

  return {
    key,
    events,
    next: scan.events.length,
    node: stripNode(node),
  }
})
