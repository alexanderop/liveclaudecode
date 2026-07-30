import { defineEventHandler, getQuery, setHeader } from 'h3'
import type { SessionEventsResponse } from '#shared/types/run'
import { parseActivityQuery } from '#shared/schemas/request'
import { browserOptionsFor } from '../utils/request-context'
import { getSessionActivity } from '../utils/session-browser'

export default defineEventHandler(async (event): Promise<SessionEventsResponse> => {
  setHeader(event, 'Cache-Control', 'no-store')
  const { key, project, limit } = parseActivityQuery(getQuery(event))
  const options = browserOptionsFor(event)

  return runRequest(getSessionActivity(options.project, options.hours, project, key, limit))
})
