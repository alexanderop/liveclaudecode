<script setup lang="ts">
import security from '@comark/nuxt/plugins/security'
import type { ChatAgentId } from '#shared/types/chat'
import TranscriptMarkdownLink from '~/components/TranscriptMarkdownLink.vue'

const props = defineProps<{
  project: string
  sessionKey: string
  hours: number
}>()

type ChatRow =
  | { kind: 'user' | 'error', text: string }
  | { kind: 'assistant' | 'thought', agent: ChatAgentId, text: string }
  | { kind: 'tool', toolCallId: string, title: string, toolKind: string, status: string }
  | { kind: 'turn-end', stopReason: string }

const markdownPlugins = [
  security({
    blockedTags: ['script', 'iframe', 'object', 'embed', 'link', 'style', 'base', 'meta'],
    allowedProtocols: ['http', 'https', 'mailto'],
  }),
]
const markdownComponents = { a: TranscriptMarkdownLink }
const agents: ReadonlyArray<{ id: ChatAgentId, label: string }> = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'copilot', label: 'Copilot' },
]
const agentLabels: Readonly<Record<ChatAgentId, string>> = Object.fromEntries(
  agents.map(agent => [agent.id, agent.label]),
) as Record<ChatAgentId, string>

const { state: sessionState, touch: touchSessionState } = useChatSessionState(
  props.project,
  props.sessionKey,
)
const {
  events,
  since,
  revision,
  status,
  selectedAgent,
  draft,
} = toRefs(sessionState)
const { actionPending, requestError, ...transport } = useChatTransport({
  project: () => props.project,
  sessionKey: () => props.sessionKey,
  hours: () => props.hours,
  state: { events, since, revision, status, selectedAgent },
})

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

async function send(): Promise<void> {
  const text = draft.value.trim()
  if (!canSend.value || !text) return
  if (await transport.send(text)) draft.value = ''
}

async function cancel(): Promise<void> {
  if (!busy.value || actionPending.value) return
  await transport.cancel()
}

async function reset(): Promise<void> {
  if (actionPending.value) return
  await transport.reset()
}

function activate(): void {
  touchSessionState()
  transport.resume()
}

onMounted(activate)
onActivated(activate)
onDeactivated(() => transport.pause())
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
          @click="selectedAgent = agent.id"
        >{{ agent.label }}</UButton>
      </div>
      <span class="chat-status" :class="status">
        <span class="status-dot" :class="busy ? 'running' : status === 'error' ? 'failed' : 'completed'" />
        {{ status === 'starting' ? 'Starting agent' : status === 'busy' ? 'Answering' : status === 'error' ? 'Agent error' : 'Ready' }}
      </span>
    </div>

    <UChatMessages
      class="chat-log"
      aria-label="Session chat messages"
      :status="chatUiStatus"
      should-auto-scroll
      :should-scroll-to-bottom="true"
    >
      <UEmpty
        v-if="!project || !sessionKey"
        class="chat-empty"
        icon="i-lucide-message-square"
        title="Select a session first"
        description="The local agent needs a session transcript to answer questions."
        variant="naked"
      />
      <UEmpty
        v-else-if="!rows.length && !busy"
        class="chat-empty"
        icon="i-lucide-messages-square"
        title="Ask about this session"
        description="The selected local coding agent can inspect the session, edit files, and run commands with full permissions."
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
            <Comark
              class="markdown-body"
              :markdown="row.text"
              :plugins="markdownPlugins"
              :components="markdownComponents"
            />
          </template>
        </UChatMessage>
        <UChatReasoning
          v-else-if="row.kind === 'thought'"
          class="chat-thought"
          :text="row.text"
          :streaming="busy && index === rows.length - 1"
          icon="i-lucide-brain"
        />
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
      :description="requestError"
    />

    <UChatPrompt
      v-model="draft"
      class="chat-composer"
      aria-label="Question about this session"
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
