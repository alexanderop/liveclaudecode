import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EventsResponse, RunNode, TreeResponse } from '#shared/types/run'
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
    )
    expect(fetch).toHaveBeenCalledWith(
      '/api/run?project=%2Frepo&key=session%2Fworker&hours=168',
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
    )

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
    expect(fetch).toHaveBeenCalledWith('/api/run?project=%2Frepo&key=session&hours=3')
    expect(fetch).not.toHaveBeenCalledWith('/api/tree?hours=168')

    component.unmount()
  })
})
