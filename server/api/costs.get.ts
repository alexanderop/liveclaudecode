import { defineEventHandler, setHeader } from 'h3'
import type { CostOverviewResponse } from '#shared/types/run'
import { browserOptionsFor } from '../utils/request-context'
import { listCostOverview } from '../utils/session-catalog'

export default defineEventHandler(async (event): Promise<CostOverviewResponse> => {
  setHeader(event, 'Cache-Control', 'no-store')
  const options = browserOptionsFor(event)
  return runRequest(event, listCostOverview(options.project, options.hours))
})
