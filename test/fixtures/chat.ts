import type { ChatActionResponse, ChatEventsResponse } from '#shared/types/chat'

export function chatEventsResponse(
  overrides: Partial<ChatEventsResponse> = {},
): ChatEventsResponse {
  return {
    events: [],
    next: 0,
    revision: 0,
    reset: false,
    status: 'idle',
    agent: null,
    ...overrides,
  }
}

export function chatActionResponse(
  overrides: Partial<ChatActionResponse> = {},
): ChatActionResponse {
  return {
    status: 'starting',
    ...overrides,
  }
}
