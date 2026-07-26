import { defineEventHandler, setHeader } from 'h3'
import type { TreeResponse } from '#shared/types/run'
import { browserOptionsFor } from '../utils/request-context'
import { listSessions } from '../utils/session-browser'

export default defineEventHandler(async (event): Promise<TreeResponse> => {
  setHeader(event, 'Cache-Control', 'no-store')

  const options = browserOptionsFor(event)
  return runRequest(listSessions(options.project, options.hours))
})
