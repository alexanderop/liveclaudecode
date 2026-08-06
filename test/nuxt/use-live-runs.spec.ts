import { Effect } from 'effect'
import { flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  EventsResponse,
  RunResponse,
  SessionEventsResponse,
  TranscriptEvent,
} from '#shared/types/run'
import type { ShallowRef } from 'vue'
import type { UseLiveRunsOptions, UseLiveRunsReturn } from '~/composables/useLiveRuns'
import { ApiUnreachable } from '~/api/errors'
import { deferred } from '../fixtures/deferred'
import { mockLiveApi, urlParam } from '../fixtures/live-api'
import { mountWithAtoms, type MountedAtoms } from '../fixtures/mount-atoms'
import {
  eventsResponse,
  runNode,
  runResponse,
  sessionEventsResponse,
  treeResponse,
} from '../fixtures/runs'
import { servingTree, type StubApiHandlers } from '../fixtures/stub-api'

let component: VueWrapper | null = null
let mounted: MountedAtoms | null = null

/**
 * The filters, the preferences, and the range are atoms now, so the harness
 * needs a registry of its own. Without one `injectRegistry` falls back to a
 * module-level singleton and these cases share filter state with every other
 * mounted spec in the worker.
 */
async function mountLive(
  tree: StubApiHandlers,
  options: UseLiveRunsOptions = {},
): Promise<UseLiveRunsReturn> {
  const Harness = defineComponent({
    setup() {
      return { live: useLiveRuns(options) }
    },
    template: '<div />',
  })
  mounted = await mountWithAtoms(Harness, { api: tree })
  component = mounted.wrapper
  await flushPromises()
  return (component.vm as unknown as { live: UseLiveRunsReturn }).live
}

function bodies(events: Readonly<ShallowRef<TranscriptEvent[]>>): Array<string | undefined> {
  return events.value.map(event => event.body)
}

afterEach(() => {
  component?.unmount()
  component = null
  mounted?.registry.dispose()
  mounted = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('useLiveRuns', () => {
  it('selects the deepest live agent and loads its run and events', async () => {
    const child = runNode({
      key: 'session/worker',
      kind: 'subagent',
      label: 'Worker',
      live: true,
      subLive: true,
    })
    const root = runNode({
      children: [child],
      subAgents: 1,
      subRunning: 1,
      subLive: true,
    })
    const fetch = mockLiveApi(root, {
      run: url => runResponse({ key: urlParam(url, 'key')!, node: child, root }),
      events: url => eventsResponse(urlParam(url, 'key')!, ['Working']),
    })

    const live = await mountLive(servingTree(treeResponse(root)))

    expect(live.loading.value).toBe(false)
    expect(live.offline.value).toBe(false)
    expect(live.selectedProject.value).toBe('/repo')
    expect(live.selectedKey.value).toBe(child.key)
    expect(bodies(live.events)).toEqual(['Working'])
    expect(fetch).toHaveBeenCalledWith(
      '/api/events?project=%2Frepo&key=session%2Fworker&since=0&revision=0&hours=168',
      { signal: expect.any(AbortSignal) },
    )
    expect(fetch).toHaveBeenCalledWith(
      '/api/run?project=%2Frepo&key=session%2Fworker&hours=168',
      { signal: expect.any(AbortSignal) },
    )
  })

  it('replaces events when the provider revision requires a reset', async () => {
    vi.useFakeTimers()
    const root = runNode({})
    let eventPoll = 0
    const fetch = mockLiveApi(root, {
      events: () => {
        eventPoll += 1
        return eventPoll === 1
          ? eventsResponse(root.key, ['Initial event'])
          : eventsResponse(root.key, ['Rebuilt event'], { revision: 2, reset: true })
      },
    })

    const live = await mountLive(servingTree(treeResponse(root)))
    expect(bodies(live.events)).toEqual(['Initial event'])

    await vi.advanceTimersByTimeAsync(2_000)
    await flushPromises()

    expect(bodies(live.events)).toEqual(['Rebuilt event'])
    expect(fetch).toHaveBeenCalledWith(
      '/api/events?project=%2Frepo&key=session&since=1&revision=1&hours=168',
      { signal: expect.any(AbortSignal) },
    )
  })

  it('applies the same cursor and revision reset rules to inspected events', async () => {
    vi.useFakeTimers()
    const child = runNode({ key: 'review', label: 'Review agent', kind: 'subagent' })
    const root = runNode({ children: [child], subAgents: 1 })
    let inspectedPoll = 0
    const fetch = mockLiveApi(root, {
      events: (url) => {
        if (urlParam(url, 'key') !== child.key) return eventsResponse(root.key, [])
        inspectedPoll += 1
        return inspectedPoll === 1
          ? eventsResponse(child.key, ['Initial inspection'])
          : eventsResponse(child.key, ['Rebuilt inspection'], { revision: 2, reset: true })
      },
    })

    const live = await mountLive(servingTree(treeResponse(root)))
    await live.inspect(child.key)
    expect(bodies(live.inspectedEvents)).toEqual(['Initial inspection'])

    await vi.advanceTimersByTimeAsync(2_000)
    await flushPromises()

    expect(bodies(live.inspectedEvents)).toEqual(['Rebuilt inspection'])
    expect(fetch).toHaveBeenCalledWith(
      '/api/events?project=%2Frepo&key=review&since=1&revision=1&hours=168',
      { signal: expect.any(AbortSignal) },
    )
  })

  it('rejects an old inspected response after an A-B-A selection cycle', async () => {
    const first = runNode({ key: 'agent-a', label: 'Agent A', kind: 'subagent' })
    const second = runNode({ key: 'agent-b', label: 'Agent B', kind: 'subagent' })
    const root = runNode({ children: [first, second], subAgents: 2 })
    let agentAPoll = 0
    const staleA = deferred<EventsResponse>()
    const freshA = deferred<EventsResponse>()
    mockLiveApi(root, {
      events: (url) => {
        const key = urlParam(url, 'key')
        if (key === first.key) {
          agentAPoll += 1
          return agentAPoll === 1 ? staleA.promise : freshA.promise
        }
        if (key === second.key) return eventsResponse(second.key, ['Agent B event'])
        return eventsResponse(root.key, [])
      },
    })

    const live = await mountLive(servingTree(treeResponse(root)))
    const firstInspection = live.inspect(first.key)
    await flushPromises()
    await live.inspect(second.key)
    const freshInspection = live.inspect(first.key)
    await flushPromises()

    staleA.resolve(eventsResponse(first.key, ['Stale Agent A event']))
    await firstInspection
    await flushPromises()

    expect(bodies(live.inspectedEvents)).toEqual([])
    expect(live.inspectedEventsLoading.value).toBe(true)

    freshA.resolve(eventsResponse(first.key, ['Fresh Agent A event']))
    await freshInspection
    await flushPromises()

    expect(bodies(live.inspectedEvents)).toEqual(['Fresh Agent A event'])
    expect(live.inspectedEventsLoading.value).toBe(false)
  })

  it('keeps a newer selection when an older run response finishes late', async () => {
    const first = runNode({ key: 'first', label: 'First' })
    const second = runNode({ key: 'second', label: 'Second' })
    const root = runNode({ children: [first, second], subAgents: 2 })
    const firstRun = deferred<RunResponse>()
    mockLiveApi(root, {
      run: (url) => {
        if (urlParam(url, 'key') === second.key) {
          return runResponse({ key: second.key, root, node: second })
        }
        return firstRun.promise
      },
    })

    const live = await mountLive(servingTree(treeResponse(root)))
    const selectingSecond = live.select(second.key, '/repo')
    await flushPromises()

    firstRun.resolve(runResponse({ key: root.key, root, node: root }))
    await selectingSecond
    await flushPromises()

    expect(live.selectedKey.value).toBe(second.key)
    expect(live.run.value?.key).toBe(second.key)
  })

  it('rejects stale run and session responses after an A-B-A selection cycle', async () => {
    const first = runNode({ key: 'first', label: 'First' })
    const second = runNode({ key: 'second', label: 'Second' })
    let firstRunRequest = 0
    let firstSessionRequest = 0
    const staleRun = deferred<RunResponse>()
    const freshRun = deferred<RunResponse>()
    const staleSession = deferred<SessionEventsResponse>()
    const freshSession = deferred<SessionEventsResponse>()
    mockLiveApi(first, {
      tree: () => treeResponse([first, second]),
      run: (url) => {
        if (urlParam(url, 'key') !== first.key) {
          return runResponse({ key: second.key, transcriptPath: '/second', node: second, root: second })
        }
        firstRunRequest += 1
        return firstRunRequest === 1 ? staleRun.promise : freshRun.promise
      },
      sessionEvents: (url) => {
        if (urlParam(url, 'key') !== first.key) return sessionEventsResponse(second.key)
        firstSessionRequest += 1
        return firstSessionRequest === 1 ? staleSession.promise : freshSession.promise
      },
    })

    const live = await mountLive(servingTree(treeResponse([first, second])))
    await live.select(second.key, '/repo')
    const freshSelection = live.select(first.key, '/repo')
    await flushPromises()

    freshRun.resolve(runResponse({
      key: first.key,
      transcriptPath: '/fresh-first',
      node: first,
      root: first,
    }))
    freshSession.resolve(sessionEventsResponse(first.key, ['Fresh session event']))
    await freshSelection
    await flushPromises()

    expect(live.run.value?.transcriptPath).toBe('/fresh-first')
    expect(bodies(live.sessionEvents)).toEqual(['Fresh session event'])

    staleRun.reject(new Error('stale run failed'))
    staleSession.resolve(sessionEventsResponse(first.key, ['Stale session event'], { truncated: true }))
    await flushPromises()

    expect(live.run.value?.transcriptPath).toBe('/fresh-first')
    expect(bodies(live.sessionEvents)).toEqual(['Fresh session event'])
    expect(live.sessionEventsTruncated.value).toBe(false)
    expect(live.offline.value).toBe(false)
  })

  it('invalidates pending detail loaders when the user changes the range', async () => {
    const root = runNode({})
    let runRequest = 0
    let sessionRequest = 0
    const staleRun = deferred<RunResponse>()
    const staleSession = deferred<SessionEventsResponse>()
    mockLiveApi(root, {
      run: () => {
        runRequest += 1
        if (runRequest === 1) return staleRun.promise
        return runResponse({ root, node: root, transcriptPath: '/fresh-after-reset' })
      },
      sessionEvents: () => {
        sessionRequest += 1
        if (sessionRequest === 1) return staleSession.promise
        return sessionEventsResponse(root.key, ['Fresh after reset'])
      },
    })

    // A thunk, not one frozen response: the server answers every poll with a
    // fresh object, and re-selecting after a range change is driven by the tree
    // publishing a new value.
    const live = await mountLive(servingTree(() => treeResponse(root)))
    expect(runRequest).toBe(1)

    live.hours.value = 24
    await flushPromises()

    // The range change re-selects from the new tree, so both detail endpoints
    // are asked again — and the answers to the pre-change requests, which are
    // still in flight, must not land.
    expect(runRequest).toBe(2)
    expect(sessionRequest).toBe(2)

    staleRun.resolve(runResponse({ root, node: root, transcriptPath: '/stale-before-reset' }))
    staleSession.resolve(sessionEventsResponse(root.key, ['Stale before reset'], { truncated: true }))
    await flushPromises()

    expect(live.run.value?.transcriptPath).toBe('/fresh-after-reset')
    expect(bodies(live.sessionEvents)).toEqual(['Fresh after reset'])
    expect(live.sessionEventsTruncated.value).toBe(false)
  })

  it('deduplicates pending details across repeated and same-root selections', async () => {
    const child = runNode({ key: 'session/child', kind: 'subagent', label: 'Child' })
    const root = runNode({ children: [child], subAgents: 1 })
    const rootRun = deferred<RunResponse>()
    const rootSession = deferred<SessionEventsResponse>()
    const fetch = mockLiveApi(root, {
      run: url => urlParam(url, 'key') === child.key
        ? runResponse({ key: child.key, root, node: child, transcriptPath: '/child' })
        : rootRun.promise,
      sessionEvents: () => rootSession.promise,
    })

    const live = await mountLive(servingTree(treeResponse(root)))
    const repeatedRoot = live.select(root.key, '/repo')
    await flushPromises()
    await live.select(child.key, '/repo')
    await flushPromises()

    expect(fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/run'))).toHaveLength(2)
    expect(fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/session-events'))).toHaveLength(1)
    expect(live.run.value?.transcriptPath).toBe('/child')

    rootRun.resolve(runResponse({ root, node: root, transcriptPath: '/stale-root' }))
    rootSession.resolve(sessionEventsResponse(root.key))
    await repeatedRoot
    await flushPromises()

    expect(live.run.value?.transcriptPath).toBe('/child')
  })

  it('reports the viewer as offline while the tree poll is failing', async () => {
    mockLiveApi(runNode({}))

    const live = await mountLive({
      tree: () => Effect.fail(new ApiUnreachable({ url: '/api/tree', detail: 'connect ECONNREFUSED' })),
    })

    // Recovery on the next tick is the feed loop's own behaviour and is
    // asserted against `TestClock` in `test/unit/atoms/tree.spec.ts`.
    expect(live.loading.value).toBe(false)
    expect(live.offline.value).toBe(true)
    expect(live.projects.value).toEqual([])
  })

  it('reloads every session endpoint when the date range changes, including all time', async () => {
    const root = runNode({})
    const fetch = mockLiveApi(root)

    const live = await mountLive(servingTree(() => treeResponse(root)))
    expect(live.hours.value).toBe(168)

    fetch.mockClear()
    live.hours.value = 0
    await flushPromises()

    expect(fetch.mock.calls.map(([url]) => url)).toEqual(expect.arrayContaining([
      '/api/run?project=%2Frepo&key=session&hours=0',
      '/api/events?project=%2Frepo&key=session&since=0&revision=0&hours=0',
      '/api/session-events?project=%2Frepo&key=session&limit=800&hours=0',
    ]))
    expect(live.hours.value).toBe(0)
  })

  it('preserves a custom launch-time range until the user changes it', async () => {
    const root = runNode({})
    const fetch = mockLiveApi(root, { tree: () => treeResponse(root, 3) })

    const live = await mountLive(servingTree(treeResponse(root, 3)))

    // The client never guessed a range: it asked for none, and adopted the one
    // the server answered with — which every detail request then carries.
    expect(live.hours.value).toBe(3)
    expect(fetch).toHaveBeenCalledWith(
      '/api/run?project=%2Frepo&key=session&hours=3',
      { signal: expect.any(AbortSignal) },
    )
  })

})
