import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { defineComponent, shallowRef } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatAgentId, ChatEvent, ChatEventsResponse, ChatStatus } from '#shared/types/chat'
import type { ChatTransportState, UseChatTransportReturn } from '~/composables/useChatTransport'
import { chatActionResponse, chatEventsResponse } from '../fixtures/chat'
import { deferred } from '../fixtures/deferred'
import { mockLiveApi, urlParam } from '../fixtures/live-api'
import { runNode } from '../fixtures/runs'

let component: VueWrapper | null = null

interface Harness {
  transport: UseChatTransportReturn
  state: ChatTransportState
  sessionKey: ReturnType<typeof shallowRef<string>>
  hours: ReturnType<typeof shallowRef<number>>
}

function transportState(): ChatTransportState {
  return {
    events: shallowRef<ChatEvent[]>([]),
    since: shallowRef(0),
    revision: shallowRef(0),
    status: shallowRef<ChatStatus>('idle'),
    selectedAgent: shallowRef<ChatAgentId>('claude'),
  }
}

async function mountTransport(intervalMs?: number): Promise<Harness> {
  const state = transportState()
  const sessionKey = shallowRef('session')
  const hours = shallowRef(720)
  const HarnessComponent = defineComponent({
    setup() {
      const transport = useChatTransport({
        project: () => '/repo',
        sessionKey: () => sessionKey.value,
        hours: () => hours.value,
        state,
        ...(intervalMs === undefined ? {} : { intervalMs }),
      })
      transport.resume()
      return { transport }
    },
    template: '<div />',
  })
  component = await mountSuspended(HarnessComponent)
  await flushPromises()
  const transport = (component.vm as unknown as { transport: UseChatTransportReturn }).transport
  return { transport, state, sessionKey, hours }
}

afterEach(() => {
  component?.unmount()
  component = null
  vi.useRealTimers()
})

describe('useChatTransport', () => {
  it('advances the cursor, appends events, and adopts the reported agent', async () => {
    const fetch = mockLiveApi(runNode(), {
      chat: url => chatEventsResponse(urlParam(url, 'since') === '0'
        ? {
            events: [
              { kind: 'user', text: 'Why?' },
              { kind: 'assistant-chunk', agent: 'codex', text: 'Because.' },
            ],
            next: 2,
            revision: 1,
            reset: true,
            status: 'busy',
            agent: 'codex',
          }
        : {
            events: [{ kind: 'turn-end', stopReason: 'end_turn' }],
            next: 3,
            revision: 1,
            status: 'idle',
          }),
    })

    const { transport, state } = await mountTransport()

    expect(fetch).toHaveBeenCalledWith(
      '/api/chat?project=%2Frepo&key=session&since=0&revision=0&hours=720',
      { signal: expect.any(AbortSignal) },
    )
    expect(state.events.value).toHaveLength(2)
    expect(state.since.value).toBe(2)
    expect(state.status.value).toBe('busy')
    expect(state.selectedAgent.value).toBe('codex')

    await transport.poll()
    await flushPromises()

    expect(state.events.value.map(event => event.kind)).toEqual([
      'user',
      'assistant-chunk',
      'turn-end',
    ])
    expect(state.since.value).toBe(3)
    expect(state.status.value).toBe('idle')
  })

  it('replaces the log when the server responds with a reset', async () => {
    let poll = 0
    mockLiveApi(runNode(), {
      chat: () => {
        poll += 1
        return poll === 1
          ? chatEventsResponse({ events: [{ kind: 'user', text: 'old' }], next: 1, revision: 1 })
          : chatEventsResponse({
              events: [{ kind: 'user', text: 'rebuilt' }],
              next: 1,
              revision: 2,
              reset: true,
            })
      },
    })

    const { transport, state } = await mountTransport()
    expect(state.events.value).toEqual([{ kind: 'user', text: 'old' }])

    await transport.poll()
    await flushPromises()

    expect(state.events.value).toEqual([{ kind: 'user', text: 'rebuilt' }])
    expect(state.revision.value).toBe(2)
  })

  it('posts a send action with the selected agent and polls the reply', async () => {
    const fetch = mockLiveApi(runNode(), {
      chatAction: () => chatActionResponse({ status: 'starting' }),
    })

    const { transport, state } = await mountTransport()
    state.selectedAgent.value = 'copilot'
    const accepted = await transport.send('What changed?')
    await flushPromises()

    expect(accepted).toBe(true)
    expect(state.status.value).toBe('idle')
    const post = fetch.mock.calls.find(([, options]) => options?.method === 'POST')
    expect(post?.[0]).toBe('/api/chat?hours=720')
    expect(post?.[1]?.body).toEqual({
      action: 'send',
      project: '/repo',
      key: 'session',
      agent: 'copilot',
      text: 'What changed?',
    })
    expect(fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/chat?project'))).toHaveLength(2)
  })

  it('clears the local log only when a reset action is accepted', async () => {
    let accept = false
    mockLiveApi(runNode(), {
      chat: () => chatEventsResponse({ events: [{ kind: 'user', text: 'kept' }], next: 1, revision: 1 }),
      chatAction: () => {
        if (!accept) throw new Error('agent busy')
        return chatActionResponse({ status: 'idle' })
      },
    })

    const { transport, state } = await mountTransport()
    expect(await transport.reset()).toBe(false)
    expect(transport.requestError.value).toBe('agent busy')
    expect(state.events.value).toHaveLength(1)

    accept = true
    expect(await transport.reset()).toBe(true)
    expect(state.events.value).toEqual([])
    expect(state.since.value).toBe(0)
    expect(transport.requestError.value).toBe('')
  })

  it('drops a stale poll response after the session key changes mid-flight', async () => {
    const stale = deferred<ChatEventsResponse>()
    mockLiveApi(runNode(), {
      chat: (url) => {
        if (urlParam(url, 'key') === 'session') return stale.promise
        return chatEventsResponse({ events: [{ kind: 'user', text: 'fresh' }], next: 1, revision: 1 })
      },
    })

    const { state, sessionKey } = await mountTransport()
    sessionKey.value = 'other'
    await flushPromises()

    stale.resolve(chatEventsResponse({ events: [{ kind: 'user', text: 'stale' }], next: 9, revision: 9 }))
    await flushPromises()

    expect(state.events.value).toEqual([{ kind: 'user', text: 'fresh' }])
    expect(state.since.value).toBe(1)
  })

  it('resets the cursor and log when the hour range changes', async () => {
    const fetch = mockLiveApi(runNode(), {
      chat: () => chatEventsResponse({ events: [{ kind: 'user', text: 'hi' }], next: 1, revision: 1 }),
    })

    const { state, hours } = await mountTransport()
    expect(state.since.value).toBe(1)

    hours.value = 24
    await flushPromises()

    expect(fetch).toHaveBeenCalledWith(
      '/api/chat?project=%2Frepo&key=session&since=0&revision=0&hours=24',
      { signal: expect.any(AbortSignal) },
    )
    expect(state.events.value).toEqual([{ kind: 'user', text: 'hi' }])
  })

  it('pause aborts the in-flight poll and stops the loop until resume', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = []
    const pending = deferred<ChatEventsResponse>()
    const fetch = mockLiveApi(runNode(), {
      chat: (_url, options) => {
        signals.push(options!.signal!)
        return pending.promise
      },
    })

    const { transport } = await mountTransport()
    expect(signals).toHaveLength(1)

    transport.pause()
    expect(signals[0]!.aborted).toBe(true)

    await vi.advanceTimersByTimeAsync(4_000)
    await flushPromises()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(transport.requestError.value).toBe('')

    transport.resume()
    await flushPromises()
    expect(signals).toHaveLength(2)
  })

  it('aborts actions on unmount and ignores their late settlement', async () => {
    const action = deferred<never>()
    const signals: AbortSignal[] = []
    const fetch = mockLiveApi(runNode(), {
      chatAction: (_url, options) => {
        signals.push(options!.signal!)
        return action.promise
      },
    })

    const { transport } = await mountTransport()
    const sending = transport.send('late')
    await flushPromises()

    component!.unmount()
    component = null
    expect(signals[0]!.aborted).toBe(true)

    action.reject(new DOMException('Aborted', 'AbortError'))
    await expect(sending).resolves.toBe(false)
    expect(transport.requestError.value).toBe('')
    expect(fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/chat?project'))).toHaveLength(1)
  })

  it('surfaces request failures and recovers on the next successful poll', async () => {
    let poll = 0
    mockLiveApi(runNode(), {
      chat: () => {
        poll += 1
        if (poll === 1) throw new Error('agent offline')
        return chatEventsResponse()
      },
    })

    const { transport } = await mountTransport()
    expect(transport.requestError.value).toBe('agent offline')

    await transport.poll()
    await flushPromises()
    expect(transport.requestError.value).toBe('')
  })
})
