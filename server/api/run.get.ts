import { defineEventHandler, getQuery, setHeader } from 'h3'
import type { RunResponse } from '#shared/types/run'
import { browserOptionsFor } from '../utils/request-context'
import { getSessionRun } from '../utils/session-browser'

export default defineEventHandler(async (event): Promise<RunResponse> => {
  setHeader(event, 'Cache-Control', 'no-store')
  const query = getQuery(event)
  const key = typeof query.key === 'string' ? query.key : ''
  const project = typeof query.project === 'string' ? query.project : ''
  const options = browserOptionsFor(event)

  return runRequest(getSessionRun(options.project, options.hours, project, key))
})
