import { assert, describe, it } from '@effect/vitest'
import { Cause } from 'effect'
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import { ApiUnreachable } from '~/api/errors'
import type { ChatConversation } from '~/atoms/chat'
import type { Feed } from '~/atoms/feed'
import { chatAgent, toChatView } from '~/utils/chat-view'

const offline = new ApiUnreachable({ url: '/api/chat', detail: 'connection refused' })

const conversation: ChatConversation = {
  events: [{ kind: 'user', text: 'why did the tests fail?' }],
  status: 'busy',
  agent: 'codex',
}

const feed = (
  value: ChatConversation | null,
  error: ApiUnreachable | null = null,
): AsyncResult.AsyncResult<Feed<ChatConversation>, never> =>
  AsyncResult.success<Feed<ChatConversation>, never>({ value, error }, { waiting: true })

describe('toChatView', () => {
  it('shows an empty, idle conversation before the first poll answers', () => {
    // Deliberately not a loading state: a chat nobody has asked anything yet and
    // a chat whose first poll is in flight look the same, and a spinner between
    // them would flash on every session switch.
    assert.deepStrictEqual(toChatView(AsyncResult.initial<Feed<ChatConversation>, never>()), {
      events: [],
      status: 'idle',
      agent: null,
      error: null,
    })
  })

  it('shows the log, the status, and the agent the server reported', () => {
    assert.deepStrictEqual(toChatView(feed(conversation)), { ...conversation, error: null })
  })

  it('keeps the conversation on screen when a poll fails, and says why', () => {
    assert.deepStrictEqual(toChatView(feed(conversation, offline)), {
      ...conversation,
      error: { message: offline.message, remedy: offline.remedy },
    })
  })

  it('reports the failure alone when no poll has ever succeeded', () => {
    assert.deepStrictEqual(toChatView(feed(null, offline)), {
      events: [],
      status: 'idle',
      agent: null,
      error: { message: offline.message, remedy: offline.remedy },
    })
  })

  it('reports a dead stream rather than rendering an empty chat', () => {
    const dead = AsyncResult.failure<Feed<ChatConversation>, never>(Cause.die(new Error('boom')))
    assert.deepStrictEqual(toChatView(dead).error, {
      message: 'boom',
      remedy: 'Reload the page. If it happens again, check the server output.',
    })
  })
})

describe('chatAgent', () => {
  it('answers with the agent already running the conversation', () => {
    // Clicking Codex halfway through a Claude turn cannot retarget it, and
    // showing Codex as selected would claim it had.
    assert.strictEqual(chatAgent('claude', 'codex'), 'claude')
  })

  it('answers with the user\'s pick once the conversation has been reset', () => {
    assert.strictEqual(chatAgent(null, 'codex'), 'codex')
  })

  it('defaults to Claude when nobody has chosen', () => {
    assert.strictEqual(chatAgent(null, null), 'claude')
  })
})
