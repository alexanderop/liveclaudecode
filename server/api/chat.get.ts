import { Effect } from 'effect'
import { defineEventHandler, getQuery, setHeader } from 'h3'
import type { ChatEventsResponse } from '#shared/types/chat'
import { parseCursorQuery } from '#shared/schemas/request'
import { pollChatEvents } from '../utils/chat'

export default defineEventHandler(async (event): Promise<ChatEventsResponse> => {
  setHeader(event, 'Cache-Control', 'no-store')

  return runRequest(event, Effect.flatMap(
    parseCursorQuery(getQuery(event)),
    ({ key, project, since, revision }) => pollChatEvents(project, key, since, revision),
  ))
})
