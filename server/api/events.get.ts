import { defineEventHandler, getQuery, setHeader } from 'h3'
import type { EventsResponse } from '#shared/types/run'
import { browserOptionsFor } from '../utils/request-context'
import { getSessionEvents } from '../utils/session-browser'

export default defineEventHandler(async (event): Promise<EventsResponse> => {
  setHeader(event, 'Cache-Control', 'no-store')
  const query = getQuery(event)
  const key = typeof query.key === 'string' ? query.key : ''
  const parsedSince = Number.parseInt(typeof query.since === 'string' ? query.since : '0', 10)
  const since = Number.isFinite(parsedSince) && parsedSince > 0 ? parsedSince : 0
  const parsedRevision = Number.parseInt(typeof query.revision === 'string' ? query.revision : '0', 10)
  const revision = Number.isFinite(parsedRevision) && parsedRevision > 0 ? parsedRevision : 0
  const project = typeof query.project === 'string' ? query.project : ''
  const options = browserOptionsFor(event)

  return runRequest(getSessionEvents(options.project, options.hours, project, key, since, revision))
})
