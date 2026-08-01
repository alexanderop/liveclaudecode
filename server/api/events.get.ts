import { Effect } from 'effect'
import { defineEventHandler, getQuery, setHeader } from 'h3'
import type { EventsResponse } from '#shared/types/run'
import { parseCursorQuery } from '#shared/schemas/request'
import { browserOptionsFor } from '../utils/request-context'
import { getSessionEvents } from '../utils/session-catalog'

export default defineEventHandler(async (event): Promise<EventsResponse> => {
  setHeader(event, 'Cache-Control', 'no-store')
  const options = browserOptionsFor(event)

  return runRequest(event, Effect.flatMap(
    parseCursorQuery(getQuery(event)),
    ({ key, project, since, revision }) =>
      getSessionEvents(options.project, options.hours, project, key, since, revision),
  ))
})
