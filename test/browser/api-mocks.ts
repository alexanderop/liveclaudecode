import type { Page } from '@playwright/test'
import type {
  EventsResponse,
  RunResponse,
  SessionEventsResponse,
  TreeResponse,
} from '../../shared/types/run'

interface DashboardApiRequest {
  readonly call: number
  readonly url: URL
}

interface JsonReply<T> {
  readonly json: T | { readonly message: string }
  readonly status?: number
}

type Responder<T> = (
  request: DashboardApiRequest,
) => JsonReply<T> | Promise<JsonReply<T>>

export interface DashboardApiScenario {
  readonly tree: Responder<TreeResponse>
  readonly run?: Responder<RunResponse>
  readonly events?: Responder<EventsResponse>
  readonly sessionEvents?: Responder<SessionEventsResponse>
}

export async function mockDashboardApi(
  page: Page,
  scenario: DashboardApiScenario,
): Promise<void> {
  const calls = new Map<string, number>()

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const call = (calls.get(url.pathname) ?? 0) + 1
    calls.set(url.pathname, call)

    const responder = url.pathname === '/api/tree'
      ? scenario.tree
      : url.pathname === '/api/run'
        ? scenario.run
        : url.pathname === '/api/events'
          ? scenario.events
          : url.pathname === '/api/session-events'
            ? scenario.sessionEvents
            : undefined

    if (!responder) {
      await route.fulfill({
        status: 501,
        json: { message: `Unexpected mocked API request: ${url.pathname}` },
      })
      return
    }

    const reply = await responder({ call, url })
    await route.fulfill({
      status: reply.status ?? 200,
      json: reply.json,
    })
  })
}
