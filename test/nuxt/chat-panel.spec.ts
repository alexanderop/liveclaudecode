import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ChatPanel from '~/components/ChatPanel.vue'
import type { ChatActionResponse, ChatEventsResponse } from '#shared/types/chat'
import { chatActionResponse, chatEventsResponse } from '../fixtures/chat'
import { deferred } from '../fixtures/deferred'
import type { Deferred } from '../fixtures/deferred'
import { mockLiveApi } from '../fixtures/live-api'
import { runNode } from '../fixtures/runs'

let component: VueWrapper | null = null

afterEach(() => {
  component?.unmount()
  component = null
})

/** KeepAlive harness cycling ChatPanel instances by session key. */
const KeepAliveHarness = defineComponent({
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

describe('ChatPanel', () => {
  it('renders streamed ACP events and sends a follow-up with the selected agent', async () => {
    const fetch = mockLiveApi(runNode(), {
      chat: (url) => {
        const initial = url.includes('since=0')
        return chatEventsResponse({
          events: initial
            ? [
                { kind: 'user', text: 'Why did the tests fail?' },
                { kind: 'thought-chunk', agent: 'copilot', text: '## Checking\n\nThe `setup` hook.' },
                { kind: 'assistant-chunk', agent: 'copilot', text: 'The setup ' },
                { kind: 'assistant-chunk', agent: 'copilot', text: '**failed**.' },
                { kind: 'turn-end', stopReason: 'end_turn' },
              ]
            : [],
          next: 5,
          revision: 1,
          reset: initial,
          agent: 'copilot',
        })
      },
      chatAction: () => chatActionResponse(),
    })

    const wrapper = component = await mountSuspended(ChatPanel, {
      props: { project: '/repo', sessionKey: 'codex:session', hours: 720 },
    })
    await flushPromises()

    await vi.waitFor(() => {
      expect(wrapper.get('.chat-message.user .markdown-body').text()).toContain('Why did the tests fail?')
      expect(wrapper.get('.chat-thought .markdown-body h2').text()).toBe('Checking')
      expect(wrapper.get('.chat-thought .markdown-body code').text()).toBe('setup')
      expect(wrapper.get('.chat-message.assistant strong').text()).toBe('failed')
    })
    expect(wrapper.get('.chat-message.assistant header').text()).toContain('Copilot')
    expect(wrapper.findAll('[aria-label="Answering agent"] button').map(button => button.attributes('aria-pressed'))).toEqual([
      'false',
      'false',
      'true',
    ])

    await wrapper.get('textarea').setValue('What should I change?')
    await wrapper.get('form').trigger('submit')
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
    expect(wrapper.get('textarea').element).toHaveProperty('value', '')
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/chat?project=%2Frepo&key=codex%3Asession&since=0&revision=0&hours=720'),
      { signal: expect.any(AbortSignal) },
    )
  })

  it('names the conversation after the subagent when scoped to one', async () => {
    const fetch = mockLiveApi(runNode())
    const wrapper = component = await mountSuspended(ChatPanel, {
      props: {
        project: '/repo',
        sessionKey: 'session/agent-a',
        hours: 720,
        scope: 'subagent' as const,
      },
    })
    await flushPromises()

    expect(wrapper.get('.chat-empty').text()).toContain('Ask about this subagent')
    expect(wrapper.find('[aria-label="Question about this subagent"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="Question about this session"]').exists()).toBe(false)
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/chat?project=%2Frepo&key=session%2Fagent-a&since=0&revision=0&hours=720'),
      { signal: expect.any(AbortSignal) },
    )
  })

  it('releases conversation UI state when KeepAlive evicts the session', async () => {
    mockLiveApi(runNode())
    const wrapper = component = await mountSuspended(KeepAliveHarness)
    await flushPromises()
    await wrapper.get('textarea').setValue('bounded draft')

    for (let index = 1; index <= 10; index += 1) {
      wrapper.vm.sessionKey = `session-${index}`
      await nextTick()
      await flushPromises()
    }
    wrapper.vm.sessionKey = 'session-0'
    await nextTick()
    await flushPromises()

    expect(wrapper.get('textarea').element).toHaveProperty('value', '')
  })

  it('preserves a draft when the Ask cache owner closes and reopens', async () => {
    mockLiveApi(runNode())
    const Harness = defineComponent({
      components: { ChatPanel },
      setup() {
        return { open: ref(true) }
      },
      template: `
        <template v-if="open">
          <KeepAlive :max="10">
            <ChatPanel
              key="close-reopen"
              project="/close-reopen"
              session-key="close-reopen"
              :hours="720"
            />
          </KeepAlive>
        </template>
      `,
    })
    const wrapper = component = await mountSuspended(Harness)
    await flushPromises()
    await wrapper.get('textarea').setValue('draft survives close')

    wrapper.vm.open = false
    await nextTick()
    wrapper.vm.open = true
    await nextTick()
    await flushPromises()

    expect(wrapper.get('textarea').element).toHaveProperty('value', 'draft survives close')
  })

  it('aborts unresolved polls as cached sessions deactivate and evict', async () => {
    const signals: AbortSignal[] = []
    mockLiveApi(runNode(), {
      chat: (_url, options) => {
        // A poll that only ever settles by being aborted.
        const poll = deferred<ChatEventsResponse>()
        const signal = options?.signal
        if (!signal) return poll.promise
        signals.push(signal)
        signal.addEventListener(
          'abort',
          () => poll.reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        )
        return poll.promise
      },
    })
    const wrapper = component = await mountSuspended(KeepAliveHarness)
    await flushPromises()

    for (let index = 1; index <= 10; index += 1) {
      wrapper.vm.sessionKey = `session-${index}`
      await nextTick()
      await flushPromises()
    }

    expect(signals).toHaveLength(11)
    expect(signals.filter(signal => signal.aborted)).toHaveLength(10)
    expect(signals.at(-1)?.aborted).toBe(false)

    wrapper.unmount()
    component = null
    await flushPromises()
    expect(signals.every(signal => signal.aborted)).toBe(true)
  })

  it('does not restart polling when an action settles after teardown', async () => {
    const actionRequests: Array<{ signal: AbortSignal, action: Deferred<ChatActionResponse> }> = []
    const fetch = mockLiveApi(runNode(), {
      chatAction: (_url, options) => {
        const action = deferred<ChatActionResponse>()
        actionRequests.push({ signal: options!.signal!, action })
        return action.promise
      },
    })
    const wrapper = component = await mountSuspended(KeepAliveHarness)
    await flushPromises()
    await wrapper.get('textarea').setValue('first action')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    wrapper.vm.sessionKey = 'session-1'
    await nextTick()
    await flushPromises()
    actionRequests[0]!.action.resolve(chatActionResponse())
    await flushPromises()
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('key=session-0'))).toHaveLength(1)

    await wrapper.get('textarea').setValue('second action')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    wrapper.unmount()
    component = null

    expect(actionRequests[1]!.signal.aborted).toBe(true)
    actionRequests[1]!.action.resolve(chatActionResponse())
    await flushPromises()
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('key=session-1'))).toHaveLength(1)
  })
})
