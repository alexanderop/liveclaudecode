import type { ChatAgentId, ChatEvent, ChatStatus } from '#shared/types/chat'
import type { LruEntry } from '~/utils/lru-list'
import { ensureLruEntry, touchLruEntry } from '~/utils/lru-list'

export interface ChatSessionState {
  events: ChatEvent[]
  since: number
  revision: number
  status: ChatStatus
  selectedAgent: ChatAgentId
  draft: string
}

export interface UseChatSessionStateOptions {
  /**
   * Maximum number of chat sessions kept in memory; the least recently
   * touched session is evicted first.
   *
   * @default 10
   */
  capacity?: number
}

export interface UseChatSessionStateReturn {
  /** Reactive chat state for this session; mutate its fields directly. */
  readonly state: ChatSessionState
  /** Mark the session as most recently used so it is evicted last. */
  readonly touch: () => void
}

const CHAT_SESSION_CACHE_KEY = 'liveclaudecode:ask-sessions'

function initialChatSessionState(): ChatSessionState {
  return {
    events: [],
    since: 0,
    revision: 0,
    status: 'idle',
    selectedAgent: 'claude',
    draft: '',
  }
}

/**
 * Per-session chat state (draft, transcript cursor, selected agent) that
 * survives switching between sessions, kept in an app-wide LRU so long
 * dashboards don't accumulate unbounded chat buffers.
 */
export function useChatSessionState(
  project: string,
  sessionKey: string,
  options: UseChatSessionStateOptions = {},
): UseChatSessionStateReturn {
  const { capacity = 10 } = options
  const identity = `${project}\0${sessionKey}`
  const entries = useState<LruEntry<ChatSessionState>[]>(CHAT_SESSION_CACHE_KEY, () => [])
  const state = ensureLruEntry(entries.value, identity, initialChatSessionState)

  function touch(): void {
    touchLruEntry(entries.value, identity, state, capacity)
  }

  touch()
  return { state, touch }
}
