import { Effect } from 'effect'
import { defineEventHandler, getQuery, setHeader } from 'h3'
import type { RunResponse } from '#shared/types/run'
import { parseSessionQuery } from '#shared/schemas/request'
import { browserOptionsFor } from '../utils/request-context'
import { getSessionRun } from '../utils/session-catalog'

export default defineEventHandler(async (event): Promise<RunResponse> => {
  setHeader(event, 'Cache-Control', 'no-store')
  const options = browserOptionsFor(event)

  return runRequest(event, Effect.flatMap(
    parseSessionQuery(getQuery(event)),
    ({ key, project }) => getSessionRun(options.project, options.hours, project, key),
  ))
})
