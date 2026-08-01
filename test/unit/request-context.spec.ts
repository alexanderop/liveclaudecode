import { describe, expect, it, vi } from 'vitest'
import { browserOptionsFor } from '../../server/utils/request-context'

// `h3` is provided to the real server by Nitro's bundler and is not
// resolvable from the unit-test project; `getQuery` is substituted with the
// same query-string parsing over `event.path` the real one performs.
// (`vi.mock` is hoisted above the imports, so the mock is in place before
// request-context.ts loads.)
vi.mock('h3', () => ({
  getQuery: (event: { path?: string }) =>
    Object.fromEntries(new URLSearchParams((event.path ?? '').split('?')[1] ?? '')),
}))

type RequestEvent = Parameters<typeof browserOptionsFor>[0]

function eventFor(path: string, lcc: { project?: unknown, hours?: unknown }): RequestEvent {
  // `useRuntimeConfig` is a Nitro auto-import resolved as a global at runtime.
  vi.stubGlobal('useRuntimeConfig', () => ({ lcc }))
  return { path } as unknown as RequestEvent
}

describe('browserOptionsFor', () => {
  it('returns the configured project and hours when the query has no override', () => {
    expect(browserOptionsFor(eventFor('/api/tree', { project: '/repo', hours: 24 }))).toEqual({
      project: '/repo',
      hours: 24,
    })
  })

  it('lets a valid hours query override the configured range, including zero', () => {
    expect(browserOptionsFor(eventFor('/api/tree?hours=48', { project: '', hours: 24 })).hours).toBe(48)
    expect(browserOptionsFor(eventFor('/api/tree?hours=0', { project: '', hours: 24 })).hours).toBe(0)
  })

  it('falls back to the configured hours for an invalid query override', () => {
    expect(browserOptionsFor(eventFor('/api/tree?hours=soon', { project: '', hours: 24 })).hours).toBe(24)
    expect(browserOptionsFor(eventFor('/api/tree?hours=-1', { project: '', hours: 24 })).hours).toBe(24)
  })

  it('uses a week when both the query and configured hours are unusable', () => {
    expect(browserOptionsFor(eventFor('/api/tree?hours=nope', { project: '', hours: 'bogus' })).hours).toBe(168)
  })

  it('coerces a missing project to the empty string', () => {
    expect(browserOptionsFor(eventFor('/api/tree', { hours: 24 })).project).toBe('')
    expect(browserOptionsFor(eventFor('/api/tree', { project: undefined, hours: 24 })).project).toBe('')
  })
})
