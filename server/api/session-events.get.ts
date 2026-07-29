import { defineEventHandler, getQuery, setHeader } from 'h3'
import type { SessionEventsResponse } from '#shared/types/run'
import { browserOptionsFor } from '../utils/request-context'
import { getSessionActivity } from '../utils/session-browser'

export default defineEventHandler(async (event): Promise<SessionEventsResponse> => {
  setHeader(event, 'Cache-Control', 'no-store')
  const query = getQuery(event)
  const key = typeof query.key === 'string' ? query.key : ''
  const project = typeof query.project === 'string' ? query.project : ''
  const parsedLimit = Number.parseInt(typeof query.limit === 'string' ? query.limit : '800', 10)
  const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 100), 2_000) : 800
  const options = browserOptionsFor(event)

  return runRequest(getSessionActivity(options.project, options.hours, project, key, limit))
})
