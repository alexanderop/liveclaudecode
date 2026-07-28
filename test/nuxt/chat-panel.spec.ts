import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ChatPanel from '~/components/ChatPanel.vue'

afterEach(() => {
  vi.unstubAllGlobals()
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
              { kind: 'assistant-chunk', agent: 'codex', text: 'The setup ' },
              { kind: 'assistant-chunk', agent: 'codex', text: '**failed**.' },
              { kind: 'turn-end', stopReason: 'end_turn' },
            ]
          : [],
        next: 4,
        revision: 1,
        reset: initial,
        status: 'idle',
        agent: 'codex',
      })
    })
    vi.stubGlobal('$fetch', fetch)

    const component = await mountSuspended(ChatPanel, {
      props: { project: '/repo', sessionKey: 'codex:session' },
    })
    await flushPromises()

    expect(component.get('.chat-message.user').text()).toContain('Why did the tests fail?')
    await vi.waitFor(() => {
      expect(component.get('.chat-message.assistant strong').text()).toBe('failed')
    })
    expect(component.findAll('[aria-label="Answering agent"] button').map(button => button.attributes('aria-pressed'))).toEqual([
      'false',
      'true',
    ])

    await component.get('textarea').setValue('What should I change?')
    await component.get('form').trigger('submit')
    await flushPromises()

    const post = fetch.mock.calls.find(([, options]) => options?.method === 'POST')
    expect(post?.[1]?.body).toEqual({
      action: 'send',
      project: '/repo',
      key: 'codex:session',
      agent: 'codex',
      text: 'What should I change?',
    })
    expect(component.get('textarea').element).toHaveProperty('value', '')

    component.unmount()
  })
})
