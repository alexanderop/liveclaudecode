import { Effect } from 'effect'
import { defineEventHandler, getQuery, setHeader } from 'h3'
import type { SessionEventsResponse } from '#shared/types/run'
import { parseActivityQuery } from '#shared/schemas/request'
import { browserOptionsFor } from '../utils/request-context'
import { getSessionActivity } from '../utils/session-catalog'

export default defineEventHandler(async (event): Promise<SessionEventsResponse> => {
  setHeader(event, 'Cache-Control', 'no-store')
  const options = browserOptionsFor(event)

  return runRequest(event, Effect.flatMap(
    parseActivityQuery(getQuery(event)),
    ({ key, project, limit }) => getSessionActivity(options.project, options.hours, project, key, limit),
  ))
})
