import { mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent } from 'vue'
import { describe, expect, it } from 'vitest'
import type { UseChatSessionStateReturn } from '~/composables/useChatSessionState'

async function withChatSessions<T>(setup: () => T): Promise<T> {
  let result!: T
  const Harness = defineComponent({
    setup() {
      result = setup()
      return {}
    },
    template: '<div />',
  })
  const component = await mountSuspended(Harness)
  component.unmount()
  return result
}

describe('useChatSessionState', () => {
  it('shares one state per session across consumers', async () => {
    const { first, second, other } = await withChatSessions(() => {
      const first = useChatSessionState('/repo', 'shared-session')
      first.state.draft = 'Keep me'
      const second = useChatSessionState('/repo', 'shared-session')
      const other = useChatSessionState('/repo', 'other-session')
      return { first, second, other }
    })

    expect(second.state).toBe(first.state)
    expect(second.state.draft).toBe('Keep me')
    expect(other.state.draft).toBe('')
  })

  it('evicts the least recently touched session beyond capacity, keeping touched ones', async () => {
    const capacity = { capacity: 2 }
    const sessions: Record<string, UseChatSessionStateReturn> = {}
    await withChatSessions(() => {
      sessions.a = useChatSessionState('/evict', 'a', capacity)
      sessions.a.state.draft = 'Draft A'
      sessions.b = useChatSessionState('/evict', 'b', capacity)
      sessions.b.state.draft = 'Draft B'
      sessions.a.touch()
      sessions.c = useChatSessionState('/evict', 'c', capacity)
      sessions.aAgain = useChatSessionState('/evict', 'a', capacity)
      sessions.bAgain = useChatSessionState('/evict', 'b', capacity)
      return sessions
    })

    expect(sessions.aAgain!.state).toBe(sessions.a!.state)
    expect(sessions.aAgain!.state.draft).toBe('Draft A')
    expect(sessions.bAgain!.state).not.toBe(sessions.b!.state)
    expect(sessions.bAgain!.state.draft).toBe('')
  })

  it('starts a new session with idle defaults', async () => {
    const { state } = await withChatSessions(() =>
      useChatSessionState('/repo', 'fresh-session'))

    expect(state).toMatchObject({
      events: [],
      since: 0,
      revision: 0,
      status: 'idle',
      selectedAgent: 'claude',
      draft: '',
    })
  })
})
