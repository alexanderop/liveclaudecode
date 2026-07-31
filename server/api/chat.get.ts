import { defineEventHandler, getQuery, setHeader } from 'h3'
import type { ChatEventsResponse } from '#shared/types/chat'
import { parseCursorQuery } from '#shared/schemas/request'
import { pollChatEvents } from '../utils/chat'

export default defineEventHandler(async (event): Promise<ChatEventsResponse> => {
  setHeader(event, 'Cache-Control', 'no-store')
  const { key, project, since, revision } = parseCursorQuery(getQuery(event))

  return runRequest(event, pollChatEvents(project, key, since, revision))
})
