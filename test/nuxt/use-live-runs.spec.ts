import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  EventsResponse,
  RunNode,
  RunResponse,
  SessionEventsResponse,
  TreeResponse,
} from '#shared/types/run'
import { runResponse } from '../fixtures/runs'

const Harness = defineComponent({
  setup() {
    return { live: useLiveRuns() }
  },
  template: `
    <div
      :data-loading="String(live.loading.value)"
      :data-offline="String(live.offline.value)"
      :data-project="live.selectedProject.value || ''"
      :data-key="live.selectedKey.value || ''"
      :data-events="live.events.value.map(event => event.body).join('|')"
      :data-inspected="live.inspectedEvents.value.map(event => event.body).join('|')"
      :data-inspected-loading="String(live.inspectedEventsLoading.value)"
      :data-hours="String(live.hours.value)"
    />
  `,
})

function node(overrides: Partial<RunNode>): RunNode {
  return {
    source: 'claude',
    sourceDetail: 'Claude Code',
    key: 'session',
    kind: 'session',
    sid: 'session',
    label: 'Session',
    agentType: '',
    toolUseId: null,
    model: '',
    spawnDepth: null,
    parentAgentId: null,
    stoppedByUser: false,
    spawnState: '',
    children: [],
    records: 1,
    tools: 0,
    toolCounts: {},
    reads: 0,
    errors: 0,
    tokensOut: 0,
    firstTs: null,
    lastTs: null,
    mtime: 0,
    ago: 0,
    live: false,
    size: 0,
    todos: null,
    skills: [],
    milestones: [],
    current: null,
    files: [],
    commands: [],
    finalText: '',
    subAgents: 0,
    subRunning: 0,
    subErrors: 0,
    subTools: 0,
    subFiles: {},
    subLast: null,
    subLive: false,
    ...overrides,
  }
}

function tree(root: RunNode, hours = 168): TreeResponse {
  return {
    projects: [{ id: '/repo', name: 'repo', roots: [root] }],
    sources: [],
    now: 0,
    hours,
  }
}

function events(
  key: string,
  body: string,
  options: Partial<EventsResponse> = {},
): EventsResponse {
  return {
    key,
    events: body
      ? [{
          role: 'assistant',
          kind: 'text',
          ts: '2026-07-29T08:00:00.000Z',
          line: 1,
          body,
        }]
      : [],
    next: body ? 1 : 0,
    revision: 1,
    reset: false,
    node: node({ key }),
    ...options,
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useLiveRuns', () => {
  it('selects the deepest live agent and loads its run and events', async () => {
    const child = node({
      key: 'session/worker',
      kind: 'subagent',
      label: 'Worker',
      live: true,
      subLive: true,
    })
    const root = node({
      children: [child],
      subAgents: 1,
      subRunning: 1,
      subLive: true,
    })
    const fetch = vi.fn(async (url: string) => {
      if (url === '/api/tree') return tree(root)
      if (url.startsWith('/api/run')) return runResponse({ key: child.key, node: child, root })
      if (url.startsWith('/api/session-events')) return { key: root.key, events: [], total: 0, truncated: false }
      if (url.startsWith('/api/events')) return events(child.key, 'Working')
      throw new Error(`Unexpected URL: ${url}`)
    })
    vi.stubGlobal('$fetch', fetch)

    const component = await mountSuspended(Harness)
    await flushPromises()

    expect(component.attributes()).toMatchObject({
      'data-loading': 'false',
      'data-offline': 'false',
      'data-project': '/repo',
      'data-key': child.key,
      'data-events': 'Working',
    })
    expect(fetch).toHaveBeenCalledWith(
      '/api/events?project=%2Frepo&key=session%2Fworker&since=0&revision=0&hours=168',
      { signal: expect.any(AbortSignal) },
    )
    expect(fetch).toHaveBeenCalledWith(
      '/api/run?project=%2Frepo&key=session%2Fworker&hours=168',
      { signal: expect.any(AbortSignal) },
    )

    component.unmount()
  })

  it('replaces events when the provider revision requires a reset', async () => {
    vi.useFakeTimers()
    const root = node({})
    let eventPoll = 0
    const fetch = vi.fn(async (url: string) => {
      if (url === '/api/tree') return tree(root)
      if (url.startsWith('/api/run')) return runResponse({ root, node: root })
      if (url.startsWith('/api/session-events')) return { key: root.key, events: [], total: 0, truncated: false }
      if (url.startsWith('/api/events')) {
        eventPoll += 1
        return eventPoll === 1
          ? events(root.key, 'Initial event', { next: 1, revision: 1 })
          : events(root.key, 'Rebuilt event', { next: 1, revision: 2, reset: true })
      }
      throw new Error(`Unexpected URL: ${url}`)
    })
    vi.stubGlobal('$fetch', fetch)

    const component = await mountSuspended(Harness)
    await flushPromises()
    expect(component.attributes('data-events')).toBe('Initial event')

    await vi.advanceTimersByTimeAsync(2_000)
    await flushPromises()

    expect(component.attributes('data-events')).toBe('Rebuilt event')
    expect(fetch).toHaveBeenCalledWith(
      '/api/events?project=%2Frepo&key=session&since=1&revision=1&hours=168',
      { signal: expect.any(AbortSignal) },
    )

    component.unmount()
  })

  it('applies the same cursor and revision reset rules to inspected events', async () => {
    vi.useFakeTimers()
    const child = node({ key: 'review', label: 'Review agent', kind: 'subagent' })
    const root = node({ children: [child], subAgents: 1 })
    let inspectedPoll = 0
    const fetch = vi.fn(async (url: string) => {
      if (url === '/api/tree') return tree(root)
      if (url.startsWith('/api/run')) return runResponse({ root, node: root })
      if (url.startsWith('/api/session-events')) {
        return { key: root.key, events: [], total: 0, truncated: false }
      }
      if (url.includes('key=review')) {
        inspectedPoll += 1
        return inspectedPoll === 1
          ? events(child.key, 'Initial inspection', { next: 1, revision: 1 })
          : events(child.key, 'Rebuilt inspection', { next: 1, revision: 2, reset: true })
      }
      if (url.startsWith('/api/events')) return events(root.key, '')
      throw new Error(`Unexpected URL: ${url}`)
    })
    vi.stubGlobal('$fetch', fetch)

    const component = await mountSuspended(Harness)
    await flushPromises()
    await component.vm.live.inspect(child.key)
    expect(component.attributes('data-inspected')).toBe('Initial inspection')

    await vi.advanceTimersByTimeAsync(2_000)
    await flushPromises()

    expect(component.attributes('data-inspected')).toBe('Rebuilt inspection')
    expect(fetch).toHaveBeenCalledWith(
      '/api/events?project=%2Frepo&key=review&since=1&revision=1&hours=168',
      { signal: expect.any(AbortSignal) },
    )

    component.unmount()
  })

  it('rejects an old inspected response after an A-B-A selection cycle', async () => {
    const first = node({ key: 'agent-a', label: 'Agent A', kind: 'subagent' })
    const second = node({ key: 'agent-b', label: 'Agent B', kind: 'subagent' })
    const root = node({ children: [first, second], subAgents: 2 })
    let agentAPoll = 0
    let resolveStaleA!: (value: EventsResponse) => void
    let resolveFreshA!: (value: EventsResponse) => void
    const staleA = new Promise<EventsResponse>((resolve) => {
      resolveStaleA = resolve
    })
    const freshA = new Promise<EventsResponse>((resolve) => {
      resolveFreshA = resolve
    })
    const fetch = vi.fn(async (url: string) => {
      if (url === '/api/tree') return tree(root)
      if (url.startsWith('/api/run')) return runResponse({ root, node: root })
      if (url.startsWith('/api/session-events')) {
        return { key: root.key, events: [], total: 0, truncated: false }
      }
      if (url.includes('key=agent-a')) {
        agentAPoll += 1
        return agentAPoll === 1 ? staleA : freshA
      }
      if (url.includes('key=agent-b')) return events(second.key, 'Agent B event')
      if (url.startsWith('/api/events')) return events(root.key, '')
      throw new Error(`Unexpected URL: ${url}`)
    })
    vi.stubGlobal('$fetch', fetch)

    const component = await mountSuspended(Harness)
    await flushPromises()
    const firstInspection = component.vm.live.inspect(first.key)
    await flushPromises()
    await component.vm.live.inspect(second.key)
    const freshInspection = component.vm.live.inspect(first.key)
    await flushPromises()

    resolveStaleA(events(first.key, 'Stale Agent A event'))
    await firstInspection
    await flushPromises()

    expect(component.attributes()).toMatchObject({
      'data-inspected': '',
      'data-inspected-loading': 'true',
    })

    resolveFreshA(events(first.key, 'Fresh Agent A event'))
    await freshInspection
    await flushPromises()

    expect(component.attributes()).toMatchObject({
      'data-inspected': 'Fresh Agent A event',
      'data-inspected-loading': 'false',
    })

    component.unmount()
  })

  it('keeps a newer selection when an older run response finishes late', async () => {
    const first = node({ key: 'first', label: 'First' })
    const second = node({ key: 'second', label: 'Second' })
    const root = node({ children: [first, second], subAgents: 2 })
    let resolveFirstRun!: (value: ReturnType<typeof runResponse>) => void
    const firstRun = new Promise<ReturnType<typeof runResponse>>((resolve) => {
      resolveFirstRun = resolve
    })
    const fetch = vi.fn(async (url: string) => {
      if (url === '/api/tree') return tree(root)
      if (url.includes('/api/run') && url.includes('key=session')) return firstRun
      if (url.includes('/api/run') && url.includes('key=second')) {
        return runResponse({ key: second.key, root, node: second })
      }
      if (url.startsWith('/api/session-events')) return { key: root.key, events: [], total: 0, truncated: false }
      if (url.startsWith('/api/events')) {
        const key = url.includes('key=second') ? second.key : root.key
        return events(key, '')
      }
      throw new Error(`Unexpected URL: ${url}`)
    })
    vi.stubGlobal('$fetch', fetch)

    const component = await mountSuspended(Harness)
    await flushPromises()
    const live = component.vm.live
    const selectingSecond = live.select(second.key, '/repo')
    await flushPromises()

    resolveFirstRun(runResponse({ key: root.key, root, node: root }))
    await selectingSecond
    await flushPromises()

    expect(component.attributes('data-key')).toBe(second.key)
    expect(live.run.value?.key).toBe(second.key)

    component.unmount()
  })

  it('rejects stale run and session responses after an A-B-A selection cycle', async () => {
    const first = node({ key: 'first', label: 'First' })
    const second = node({ key: 'second', label: 'Second' })
    const treeResponse = tree(first)
    treeResponse.projects[0]!.roots = [first, second]
    let firstRunRequest = 0
    let firstSessionRequest = 0
    let rejectStaleRun!: (error: Error) => void
    let resolveFreshRun!: (value: RunResponse) => void
    let resolveStaleSession!: (value: SessionEventsResponse) => void
    let resolveFreshSession!: (value: SessionEventsResponse) => void
    const staleRun = new Promise<RunResponse>((_resolve, reject) => {
      rejectStaleRun = reject
    })
    const freshRun = new Promise<RunResponse>((resolve) => {
      resolveFreshRun = resolve
    })
    const staleSession = new Promise<SessionEventsResponse>((resolve) => {
      resolveStaleSession = resolve
    })
    const freshSession = new Promise<SessionEventsResponse>((resolve) => {
      resolveFreshSession = resolve
    })
    const fetch = vi.fn(async (url: string) => {
      if (url === '/api/tree') return treeResponse
      if (url.startsWith('/api/run') && url.includes('key=first')) {
        firstRunRequest += 1
        return firstRunRequest === 1 ? staleRun : freshRun
      }
      if (url.startsWith('/api/run') && url.includes('key=second')) {
        return runResponse({ key: second.key, transcriptPath: '/second', node: second, root: second })
      }
      if (url.startsWith('/api/session-events') && url.includes('key=first')) {
        firstSessionRequest += 1
        return firstSessionRequest === 1 ? staleSession : freshSession
      }
      if (url.startsWith('/api/session-events') && url.includes('key=second')) {
        return { key: second.key, events: [], total: 0, truncated: false }
      }
      if (url.startsWith('/api/events')) {
        const key = url.includes('key=second') ? second.key : first.key
        return events(key, '')
      }
      throw new Error(`Unexpected URL: ${url}`)
    })
    vi.stubGlobal('$fetch', fetch)

    const component = await mountSuspended(Harness)
    await flushPromises()
    const live = component.vm.live
    await live.select(second.key, '/repo')
    const freshSelection = live.select(first.key, '/repo')
    await flushPromises()

    resolveFreshRun(runResponse({
      key: first.key,
      transcriptPath: '/fresh-first',
      node: first,
      root: first,
    }))
    resolveFreshSession({
      key: first.key,
      events: events(first.key, 'Fresh session event').events,
      total: 1,
      truncated: false,
    })
    await freshSelection
    await flushPromises()

    expect(live.run.value?.transcriptPath).toBe('/fresh-first')
    expect(live.sessionEvents.value.map(event => event.body)).toEqual(['Fresh session event'])

    rejectStaleRun(new Error('stale run failed'))
    resolveStaleSession({
      key: first.key,
      events: events(first.key, 'Stale session event').events,
      total: 1,
      truncated: true,
    })
    await flushPromises()

    expect(live.run.value?.transcriptPath).toBe('/fresh-first')
    expect(live.sessionEvents.value.map(event => event.body)).toEqual(['Fresh session event'])
    expect(live.sessionEventsTruncated.value).toBe(false)
    expect(live.offline.value).toBe(false)

    component.unmount()
  })

  it('invalidates pending loaders across a coalesced hour-range reset', async () => {
    vi.useFakeTimers()
    const root = node({})
    let runRequest = 0
    let sessionRequest = 0
    let treeRangeRequest = 0
    let resolveStaleTree!: (value: TreeResponse) => void
    let resolveStaleRun!: (value: RunResponse) => void
    let resolveStaleSession!: (value: SessionEventsResponse) => void
    const staleTree = new Promise<TreeResponse>((resolve) => {
      resolveStaleTree = resolve
    })
    const staleRun = new Promise<RunResponse>((resolve) => {
      resolveStaleRun = resolve
    })
    const staleSession = new Promise<SessionEventsResponse>((resolve) => {
      resolveStaleSession = resolve
    })
    const fetch = vi.fn(async (url: string) => {
      if (url === '/api/tree') return tree(root)
      if (url.startsWith('/api/tree?hours=')) {
        treeRangeRequest += 1
        return treeRangeRequest === 1 ? staleTree : tree(root)
      }
      if (url.startsWith('/api/run')) {
        runRequest += 1
        if (runRequest === 2) return staleRun
        return runResponse({
          root,
          node: root,
          transcriptPath: runRequest === 1 ? '/initial' : '/fresh-after-reset',
        })
      }
      if (url.startsWith('/api/session-events')) {
        sessionRequest += 1
        if (sessionRequest === 2) return staleSession
        return {
          key: root.key,
          events: events(root.key, sessionRequest === 1 ? 'Initial session' : 'Fresh after reset').events,
          total: 1,
          truncated: false,
        }
      }
      if (url.startsWith('/api/events')) return events(root.key, '')
      throw new Error(`Unexpected URL: ${url}`)
    })
    vi.stubGlobal('$fetch', fetch)

    const component = await mountSuspended(Harness)
    await flushPromises()
    const live = component.vm.live
    await vi.advanceTimersByTimeAsync(6_000)
    await flushPromises()
    expect(runRequest).toBe(2)
    expect(sessionRequest).toBe(2)

    live.hours.value = 24
    await flushPromises()
    live.hours.value = 168
    await flushPromises()
    resolveStaleTree(tree(node({
      key: 'stale-session',
      sid: 'stale-session',
      label: 'Stale pre-reset session',
    })))
    await flushPromises()

    expect(fetch).not.toHaveBeenCalledWith(
      '/api/tree?hours=24',
      { signal: expect.any(AbortSignal) },
    )
    expect(fetch).not.toHaveBeenCalledWith(
      '/api/run?project=%2Frepo&key=session&hours=24',
      { signal: expect.any(AbortSignal) },
    )
    expect(fetch.mock.calls.some(([url]) => String(url).includes('key=stale-session'))).toBe(false)
    expect(treeRangeRequest).toBe(2)
    expect(runRequest).toBe(3)
    expect(sessionRequest).toBe(3)
    expect(live.run.value?.transcriptPath).toBe('/fresh-after-reset')
    expect(live.sessionEvents.value.map(event => event.body)).toEqual(['Fresh after reset'])

    resolveStaleRun(runResponse({ root, node: root, transcriptPath: '/stale-before-reset' }))
    resolveStaleSession({
      key: root.key,
      events: events(root.key, 'Stale before reset').events,
      total: 1,
      truncated: true,
    })
    await flushPromises()

    expect(live.run.value?.transcriptPath).toBe('/fresh-after-reset')
    expect(live.sessionEvents.value.map(event => event.body)).toEqual(['Fresh after reset'])
    expect(live.sessionEventsTruncated.value).toBe(false)

    component.unmount()
  })

  it('refreshes the tree range while initial detail loaders remain pending', async () => {
    const root = node({})
    let runRequest = 0
    let sessionRequest = 0
    let resolveInitialRun!: (value: RunResponse) => void
    let resolveInitialSession!: (value: SessionEventsResponse) => void
    const initialRun = new Promise<RunResponse>((resolve) => {
      resolveInitialRun = resolve
    })
    const initialSession = new Promise<SessionEventsResponse>((resolve) => {
      resolveInitialSession = resolve
    })
    const fetch = vi.fn(async (url: string) => {
      if (url === '/api/tree') return tree(root)
      if (url === '/api/tree?hours=24') return tree(root, 24)
      if (url.startsWith('/api/run')) {
        runRequest += 1
        return runRequest === 1
          ? initialRun
          : runResponse({ root, node: root, transcriptPath: '/range-24' })
      }
      if (url.startsWith('/api/session-events')) {
        sessionRequest += 1
        return sessionRequest === 1
          ? initialSession
          : {
              key: root.key,
              events: events(root.key, 'Range 24 session').events,
              total: 1,
              truncated: false,
            }
      }
      if (url.startsWith('/api/events')) return events(root.key, '')
      throw new Error(`Unexpected URL: ${url}`)
    })
    vi.stubGlobal('$fetch', fetch)

    const component = await mountSuspended(Harness)
    await flushPromises()
    const live = component.vm.live
    expect(runRequest).toBe(1)
    expect(sessionRequest).toBe(1)

    live.hours.value = 24
    await flushPromises()

    expect(fetch).toHaveBeenCalledWith(
      '/api/tree?hours=24',
      { signal: expect.any(AbortSignal) },
    )
    expect(runRequest).toBe(2)
    expect(sessionRequest).toBe(2)
    expect(live.run.value?.transcriptPath).toBe('/range-24')
    expect(live.sessionEvents.value.map(event => event.body)).toEqual(['Range 24 session'])

    resolveInitialRun(runResponse({ root, node: root, transcriptPath: '/stale-initial' }))
    resolveInitialSession({
      key: root.key,
      events: events(root.key, 'Stale initial session').events,
      total: 1,
      truncated: true,
    })
    await flushPromises()

    expect(live.run.value?.transcriptPath).toBe('/range-24')
    expect(live.sessionEvents.value.map(event => event.body)).toEqual(['Range 24 session'])

    component.unmount()
  })

  it('deduplicates pending details across repeated and same-root selections', async () => {
    const child = node({ key: 'session/child', kind: 'subagent', label: 'Child' })
    const root = node({ children: [child], subAgents: 1 })
    let resolveRootRun!: (value: RunResponse) => void
    let resolveRootSession!: (value: SessionEventsResponse) => void
    const rootRun = new Promise<RunResponse>((resolve) => {
      resolveRootRun = resolve
    })
    const rootSession = new Promise<SessionEventsResponse>((resolve) => {
      resolveRootSession = resolve
    })
    const fetch = vi.fn(async (url: string) => {
      if (url === '/api/tree') return tree(root)
      if (url.startsWith('/api/run') && url.includes('key=session%2Fchild')) {
        return runResponse({ key: child.key, root, node: child, transcriptPath: '/child' })
      }
      if (url.startsWith('/api/run')) return rootRun
      if (url.startsWith('/api/session-events')) return rootSession
      if (url.startsWith('/api/events')) {
        return events(url.includes('key=session%2Fchild') ? child.key : root.key, '')
      }
      throw new Error(`Unexpected URL: ${url}`)
    })
    vi.stubGlobal('$fetch', fetch)

    const component = await mountSuspended(Harness)
    await flushPromises()
    const live = component.vm.live
    const repeatedRoot = live.select(root.key, '/repo')
    await flushPromises()
    await live.select(child.key, '/repo')
    await flushPromises()

    expect(fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/run'))).toHaveLength(2)
    expect(fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/session-events'))).toHaveLength(1)
    expect(live.run.value?.transcriptPath).toBe('/child')

    resolveRootRun(runResponse({ root, node: root, transcriptPath: '/stale-root' }))
    resolveRootSession({ key: root.key, events: [], total: 0, truncated: false })
    await repeatedRoot
    await flushPromises()

    expect(live.run.value?.transcriptPath).toBe('/child')

    component.unmount()
  })

  it('surfaces request failures as offline and recovers on a later successful poll', async () => {
    vi.useFakeTimers()
    const root = node({})
    let treeCalls = 0
    const fetch = vi.fn(async (url: string) => {
      if (url === '/api/tree') {
        treeCalls += 1
        if (treeCalls === 1) throw new Error('server unavailable')
        return tree(root)
      }
      if (url.startsWith('/api/run')) return runResponse({ root, node: root })
      if (url.startsWith('/api/session-events')) return { key: root.key, events: [], total: 0, truncated: false }
      if (url.startsWith('/api/events')) return events(root.key, '')
      throw new Error(`Unexpected URL: ${url}`)
    })
    vi.stubGlobal('$fetch', fetch)

    const component = await mountSuspended(Harness)
    await flushPromises()
    expect(component.attributes()).toMatchObject({
      'data-loading': 'false',
      'data-offline': 'true',
    })

    await vi.advanceTimersByTimeAsync(4_000)
    await flushPromises()

    expect(component.attributes()).toMatchObject({
      'data-loading': 'false',
      'data-offline': 'false',
      'data-key': root.key,
    })

    component.unmount()
  })

  it('reloads every session endpoint when the date range changes, including all time', async () => {
    const root = node({})
    const fetch = vi.fn(async (url: string) => {
      if (url === '/api/tree' || url.startsWith('/api/tree?hours=')) return tree(root)
      if (url.startsWith('/api/run')) return runResponse({ root, node: root })
      if (url.startsWith('/api/session-events')) return { key: root.key, events: [], total: 0, truncated: false }
      if (url.startsWith('/api/events')) return events(root.key, '')
      throw new Error(`Unexpected URL: ${url}`)
    })
    vi.stubGlobal('$fetch', fetch)

    const component = await mountSuspended(Harness)
    await flushPromises()
    expect(component.attributes('data-hours')).toBe('168')

    fetch.mockClear()
    component.vm.live.hours.value = 0
    await flushPromises()

    expect(fetch.mock.calls.map(([url]) => url)).toEqual(expect.arrayContaining([
      '/api/tree?hours=0',
      '/api/run?project=%2Frepo&key=session&hours=0',
      '/api/events?project=%2Frepo&key=session&since=0&revision=0&hours=0',
      '/api/session-events?project=%2Frepo&key=session&limit=800&hours=0',
    ]))
    expect(component.attributes('data-hours')).toBe('0')

    component.unmount()
  })

  it('preserves a custom launch-time range until the user changes it', async () => {
    const root = node({})
    const fetch = vi.fn(async (url: string) => {
      if (url === '/api/tree') return tree(root, 3)
      if (url.startsWith('/api/run')) return runResponse({ root, node: root })
      if (url.startsWith('/api/session-events')) return { key: root.key, events: [], total: 0, truncated: false }
      if (url.startsWith('/api/events')) return events(root.key, '')
      throw new Error(`Unexpected URL: ${url}`)
    })
    vi.stubGlobal('$fetch', fetch)

    const component = await mountSuspended(Harness)
    await flushPromises()

    expect(component.attributes('data-hours')).toBe('3')
    expect(fetch).toHaveBeenCalledWith(
      '/api/run?project=%2Frepo&key=session&hours=3',
      { signal: expect.any(AbortSignal) },
    )
    expect(fetch).not.toHaveBeenCalledWith(
      '/api/tree?hours=168',
      { signal: expect.any(AbortSignal) },
    )

    component.unmount()
  })

  it('aborts pending requests and drops queued tree work on unmount', async () => {
    vi.useFakeTimers()
    let resolveTree!: (value: TreeResponse) => void
    let treeSignal!: AbortSignal
    const pendingTree = new Promise<TreeResponse>((resolve) => {
      resolveTree = resolve
    })
    const fetch = vi.fn((url: string, options?: { signal?: AbortSignal }) => {
      if (url === '/api/tree') {
        treeSignal = options!.signal!
        return pendingTree
      }
      throw new Error(`Unexpected post-unmount request: ${url}`)
    })
    vi.stubGlobal('$fetch', fetch)

    const component = await mountSuspended(Harness)
    await flushPromises()
    const live = component.vm.live
    await vi.advanceTimersByTimeAsync(4_000)
    component.unmount()

    expect(treeSignal.aborted).toBe(true)
    resolveTree(tree(node({ key: 'must-not-load' })))
    await flushPromises()

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(live.projects.value).toEqual([])
  })
})
