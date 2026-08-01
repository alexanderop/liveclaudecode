import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { EventsResponse, TranscriptEvent } from '#shared/types/run'
import type { EventCursor } from '~/utils/event-poller'
import { createEventPoller } from '~/utils/event-poller'
import { deferred } from '../fixtures/deferred'
import { eventsResponse } from '../fixtures/runs'

function cursor(): EventCursor {
  return { since: ref(0), revision: ref(0), events: ref<TranscriptEvent[]>([]) }
}

interface HarnessOptions {
  readonly key?: () => string | null
  readonly project?: () => string | null
  readonly hours?: () => number
  readonly request?: (
    url: string,
    isCurrent: () => boolean,
  ) => Promise<EventsResponse | null>
  readonly settled?: (requestedKey: string) => void
}

function poller(target: EventCursor, options: HarnessOptions = {}) {
  return createEventPoller({
    currentKey: options.key ?? (() => 'agent'),
    currentProject: options.project ?? (() => '/repo'),
    currentHours: options.hours ?? (() => 168),
    cursor: target,
    request: options.request
      ?? (async () => eventsResponse('agent', ['Working'])),
    settled: options.settled,
  })
}

describe('createEventPoller', () => {
  it('requests from the cursor position and appends the response', async () => {
    const target = cursor()
    const request = vi.fn(async () => eventsResponse('agent', ['One'], { next: 3, revision: 2 }))
    const events = poller(target, { request })

    await events.poll()

    expect(request).toHaveBeenCalledWith(
      '/api/events?project=%2Frepo&key=agent&since=0&revision=0&hours=168',
      expect.any(Function),
    )
    expect(target.events.value.map(event => event.body)).toEqual(['One'])
    expect(target.since.value).toBe(3)
    expect(target.revision.value).toBe(2)

    await events.poll()

    expect(request).toHaveBeenLastCalledWith(
      '/api/events?project=%2Frepo&key=agent&since=3&revision=2&hours=168',
      expect.any(Function),
    )
    expect(target.events.value.map(event => event.body)).toEqual(['One', 'One'])
  })

  it('replaces the buffer when the provider signals a rebuild', async () => {
    const target = cursor()
    let calls = 0
    const events = poller(target, {
      request: async () => {
        calls += 1
        return calls === 1
          ? eventsResponse('agent', ['Initial'])
          : eventsResponse('agent', ['Rebuilt'], { revision: 2, reset: true })
      },
    })

    await events.poll()
    await events.poll()

    expect(target.events.value.map(event => event.body)).toEqual(['Rebuilt'])
    expect(target.revision.value).toBe(2)
  })

  it('skips polling while the target is unset', async () => {
    const target = cursor()
    const request = vi.fn(async () => eventsResponse('agent', ['Working']))
    const events = poller(target, { key: () => null, request })

    await events.poll()

    expect(request).not.toHaveBeenCalled()
  })

  it('deduplicates concurrent polls for the same target', async () => {
    const target = cursor()
    const pending = deferred<EventsResponse>()
    const request = vi.fn(() => pending.promise)
    const events = poller(target, { request })

    const first = events.poll()
    const second = events.poll()
    pending.resolve(eventsResponse('agent', ['Once']))
    await Promise.all([first, second])

    expect(request).toHaveBeenCalledTimes(1)
    expect(target.events.value.map(event => event.body)).toEqual(['Once'])
  })

  it('drops a response that resolves after reset and clears the cursor', async () => {
    const target = cursor()
    const pending = deferred<EventsResponse>()
    const events = poller(target, { request: () => pending.promise })

    const stale = events.poll()
    events.reset()
    pending.resolve(eventsResponse('agent', ['Stale']))
    await stale

    expect(target.events.value).toEqual([])
    expect(target.since.value).toBe(0)
    expect(target.revision.value).toBe(0)
  })

  it('drops a response when the target changed while it was in flight', async () => {
    const target = cursor()
    let key = 'agent-a'
    const pending = deferred<EventsResponse>()
    const events = poller(target, { key: () => key, request: () => pending.promise })

    const stale = events.poll()
    key = 'agent-b'
    pending.resolve(eventsResponse('agent-a', ['Stale']))
    await stale

    expect(target.events.value).toEqual([])
  })

  it('notifies settled only for the newest generation', async () => {
    const target = cursor()
    const settled = vi.fn()
    const pending = deferred<EventsResponse>()
    const events = poller(target, { request: () => pending.promise, settled })

    const stale = events.poll()
    events.reset()
    pending.resolve(eventsResponse('agent', ['Stale']))
    await stale

    expect(settled).not.toHaveBeenCalled()

    const fresh = poller(target, { settled })
    await fresh.poll()

    expect(settled).toHaveBeenCalledWith('agent')
  })
})
