import type * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import type { ChatEventWire, ChatStatusWire } from '#shared/schemas/api'
import type { ChatAgentId } from '#shared/types/chat'
import type { ChatConversation } from '~/atoms/chat'
import type { Feed } from '~/atoms/feed'
import { type Problem, toFeedView } from './feed-view'

/** Who answers when nobody — neither the user nor a running turn — has said. */
export const DEFAULT_CHAT_AGENT: ChatAgentId = 'claude'

/** One conversation as the panel renders it. */
export interface ChatView {
  readonly events: ReadonlyArray<ChatEventWire>
  readonly status: ChatStatusWire
  /** Agent the running conversation belongs to, if it has started. */
  readonly agent: ChatAgentId | null
  /** Outcome of the most recent poll, or null if it worked. */
  readonly error: Problem | null
}

const EMPTY: ChatView = { events: [], status: 'idle', agent: null, error: null }

/**
 * Projects the chat poll's `AsyncResult` into what the template reads.
 *
 * "Loading" is deliberately not a state here. A chat that has not answered yet
 * and a chat whose first poll is still in flight look the same on screen — the
 * empty-conversation prompt — and giving the panel a spinner it never had would
 * make every session switch flash.
 */
export const toChatView = <Failure>(
  result: AsyncResult.AsyncResult<Feed<ChatConversation>, Failure>,
): ChatView => {
  const view = toFeedView(result)
  switch (view.tag) {
    case 'loading':
      return EMPTY
    case 'ready':
      return { ...view.value, error: null }
    case 'stale':
      return { ...view.value, error: { message: view.message, remedy: view.remedy } }
    case 'error':
      return { ...EMPTY, error: { message: view.message, remedy: view.remedy } }
  }
}

/**
 * Which agent the panel shows as selected.
 *
 * The running conversation wins over the user's pick, because it is the process
 * that is actually replying — clicking Codex halfway through a Claude turn
 * cannot retarget it, and showing Codex as selected would say it had. Once the
 * conversation is reset the server reports no agent again and the pick applies.
 */
export const chatAgent = (
  conversation: ChatAgentId | null,
  chosen: ChatAgentId | null,
): ChatAgentId => conversation ?? chosen ?? DEFAULT_CHAT_AGENT
