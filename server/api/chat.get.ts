import { defineEventHandler, getQuery, setHeader } from 'h3'
import type { ChatEventsResponse } from '#shared/types/chat'
import { pollChatEvents } from '../utils/chat'

export default defineEventHandler(async (event): Promise<ChatEventsResponse> => {
  setHeader(event, 'Cache-Control', 'no-store')
  const query = getQuery(event)
  const key = typeof query.key === 'string' ? query.key : ''
  const project = typeof query.project === 'string' ? query.project : ''
  const parsedSince = Number.parseInt(typeof query.since === 'string' ? query.since : '0', 10)
  const since = Number.isFinite(parsedSince) && parsedSince > 0 ? parsedSince : 0
  const parsedRevision = Number.parseInt(typeof query.revision === 'string' ? query.revision : '0', 10)
  const revision = Number.isFinite(parsedRevision) && parsedRevision > 0 ? parsedRevision : 0

  return runRequest(pollChatEvents(project, key, since, revision))
})
