/**
 * Contracts for the session chat: a local ACP agent (claude-agent-acp,
 * codex-acp, …) answering follow-up questions about an observed session.
 * Plain interfaces only — this file is shared with the client.
 */

export type ChatAgentId = 'claude' | 'codex'

export type ChatStatus = 'idle' | 'starting' | 'busy' | 'error'

/** One entry in a chat's append-only event log, delivered via polling. */
export type ChatEvent =
  | { kind: 'user', text: string }
  | { kind: 'assistant-chunk', agent: ChatAgentId, text: string }
  | { kind: 'thought-chunk', agent: ChatAgentId, text: string }
  | { kind: 'tool', toolCallId: string, title: string, toolKind: string, status: string }
  | { kind: 'turn-end', stopReason: string }
  | { kind: 'error', message: string }

export interface ChatEventsResponse {
  /** Events at index `since` and later; append client-side. */
  events: ChatEvent[]
  /** Cursor to pass as `since` on the next poll. */
  next: number
  /** Identifies the current chat log; changes when the chat is reset. */
  revision: number
  /** True when `events` replaces the client's log instead of extending it. */
  reset: boolean
  status: ChatStatus
  /** Agent answering this chat, absent until the first message is sent. */
  agent: ChatAgentId | null
}

export type ChatAction =
  | { action: 'send', project: string, key: string, agent: ChatAgentId, text: string }
  | { action: 'cancel', project: string, key: string }
  | { action: 'reset', project: string, key: string }

export interface ChatActionResponse {
  status: ChatStatus
}
