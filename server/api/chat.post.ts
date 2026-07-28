import { defineEventHandler, readBody, setHeader } from 'h3'
import type { ChatActionResponse } from '#shared/types/chat'
import { handleChatAction } from '../utils/chat'
import { browserOptionsFor } from '../utils/request-context'

export default defineEventHandler(async (event): Promise<ChatActionResponse> => {
  setHeader(event, 'Cache-Control', 'no-store')
  const options = browserOptionsFor(event)
  const body: unknown = await readBody(event)

  return runRequest(handleChatAction(options.project, options.hours, body))
})
