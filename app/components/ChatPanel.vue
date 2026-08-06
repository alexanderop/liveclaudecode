<script setup lang="ts">
import { useAtomSet, useAtomValue } from '@effect/atom-vue'
import type { ChatAction, ChatAgentId } from '#shared/types/chat'
import type { ChatTarget } from '~/atoms/chat'
import { chatAtoms, chatTarget } from '~/atoms/chat'

const props = defineProps<{
  project: string
  sessionKey: string
  hours: number
  /**
   * What the conversation covers. This only picks the copy and accessible
   * names; the transport and the state cache are keyed by project and
   * session key either way.
   *
   * @default 'session'
   */
  scope?: 'session' | 'subagent'
}>()

const subagentScope = computed(() => props.scope === 'subagent')

type ChatRow =
  | { kind: 'user' | 'error', text: string }
  | { kind: 'assistant' | 'thought', agent: ChatAgentId, text: string }
  | { kind: 'tool', toolCallId: string, title: string, toolKind: string, status: string }
  | { kind: 'turn-end', stopReason: string }

const agents: ReadonlyArray<{ id: ChatAgentId, label: string }> = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'copilot', label: 'Copilot' },
]
const agentLabels: Readonly<Record<ChatAgentId, string>> = Object.fromEntries(
  agents.map(agent => [agent.id, agent.label]),
) as Record<ChatAgentId, string>

// Both mount sites re-`:key` the panel when the conversation changes, so these
// props are fixed for the lifetime of one instance. The thunks are reactive
// anyway — that is the contract of the binding, not an assumption about here.
const target = computed(() => chatTarget(props.project, props.sessionKey))

const setActive = useAtomSet(() => chatAtoms.active)
const pollNow = useAtomSet(() => chatAtoms.pulse)

/**
 * Whether this panel is on screen.
 *
 * `<KeepAlive>` does not stop effect scopes in Vue 3.5 — a deactivated subtree
 * is moved, not suspended, and its atom subscriptions stay live — so a hidden
 * panel would keep polling unless it says otherwise. The count it writes is
 * read per tick from inside the poll loop, which is why deactivating pauses the
 * requests without discarding the cursor: reactivating resumes from the event
 * the panel had already read, instead of refetching the conversation.
 *
 * A count and not a flag: the session panel and the inspector's Ask tab can be
 * showing the same conversation, and either one's deactivation would otherwise
 * stop the other's poll.
 *
 * The guard makes the pair idempotent. The first call is `setup`'s, `onActivated`
 * fires straight after it inside a `<KeepAlive>`, and eviction runs
 * `onDeactivated` and then `onUnmounted`.
 */
let activated: ChatTarget | null = null
let shown = false

function activate(): void {
  if (activated) return
  activated = target.value
  setActive({ target: activated, delta: 1 })
  // Coming back to a panel polls at once rather than waiting out an interval
  // the conversation spent hidden. The first appearance needs no pulse — the
  // feed's stream emits on its first pull — and could not use one anyway: the
  // stream is not listening for pulses until a turn after that first value.
  if (shown) pollNow(activated)
  shown = true
}

function deactivate(): void {
  if (!activated) return
  setActive({ target: activated, delta: -1 })
  activated = null
}

// Before the feed below is subscribed to, and deliberately: subscribing starts
// the stream, whose first tick reads the count above. Announcing the panel from
// `onMounted` instead would let that first tick find nothing on screen and skip,
// so the conversation would take a whole interval to appear.
activate()
onActivated(activate)
onDeactivated(deactivate)
onUnmounted(deactivate)

const conversation = useAtomValue(() => chatAtoms.conversation(target.value))
const draft = useAtomModel(() => chatAtoms.draft(target.value))
const chosenAgent = useAtomValue(() => chatAtoms.agentChoice(target.value))
const chooseAgent = useAtomSet(() => chatAtoms.agentChoice(target.value))
const actionResult = useAtomValue(() => chatAtoms.action(target.value))
const submit = useAtomAction(() => chatAtoms.action(target.value))

const chat = computed(() => toChatView(conversation.value))
const events = computed(() => chat.value.events)
const status = computed(() => chat.value.status)
const selectedAgent = computed(() => chatAgent(chat.value.agent, chosenAgent.value))
const actionPending = computed(() => actionResult.value.waiting)
// A failed poll is the louder problem — it means nothing on screen is current —
// so it wins over a stale action failure underneath it.
const requestError = computed(() => chat.value.error ?? toActionError(actionResult.value))

const busy = computed(() => status.value === 'starting' || status.value === 'busy')
const canSend = computed(() => Boolean(
  props.project
  && props.sessionKey
  && draft.value.trim()
  && !busy.value
  && !actionPending.value,
))
const chatUiStatus = computed<'submitted' | 'streaming' | 'ready' | 'error'>(() => {
  if (status.value === 'starting') return 'submitted'
  if (status.value === 'busy') return 'streaming'
  if (status.value === 'error') return 'error'
  return 'ready'
})

const rows = computed<ChatRow[]>(() => {
  const output: ChatRow[] = []
  for (const event of events.value) {
    if (event.kind === 'assistant-chunk' || event.kind === 'thought-chunk') {
      const kind = event.kind === 'assistant-chunk' ? 'assistant' : 'thought'
      const previous = output.at(-1)
      if (previous?.kind === kind && previous.agent === event.agent) {
        output[output.length - 1] = { ...previous, text: previous.text + event.text }
      } else {
        output.push({ kind, agent: event.agent, text: event.text })
      }
      continue
    }
    if (event.kind === 'user') {
      output.push({ kind: 'user', text: event.text })
      continue
    }
    if (event.kind === 'error') {
      output.push({ kind: 'error', text: event.message })
      continue
    }
    if (event.kind === 'tool') {
      const index = output.findLastIndex(row => row.kind === 'tool' && row.toolCallId === event.toolCallId)
      const previous = output[index]
      if (previous?.kind === 'tool') {
        output[index] = {
          ...previous,
          title: event.title || previous.title,
          toolKind: event.toolKind || previous.toolKind,
          status: event.status || previous.status,
        }
      } else {
        output.push({ ...event })
      }
      continue
    }
    output.push(event)
  }
  return output
})

function rowKey(row: ChatRow, index: number): string {
  return row.kind === 'tool' ? `tool-${row.toolCallId}` : `${row.kind}-${index}`
}

/**
 * Posts one action and, if the server took it, polls straight away.
 *
 * The pulse is what keeps a send from looking laggy: the action changed the
 * server's log — appended the question, or removed the record on a reset — and
 * without it the panel would show that up to a full interval later. It goes
 * into the running stream rather than refreshing the atom, which would rebuild
 * the node and restart the cursor at zero.
 */
async function act(action: ChatAction): Promise<boolean> {
  const accepted = await submit({ action, hours: props.hours })
  if (accepted) pollNow(target.value)
  return accepted
}

async function send(): Promise<void> {
  const text = draft.value.trim()
  if (!canSend.value || !text) return
  const accepted = await act({
    action: 'send',
    project: props.project,
    key: props.sessionKey,
    agent: selectedAgent.value,
    text,
  })
  if (accepted) draft.value = ''
}

async function cancel(): Promise<void> {
  if (!busy.value || actionPending.value) return
  await act({ action: 'cancel', project: props.project, key: props.sessionKey })
}

/**
 * Starts a fresh conversation.
 *
 * Nothing is cleared here. `resetChat` removes the record server-side, so the
 * poll the pulse triggers comes back with `reset: true` and an empty log, and
 * the feed replaces what it was holding. That is the point of giving the poll
 * sole ownership of `events`, `since`, and `revision`: the old code had to
 * clear all three by hand, in order, and only after the POST was accepted.
 */
async function reset(): Promise<void> {
  if (actionPending.value) return
  await act({ action: 'reset', project: props.project, key: props.sessionKey })
}

</script>

<template>
  <div class="chat-panel">
    <div class="chat-agent-bar">
      <div class="segments" role="group" aria-label="Answering agent">
        <UButton
          v-for="agent in agents"
          :key="agent.id"
          type="button"
          color="neutral"
          variant="ghost"
          :class="{ selected: selectedAgent === agent.id }"
          :aria-pressed="selectedAgent === agent.id"
          :disabled="busy"
          @click="chooseAgent(agent.id)"
        >{{ agent.label }}</UButton>
      </div>
      <span class="chat-status" :class="status">
        <span class="status-dot" :class="busy ? 'running' : status === 'error' ? 'failed' : 'completed'" />
        {{ status === 'starting' ? 'Starting agent' : status === 'busy' ? 'Answering' : status === 'error' ? 'Agent error' : 'Ready' }}
      </span>
    </div>

    <UChatMessages
      class="chat-log"
      :aria-label="subagentScope ? 'Subagent chat messages' : 'Session chat messages'"
      :status="chatUiStatus"
      should-auto-scroll
      :should-scroll-to-bottom="true"
    >
      <UEmpty
        v-if="!project || !sessionKey"
        class="chat-empty"
        icon="i-lucide-message-square"
        :title="subagentScope ? 'Select an agent first' : 'Select a session first'"
        :description="subagentScope
          ? 'The local agent needs a subagent transcript to answer questions.'
          : 'The local agent needs a session transcript to answer questions.'"
        variant="naked"
      />
      <UEmpty
        v-else-if="!rows.length && !busy"
        class="chat-empty"
        icon="i-lucide-messages-square"
        :title="subagentScope ? 'Ask about this subagent' : 'Ask about this session'"
        :description="subagentScope
          ? 'The selected local coding agent can inspect this subagent\'s transcript, edit files, and run commands with full permissions.'
          : 'The selected local coding agent can inspect the session, edit files, and run commands with full permissions.'"
        variant="naked"
      />

      <template v-for="(row, index) in rows" :key="rowKey(row, index)">
        <UChatMessage
          v-if="row.kind === 'user'"
          class="chat-message user"
          role="user"
          :content="row.text"
          icon="i-lucide-user-round"
          variant="soft"
          side="right"
        >
          <template #header><header><UIcon name="i-lucide-user-round" />You</header></template>
          <template #content><TranscriptMarkdown :markdown="row.text" /></template>
        </UChatMessage>
        <UChatMessage
          v-else-if="row.kind === 'assistant'"
          class="chat-message assistant"
          role="assistant"
          icon="i-lucide-sparkles"
          variant="naked"
          side="left"
        >
          <template #header><header><UIcon name="i-lucide-sparkles" />{{ agentLabels[row.agent] }}</header></template>
          <template #content>
            <TranscriptMarkdown :markdown="row.text" />
          </template>
        </UChatMessage>
        <UChatReasoning
          v-else-if="row.kind === 'thought'"
          class="chat-thought"
          :text="row.text"
          :streaming="busy && index === rows.length - 1"
          icon="i-lucide-brain"
        >
          <TranscriptMarkdown :markdown="row.text" />
        </UChatReasoning>
        <UChatTool
          v-else-if="row.kind === 'tool'"
          class="chat-tool"
          :text="row.title || row.toolKind || 'Tool call'"
          :suffix="row.toolKind && row.toolKind !== row.title ? row.toolKind : row.status || 'running'"
          icon="i-lucide-wrench"
          :loading="row.status === 'running'"
          :streaming="row.status === 'running'"
        />
        <UAlert
          v-else-if="row.kind === 'error'"
          class="chat-error"
          color="error"
          variant="soft"
          icon="i-lucide-circle-alert"
          title="Agent error"
          :description="row.text"
        />
        <div v-else-if="row.kind === 'turn-end' && row.stopReason !== 'end_turn'" class="chat-turn-end">
          Turn ended: {{ row.stopReason.replace(/_/g, ' ') }}
        </div>
      </template>

      <UChatShimmer
        v-if="busy"
        class="chat-typing"
        :text="status === 'starting' ? 'Starting local agent…' : 'Reading the session…'"
      />
    </UChatMessages>

    <UAlert
      v-if="requestError"
      class="chat-request-error"
      color="error"
      variant="soft"
      icon="i-lucide-wifi-off"
      title="Local chat unavailable"
      :description="`${requestError.message}. ${requestError.remedy}`"
    />

    <UChatPrompt
      v-model="draft"
      class="chat-composer"
      :aria-label="subagentScope ? 'Question about this subagent' : 'Question about this session'"
      placeholder="Ask why something happened…"
      :rows="2"
      :maxrows="8"
      :disabled="!project || !sessionKey"
      @submit="send"
    >
      <template #footer><div class="chat-composer-footer">
        <span><UIcon name="i-lucide-shield-check" />Read-only tools</span>
        <UButton type="button" class="chat-secondary" color="neutral" variant="ghost" icon="i-lucide-rotate-ccw" :disabled="actionPending" @click="reset">New</UButton>
        <UChatPromptSubmit
          :status="chatUiStatus"
          :disabled="!canSend"
          @stop="cancel"
          @reload="send"
        >{{ busy ? 'Stop' : 'Send' }}</UChatPromptSubmit>
      </div></template>
    </UChatPrompt>
  </div>
</template>
