import { vi } from 'vitest'
import type { ChatActionResponse, ChatEventsResponse } from '#shared/types/chat'
import type {
  EventsResponse,
  RunNode,
  RunResponse,
  SessionEventsResponse,
  TreeResponse,
} from '#shared/types/run'
import { chatActionResponse, chatEventsResponse } from './chat'
import {
  eventsResponse,
  runResponse,
  sessionEventsResponse,
  treeResponse,
} from './runs'

/** Request options `$fetch` was called with, passed through to handlers. */
export interface LiveApiRequestOptions {
  readonly method?: string
  readonly body?: unknown
  readonly signal?: AbortSignal
}

export interface LiveApiHandlers {
  readonly tree?: (
    url: string,
    options?: LiveApiRequestOptions,
  ) => TreeResponse | Promise<TreeResponse>
  readonly run?: (
    url: string,
    options?: LiveApiRequestOptions,
  ) => RunResponse | Promise<RunResponse>
  readonly sessionEvents?: (
    url: string,
    options?: LiveApiRequestOptions,
  ) => SessionEventsResponse | Promise<SessionEventsResponse>
  readonly events?: (
    url: string,
    options?: LiveApiRequestOptions,
  ) => EventsResponse | Promise<EventsResponse>
  /** GET /api/chat — the poll for chat events. */
  readonly chat?: (
    url: string,
    options?: LiveApiRequestOptions,
  ) => ChatEventsResponse | Promise<ChatEventsResponse>
  /** POST /api/chat — send/cancel/reset actions. */
  readonly chatAction?: (
    url: string,
    options?: LiveApiRequestOptions,
  ) => ChatActionResponse | Promise<ChatActionResponse>
}

/** Reads a query parameter from a request URL captured by the mock. */
export function urlParam(url: string, name: string): string | null {
  return new URLSearchParams(url.split('?')[1] ?? '').get(name)
}

/**
 * Stubs `$fetch` with a router over the dashboard API. Every endpoint has a
 * benign default derived from `root` (tree with one `/repo` project, empty
 * event feeds, a run detail echoing the requested key, an idle chat); pass
 * handlers to script the endpoints a test cares about. Unknown URLs reject so
 * typos in request building fail loudly.
 */
export function mockLiveApi(root: RunNode, handlers: LiveApiHandlers = {}) {
  const fetch = vi.fn(async (url: string, options?: LiveApiRequestOptions) => {
    if (url.startsWith('/api/tree')) {
      return (handlers.tree ?? (() => treeResponse(root)))(url, options)
    }
    if (url.startsWith('/api/run')) {
      if (handlers.run) return handlers.run(url, options)
      const key = urlParam(url, 'key') ?? root.key
      return runResponse({ key, node: root, root })
    }
    if (url.startsWith('/api/session-events')) {
      if (handlers.sessionEvents) return handlers.sessionEvents(url, options)
      return sessionEventsResponse(root.key)
    }
    if (url.startsWith('/api/events')) {
      if (handlers.events) return handlers.events(url, options)
      return eventsResponse(urlParam(url, 'key') ?? root.key, [])
    }
    if (url.startsWith('/api/chat')) {
      if (options?.method === 'POST') {
        return (handlers.chatAction ?? (() => chatActionResponse()))(url, options)
      }
      return (handlers.chat ?? (() => chatEventsResponse()))(url, options)
    }
    throw new Error(`Unexpected URL: ${url}`)
  })
  vi.stubGlobal('$fetch', fetch)
  return fetch
}
