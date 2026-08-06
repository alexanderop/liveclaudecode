import { vi } from 'vitest'
import type {
  CostOverviewResponse,
  EventsResponse,
  RunNode,
  RunResponse,
  SessionEventsResponse,
  TreeResponse,
} from '#shared/types/run'
import {
  costOverviewResponse,
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
  /**
   * `useFetch` passes its query as options rather than in the URL, so callers
   * built that way are inspected here instead of with {@link urlParam}.
   */
  readonly query?: Record<string, unknown>
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
  readonly costs?: (
    url: string,
    options?: LiveApiRequestOptions,
  ) => CostOverviewResponse | Promise<CostOverviewResponse>
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
    if (url.startsWith('/api/costs')) {
      return (handlers.costs ?? (() => costOverviewResponse()))(url, options)
    }
    // No `/api/chat`: the chat talks to the server through the `Api` service and
    // `HttpClient`, so a `$fetch` to it would be a bug, not a request to answer.
    // Stub it with `mountWithAtoms` and `stubApi` instead.
    throw new Error(`Unexpected URL: ${url}`)
  })
  vi.stubGlobal('$fetch', fetch)
  return fetch
}
