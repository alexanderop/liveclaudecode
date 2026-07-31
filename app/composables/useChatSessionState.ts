import type { ChatAgentId, ChatEvent, ChatStatus } from '#shared/types/chat'

export interface ChatSessionState {
  events: ChatEvent[]
  since: number
  revision: number
  status: ChatStatus
  selectedAgent: ChatAgentId
  draft: string
}

interface ChatSessionEntry {
  identity: string
  state: ChatSessionState
}

const CHAT_SESSION_CAPACITY = 10
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

export function useChatSessionState(project: string, sessionKey: string): {
  readonly state: ChatSessionState
  readonly touch: () => void
} {
  const identity = `${project}\0${sessionKey}`
  const entries = useState<ChatSessionEntry[]>(CHAT_SESSION_CACHE_KEY, () => [])
  let entry = entries.value.find(entry => entry.identity === identity)
  if (!entry) {
    entries.value.push({ identity, state: initialChatSessionState() })
    entry = entries.value.at(-1)!
  }
  const state = entry.state

  function touch(): void {
    const index = entries.value.findIndex(entry => entry.identity === identity)
    if (index >= 0) entries.value.splice(index, 1)
    entries.value.push({ identity, state })
    if (entries.value.length > CHAT_SESSION_CAPACITY) entries.value.shift()
  }

  touch()
  return { state, touch }
}
