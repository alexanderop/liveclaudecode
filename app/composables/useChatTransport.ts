import type { Ref, ShallowRef } from 'vue'
import type {
  ChatAction,
  ChatAgentId,
  ChatEvent,
  ChatEventsResponse,
  ChatStatus,
} from '#shared/types/chat'
import { createLatestRequestGate } from '~/utils/latest-request-gate'

/**
 * The per-session chat state the transport reads and advances. Usually the
 * refs of a `useChatSessionState` entry so the log survives KeepAlive swaps.
 */
export interface ChatTransportState {
  /** Append-only chat event log. */
  readonly events: Ref<ChatEvent[]>
  /** Cursor of the next event to request. */
  readonly since: Ref<number>
  /** Server log revision; a mismatch makes the server send a reset. */
  readonly revision: Ref<number>
  /** Lifecycle of the server-side chat agent. */
  readonly status: Ref<ChatStatus>
  /** Agent that answers `send`; updated when the server reports one. */
  readonly selectedAgent: Ref<ChatAgentId>
}

export interface UseChatTransportOptions {
  /** Project of the observed session; empty pauses polling. */
  readonly project: () => string
  /** Key of the observed session; empty pauses polling. */
  readonly sessionKey: () => string
  /** Active time-range filter, forwarded to the API. */
  readonly hours: () => number
  /** Chat state the transport polls into and resets. */
  readonly state: ChatTransportState
  /**
   * Poll cadence for chat events while the transport is resumed, in
   * milliseconds.
   *
   * @default 800
   */
  readonly intervalMs?: number
}

export interface UseChatTransportReturn {
  /** True while a send/cancel/reset action is in flight. */
  readonly actionPending: Readonly<ShallowRef<boolean>>
  /** Message of the last failed request; empty once a request succeeds. */
  readonly requestError: Readonly<ShallowRef<string>>
  /** Fetch the next events after the cursor; deduplicates concurrent calls. */
  readonly poll: () => Promise<void>
  /** Ask the selected agent about the session; true when accepted. */
  readonly send: (text: string) => Promise<boolean>
  /** Cancel the current turn. */
  readonly cancel: () => Promise<boolean>
  /** Start a fresh conversation, clearing the local log when accepted. */
  readonly reset: () => Promise<boolean>
  /** Start the poll loop, e.g. on mount or KeepAlive activation. */
  readonly resume: () => void
  /** Stop the poll loop and abort in-flight polls, e.g. on deactivation. */
  readonly pause: () => void
}

/**
 * Polling transport for the session chat: keeps the event cursor advancing
 * against `/api/chat`, posts send/cancel/reset actions, and guards every
 * response against stale delivery when the session, range, or lifecycle
 * changes mid-flight. Scope disposal aborts everything.
 */
export function useChatTransport(options: UseChatTransportOptions): UseChatTransportReturn {
  const { project, sessionKey, hours, state, intervalMs = 800 } = options

  const actionPending = shallowRef(false)
  const requestError = shallowRef('')
  const pollGate = createLatestRequestGate()
  const actionGate = createLatestRequestGate()
  const pollControllers = new Set<AbortController>()
  const actionControllers = new Set<AbortController>()
  let active = false
  let disposed = false
  const pollLoop = useIntervalFn(() => void poll(), intervalMs, { immediate: false })

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'The local chat agent is unavailable.'
  }

  async function poll(): Promise<void> {
    const requestedProject = project()
    const requestedKey = sessionKey()
    const requestedHours = hours()
    if (disposed || !requestedProject || !requestedKey) return
    const token = pollGate.start(`${requestedProject}\0${requestedKey}\0${requestedHours}`)
    if (!token) return
    const controller = new AbortController()
    pollControllers.add(controller)
    const isCurrent = () => !disposed
      && !controller.signal.aborted
      && pollGate.isCurrent(token)
      && project() === requestedProject
      && sessionKey() === requestedKey
      && hours() === requestedHours
    try {
      const response = await $fetch<ChatEventsResponse>(
        `/api/chat?project=${encodeURIComponent(requestedProject)}&key=${encodeURIComponent(requestedKey)}&since=${state.since.value}&revision=${state.revision.value}&hours=${requestedHours}`,
        { signal: controller.signal },
      )
      if (!isCurrent()) return
      state.since.value = response.next
      state.revision.value = response.revision
      state.status.value = response.status
      if (response.agent) state.selectedAgent.value = response.agent
      state.events.value = response.reset
        ? [...response.events]
        : [...state.events.value, ...response.events]
      requestError.value = ''
    } catch (error) {
      if (!isCurrent()) return
      requestError.value = errorMessage(error)
    } finally {
      pollControllers.delete(controller)
      pollGate.settle(token)
    }
  }

  async function act(action: ChatAction): Promise<boolean> {
    if (disposed) return false
    const token = actionGate.start('action')
    if (!token) return false
    const controller = new AbortController()
    actionControllers.add(controller)
    actionPending.value = true
    requestError.value = ''
    const isCurrent = () => !disposed
      && !controller.signal.aborted
      && actionGate.isCurrent(token)
    try {
      const response = await $fetch<{ status: ChatStatus }>(`/api/chat?hours=${hours()}`, {
        method: 'POST',
        body: action,
        signal: controller.signal,
      })
      if (!isCurrent()) return false
      state.status.value = response.status
      if (active) await poll()
      return true
    } catch (error) {
      if (!isCurrent()) return false
      requestError.value = errorMessage(error)
      return false
    } finally {
      actionControllers.delete(controller)
      actionGate.settle(token)
      actionPending.value = false
    }
  }

  function send(text: string): Promise<boolean> {
    return act({
      action: 'send',
      project: project(),
      key: sessionKey(),
      agent: state.selectedAgent.value,
      text,
    })
  }

  function cancel(): Promise<boolean> {
    return act({ action: 'cancel', project: project(), key: sessionKey() })
  }

  async function reset(): Promise<boolean> {
    const accepted = await act({ action: 'reset', project: project(), key: sessionKey() })
    if (!accepted) return false
    state.events.value = []
    state.since.value = 0
    state.revision.value = 0
    state.status.value = 'idle'
    return true
  }

  function resume(): void {
    if (disposed) return
    active = true
    void poll()
    pollLoop.resume()
  }

  function pause(): void {
    active = false
    pollLoop.pause()
    pollGate.invalidate()
    pollControllers.forEach(controller => controller.abort())
    pollControllers.clear()
  }

  watch(
    () => `${project()}\0${sessionKey()}\0${hours()}`,
    () => {
      pollGate.invalidate()
      state.events.value = []
      state.since.value = 0
      state.revision.value = 0
      state.status.value = 'idle'
      requestError.value = ''
      void poll()
    },
  )

  tryOnScopeDispose(() => {
    disposed = true
    pause()
    actionGate.invalidate()
    actionControllers.forEach(controller => controller.abort())
    actionControllers.clear()
    actionPending.value = false
  })

  return {
    actionPending: shallowReadonly(actionPending),
    requestError: shallowReadonly(requestError),
    poll,
    send,
    cancel,
    reset,
    resume,
    pause,
  }
}
