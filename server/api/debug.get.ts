import { defineEventHandler, setHeader } from 'h3'
import type { ParseHealthResponse } from '#shared/types/run'
import { browserOptionsFor } from '../utils/request-context'
import { listParseHealth } from '../utils/session-catalog'

export default defineEventHandler(async (event): Promise<ParseHealthResponse> => {
  setHeader(event, 'Cache-Control', 'no-store')
  const options = browserOptionsFor(event)
  return runRequest(event, listParseHealth(options.project, options.hours))
})
