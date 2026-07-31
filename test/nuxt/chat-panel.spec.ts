import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ChatPanel from '~/components/ChatPanel.vue'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('ChatPanel', () => {
  it('renders streamed ACP events and sends a follow-up with the selected agent', async () => {
    const fetch = vi.fn().mockImplementation((url: string, options?: { method?: string }) => {
      if (options?.method === 'POST') return Promise.resolve({ status: 'starting' })
      const initial = url.includes('since=0')
      return Promise.resolve({
        events: initial
          ? [
              { kind: 'user', text: 'Why did the tests fail?' },
              { kind: 'assistant-chunk', agent: 'copilot', text: 'The setup ' },
              { kind: 'assistant-chunk', agent: 'copilot', text: '**failed**.' },
              { kind: 'turn-end', stopReason: 'end_turn' },
            ]
          : [],
        next: 4,
        revision: 1,
        reset: initial,
        status: 'idle',
        agent: 'copilot',
      })
    })
    vi.stubGlobal('$fetch', fetch)

    const component = await mountSuspended(ChatPanel, {
      props: { project: '/repo', sessionKey: 'codex:session', hours: 720 },
    })
    await flushPromises()

    expect(component.get('.chat-message.user').text()).toContain('Why did the tests fail?')
    await vi.waitFor(() => {
      expect(component.get('.chat-message.assistant strong').text()).toBe('failed')
    })
    expect(component.get('.chat-message.assistant header').text()).toContain('Copilot')
    expect(component.findAll('[aria-label="Answering agent"] button').map(button => button.attributes('aria-pressed'))).toEqual([
      'false',
      'false',
      'true',
    ])

    await component.get('textarea').setValue('What should I change?')
    await component.get('form').trigger('submit')
    await flushPromises()

    const post = fetch.mock.calls.find(([, options]) => options?.method === 'POST')
    expect(post?.[0]).toBe('/api/chat?hours=720')
    expect(post?.[1]?.body).toEqual({
      action: 'send',
      project: '/repo',
      key: 'codex:session',
      agent: 'copilot',
      text: 'What should I change?',
    })
    expect(post?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(component.get('textarea').element).toHaveProperty('value', '')
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/chat?project=%2Frepo&key=codex%3Asession&since=0&revision=0&hours=720'),
      { signal: expect.any(AbortSignal) },
    )

    component.unmount()
  })

  it('releases conversation UI state when KeepAlive evicts the session', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({
      events: [],
      next: 0,
      revision: 0,
      reset: false,
      status: 'idle',
    }))
    const Harness = defineComponent({
      components: { ChatPanel },
      setup() {
        return { sessionKey: ref('session-0') }
      },
      template: `
        <KeepAlive :max="10">
          <ChatPanel
            :key="sessionKey"
            project="/repo"
            :session-key="sessionKey"
            :hours="720"
          />
        </KeepAlive>
      `,
    })
    const component = await mountSuspended(Harness)
    await flushPromises()
    await component.get('textarea').setValue('bounded draft')

    for (let index = 1; index <= 10; index += 1) {
      component.vm.sessionKey = `session-${index}`
      await nextTick()
      await flushPromises()
    }
    component.vm.sessionKey = 'session-0'
    await nextTick()
    await flushPromises()

    expect(component.get('textarea').element).toHaveProperty('value', '')

    component.unmount()
  })

  it('aborts unresolved polls as cached sessions deactivate and evict', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = []
    vi.stubGlobal('$fetch', vi.fn().mockImplementation((_url: string, options?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        if (!options?.signal) return
        signals.push(options.signal)
        options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        })
      }),
    ))
    const Harness = defineComponent({
      components: { ChatPanel },
      setup() {
        return { sessionKey: ref('session-0') }
      },
      template: `
        <KeepAlive :max="10">
          <ChatPanel
            :key="sessionKey"
            project="/repo"
            :session-key="sessionKey"
            :hours="720"
          />
        </KeepAlive>
      `,
    })
    const component = await mountSuspended(Harness)
    await flushPromises()

    for (let index = 1; index <= 10; index += 1) {
      component.vm.sessionKey = `session-${index}`
      await nextTick()
      await flushPromises()
    }

    expect(signals).toHaveLength(11)
    expect(signals.filter(signal => signal.aborted)).toHaveLength(10)
    expect(signals.at(-1)?.aborted).toBe(false)

    component.unmount()
    await flushPromises()
    expect(signals.every(signal => signal.aborted)).toBe(true)
  })

  it('does not restart polling when an action settles after teardown', async () => {
    type ResolveAction = (response: { status: 'starting' }) => void
    const actionRequests: Array<{ signal: AbortSignal, resolve: ResolveAction }> = []
    const fetch = vi.fn().mockImplementation((url: string, options?: {
      method?: string
      signal?: AbortSignal
    }) => {
      if (options?.method === 'POST') {
        return new Promise<{ status: 'starting' }>((resolve) => {
          actionRequests.push({ signal: options.signal!, resolve })
        })
      }
      return Promise.resolve({
        events: [],
        next: 0,
        revision: 0,
        reset: false,
        status: 'idle',
      })
    })
    vi.stubGlobal('$fetch', fetch)
    const Harness = defineComponent({
      components: { ChatPanel },
      setup() {
        return { sessionKey: ref('session-0') }
      },
      template: `
        <KeepAlive :max="10">
          <ChatPanel
            :key="sessionKey"
            project="/repo"
            :session-key="sessionKey"
            :hours="720"
          />
        </KeepAlive>
      `,
    })
    const component = await mountSuspended(Harness)
    await flushPromises()
    await component.get('textarea').setValue('first action')
    await component.get('form').trigger('submit')
    await flushPromises()

    component.vm.sessionKey = 'session-1'
    await nextTick()
    await flushPromises()
    actionRequests[0]!.resolve({ status: 'starting' })
    await flushPromises()
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('key=session-0'))).toHaveLength(1)

    await component.get('textarea').setValue('second action')
    await component.get('form').trigger('submit')
    await flushPromises()
    component.unmount()

    expect(actionRequests[1]!.signal.aborted).toBe(true)
    actionRequests[1]!.resolve({ status: 'starting' })
    await flushPromises()
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('key=session-1'))).toHaveLength(1)
  })
})
