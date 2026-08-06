import { flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { Effect } from 'effect'
import { defineComponent, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { ApiUnreachable } from '~/api/errors'
import { chatAtoms, chatTarget } from '~/atoms/chat'
import ChatPanel from '~/components/ChatPanel.vue'
import { chatActionResponse, chatEventsResponse } from '../fixtures/chat'
import { mountWithAtoms, type MountedAtoms } from '../fixtures/mount-atoms'
import { recordedCalls, type StubApiHandlers } from '../fixtures/stub-api'

let mounted: MountedAtoms | null = null

afterEach(() => {
  mounted?.wrapper.unmount()
  // The registry owns the poll loop; unmounting only releases the subscription.
  mounted?.registry.dispose()
  mounted = null
})

/** KeepAlive harness cycling ChatPanel instances by session key, as index.vue does. */
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

/** Answers every poll with one message, and accepts every action. */
const answering = (): StubApiHandlers => ({
  chatEvents: query =>
    Effect.succeed(chatEventsResponse({
      events: query.since === 0 ? [{ kind: 'user', text: `about ${query.key}` }] : [],
      next: 1,
      revision: 1,
    })),
  chatAction: () => Effect.succeed(chatActionResponse()),
})

/** Every chat poll the panel issued, oldest first. */
const polls = () => recordedCalls(mounted!.api.calls.chatEvents)
const actions = () => recordedCalls(mounted!.api.calls.chatAction)

/**
 * Makes the running feed take one tick now.
 *
 * The alternative is faking timers around a suspended mount to walk the 800 ms
 * interval, which is both slower and less exact: a pulse and an interval tick
 * enter `pollingFeed` through the same accumulator step, so a gate that turns
 * one away turns the other away too. The unit spec drives the interval itself
 * with `TestClock`.
 */
const pulse = async (sessionKey: string) => {
  mounted!.registry.set(chatAtoms.pulse, chatTarget('/repo', sessionKey))
  await flushPromises()
  await flushPromises()
}

const showSession = async (wrapper: VueWrapper<{ sessionKey: string }>, sessionKey: string) => {
  wrapper.vm.sessionKey = sessionKey
  await nextTick()
  await flushPromises()
  await flushPromises()
}

describe('ChatPanel', () => {
  it('renders streamed ACP events and sends a follow-up with the selected agent', async () => {
    mounted = await mountWithAtoms(ChatPanel, {
      props: { project: '/repo', sessionKey: 'codex:session', hours: 720 },
      api: {
        chatEvents: query =>
          Effect.succeed(chatEventsResponse({
            events: query.since === 0
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
            agent: 'copilot',
          })),
        chatAction: () => Effect.succeed(chatActionResponse()),
      },
    })
    const wrapper = mounted.wrapper
    await flushPromises()

    expect(wrapper.get('.chat-message.user .markdown-body').text()).toContain('Why did the tests fail?')
    expect(wrapper.get('.chat-thought .markdown-body h2').text()).toBe('Checking')
    expect(wrapper.get('.chat-thought .markdown-body code').text()).toBe('setup')
    expect(wrapper.get('.chat-message.assistant strong').text()).toBe('failed')
    expect(wrapper.get('.chat-message.assistant header').text()).toContain('Copilot')
    // The conversation already has an agent, so it is the selected one whatever
    // the user last clicked.
    expect(wrapper.findAll('[aria-label="Answering agent"] button').map(b => b.attributes('aria-pressed')))
      .toEqual(['false', 'false', 'true'])

    await wrapper.get('textarea').setValue('What should I change?')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(actions()).toEqual([{
      action: {
        action: 'send',
        project: '/repo',
        key: 'codex:session',
        agent: 'copilot',
        text: 'What should I change?',
      },
      query: { hours: 720 },
    }])
    expect(wrapper.get('textarea').element).toHaveProperty('value', '')
    // An accepted action pulses the feed, so the question appears without
    // waiting out the interval — and the poll resumes from the cursor.
    expect(polls().map(poll => poll.since)).toEqual([0, 5])
    expect(polls()[0]).toMatchObject({ project: '/repo', key: 'codex:session', revision: 0 })
  })

  it('names the conversation after the subagent when scoped to one', async () => {
    mounted = await mountWithAtoms(ChatPanel, {
      props: {
        project: '/repo',
        sessionKey: 'session/agent-a',
        hours: 720,
        scope: 'subagent' as const,
      },
      api: { chatEvents: () => Effect.succeed(chatEventsResponse()) },
    })
    const wrapper = mounted.wrapper
    await flushPromises()

    expect(wrapper.get('.chat-empty').text()).toContain('Ask about this subagent')
    expect(wrapper.find('[aria-label="Question about this subagent"]').exists()).toBe(true)
    expect(wrapper.find('[aria-label="Question about this session"]').exists()).toBe(false)
    expect(polls()[0]).toMatchObject({ project: '/repo', key: 'session/agent-a' })
  })

  it('keeps a hidden conversation from polling at all', async () => {
    mounted = await mountWithAtoms(KeepAliveHarness, { api: answering() })
    const wrapper = mounted.wrapper as VueWrapper<{ sessionKey: string }>
    await flushPromises()
    expect(polls()).toHaveLength(1)

    await showSession(wrapper, 'session-1')
    const afterSwitch = polls().length
    await pulse('session-0')

    // `<KeepAlive>` moves a deactivated subtree rather than stopping its effect
    // scope, so its atom subscription is still live and would keep polling on
    // its own. Up to ten of them can be cached at once.
    expect(polls()).toHaveLength(afterSwitch)
    expect(polls().filter(poll => poll.key === 'session-0')).toHaveLength(1)
  })

  it('resumes a reopened conversation from where it left off, not from zero', async () => {
    mounted = await mountWithAtoms(KeepAliveHarness, { api: answering() })
    const wrapper = mounted.wrapper as VueWrapper<{ sessionKey: string }>
    await flushPromises()

    await showSession(wrapper, 'session-1')
    await showSession(wrapper, 'session-0')

    // The regression this pins: putting the visibility flag in the family key
    // would make a hidden panel a different atom, so coming back would restart
    // the cursor at 0 and refetch the whole conversation every time.
    const reopened = polls().filter(poll => poll.key === 'session-0')
    expect(reopened.map(poll => poll.since)).toEqual([0, 1])
    expect(reopened.map(poll => poll.revision)).toEqual([0, 1])
  })

  it('holds two conversations at once without mixing them', async () => {
    const Both = defineComponent({
      components: { ChatPanel },
      template: `
        <div>
          <ChatPanel project="/repo" session-key="root" :hours="720" />
          <ChatPanel project="/repo" session-key="root/agent-a" :hours="720" scope="subagent" />
        </div>
      `,
    })
    mounted = await mountWithAtoms(Both, { api: answering() })
    await flushPromises()

    // The session panel and the inspector's Ask tab are two mount sites with
    // independent `project`/`sessionKey` props, and they stay props.
    const panels = mounted.wrapper.findAll('.chat-panel')
    expect(panels[0]!.text()).toContain('about root')
    expect(panels[1]!.text()).toContain('about root/agent-a')
    expect(panels[0]!.text()).not.toContain('about root/agent-a')
    expect(polls().map(poll => poll.key).sort()).toEqual(['root', 'root/agent-a'])
  })

  it('preserves a draft when the Ask panel closes and reopens', async () => {
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
    mounted = await mountWithAtoms(Harness, { api: answering() })
    const wrapper = mounted.wrapper as VueWrapper<{ open: boolean }>
    await flushPromises()
    await wrapper.get('textarea').setValue('draft survives close')

    wrapper.vm.open = false
    await nextTick()
    wrapper.vm.open = true
    await nextTick()
    await flushPromises()

    // The draft outlives its panel by the atoms' idle TTL; that it eventually
    // expires is asserted in `test/unit/atoms/chat-lifetime.spec.ts`.
    expect(wrapper.get('textarea').element).toHaveProperty('value', 'draft survives close')
  })

  it('says the chat server could not be reached, and why', async () => {
    mounted = await mountWithAtoms(ChatPanel, {
      props: { project: '/repo', sessionKey: 'codex:session', hours: 720 },
      api: {
        chatEvents: () =>
          Effect.fail(new ApiUnreachable({ url: '/api/chat', detail: 'connect refused' })),
      },
    })
    await flushPromises()

    const alert = mounted.wrapper.get('.chat-request-error')
    expect(alert.text()).toContain('/api/chat is unreachable: connect refused')
    expect(alert.text()).toContain('recovers on its own')
  })

  it('reports a refused action and keeps the question in the composer', async () => {
    mounted = await mountWithAtoms(ChatPanel, {
      props: { project: '/repo', sessionKey: 'codex:session', hours: 720 },
      api: {
        ...answering(),
        chatAction: () =>
          Effect.fail(new ApiUnreachable({ url: '/api/chat', detail: 'connect refused' })),
      },
    })
    const wrapper = mounted.wrapper
    await flushPromises()

    await wrapper.get('textarea').setValue('What should I change?')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    // Losing what was typed because the agent was not running would be the
    // worst possible moment to lose it.
    expect(wrapper.get('textarea').element).toHaveProperty('value', 'What should I change?')
    expect(wrapper.get('.chat-request-error').text()).toContain('unreachable')
  })
})
