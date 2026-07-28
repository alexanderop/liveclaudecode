<script setup lang="ts">
import security from '@comark/nuxt/plugins/security'
import type {
  ChatAction,
  ChatAgentId,
  ChatEvent,
  ChatEventsResponse,
  ChatStatus,
} from '#shared/types/chat'
import TranscriptMarkdownLink from '~/components/TranscriptMarkdownLink.vue'

const props = defineProps<{
  project: string
  sessionKey: string
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

const events = ref<ChatEvent[]>([])
const since = ref(0)
const revision = ref(0)
const status = ref<ChatStatus>('idle')
const selectedAgent = ref<ChatAgentId>('claude')
const draft = ref('')
const actionPending = ref(false)
const pollPending = ref(false)
const requestError = ref('')
const log = useTemplateRef('log')
let timer: ReturnType<typeof setInterval> | undefined

const busy = computed(() => status.value === 'starting' || status.value === 'busy')
const canSend = computed(() => Boolean(
  props.project
  && props.sessionKey
  && draft.value.trim()
  && !busy.value
  && !actionPending.value,
))

const rows = computed<ChatRow[]>(() => {
  const output: ChatRow[] = []
  for (const event of events.value) {
    if (event.kind === 'assistant-chunk' || event.kind === 'thought-chunk') {
      const kind = event.kind === 'assistant-chunk' ? 'assistant' : 'thought'
      const previous = output.at(-1)
      if (previous?.kind === kind && previous.agent === event.agent) previous.text += event.text
      else output.push({ kind, agent: event.agent, text: event.text })
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
      const previous = output.findLast(row => row.kind === 'tool' && row.toolCallId === event.toolCallId)
      if (previous?.kind === 'tool') {
        previous.title = event.title || previous.title
        previous.toolKind = event.toolKind || previous.toolKind
        previous.status = event.status || previous.status
      } else {
        output.push({ ...event })
      }
      continue
    }
    output.push(event)
  }
  return output
})

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The local chat agent is unavailable.'
}

async function scrollToBottom(): Promise<void> {
  await nextTick()
  if (log.value) log.value.scrollTop = log.value.scrollHeight
}

async function poll(): Promise<void> {
  const project = props.project
  const key = props.sessionKey
  if (!project || !key || pollPending.value) return
  pollPending.value = true
  try {
    const response = await $fetch<ChatEventsResponse>(
      `/api/chat?project=${encodeURIComponent(project)}&key=${encodeURIComponent(key)}&since=${since.value}&revision=${revision.value}`,
    )
    if (props.project !== project || props.sessionKey !== key) return
    since.value = response.next
    revision.value = response.revision
    status.value = response.status
    if (response.agent) selectedAgent.value = response.agent
    if (response.reset) events.value = [...response.events]
    else events.value.push(...response.events)
    requestError.value = ''
  } catch (error) {
    requestError.value = errorMessage(error)
  } finally {
    pollPending.value = false
  }
}

async function act(action: ChatAction): Promise<boolean> {
  actionPending.value = true
  requestError.value = ''
  try {
    const response = await $fetch<{ status: ChatStatus }>('/api/chat', {
      method: 'POST',
      body: action,
    })
    status.value = response.status
    await poll()
    return true
  } catch (error) {
    requestError.value = errorMessage(error)
    return false
  } finally {
    actionPending.value = false
  }
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

async function reset(): Promise<void> {
  if (actionPending.value) return
  const accepted = await act({ action: 'reset', project: props.project, key: props.sessionKey })
  if (!accepted) return
  events.value = []
  since.value = 0
  revision.value = 0
  status.value = 'idle'
}

function handleComposerKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  void send()
}

watch(
  () => rows.value.length,
  () => void scrollToBottom(),
)

watch(
  () => `${props.project}\0${props.sessionKey}`,
  () => {
    events.value = []
    since.value = 0
    revision.value = 0
    status.value = 'idle'
    requestError.value = ''
    void poll()
  },
)

onMounted(() => {
  void poll()
  timer = setInterval(() => void poll(), 800)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div class="chat-panel">
    <div class="chat-agent-bar">
      <div class="segments" role="group" aria-label="Answering agent">
        <button
          v-for="agent in agents"
          :key="agent.id"
          type="button"
          :class="{ selected: selectedAgent === agent.id }"
          :aria-pressed="selectedAgent === agent.id"
          :disabled="busy"
          @click="selectedAgent = agent.id"
        >{{ agent.label }}</button>
      </div>
      <span class="chat-status" :class="status">
        <span class="status-dot" :class="busy ? 'running' : status === 'error' ? 'failed' : 'completed'" />
        {{ status === 'starting' ? 'Starting agent' : status === 'busy' ? 'Answering' : status === 'error' ? 'Agent error' : 'Ready' }}
      </span>
    </div>

    <div ref="log" class="chat-log" aria-live="polite" aria-label="Session chat messages">
      <div v-if="!project || !sessionKey" class="empty-state chat-empty">
        <span class="empty-state-icon"><UIcon name="i-lucide-message-square" /></span>
        <h2>Select a session first</h2>
        <p>The local agent needs a session transcript to answer questions.</p>
      </div>
      <div v-else-if="!rows.length" class="empty-state chat-empty">
        <span class="empty-state-icon"><UIcon name="i-lucide-messages-square" /></span>
        <h2>Ask about this session</h2>
        <p>The selected local coding agent can inspect the transcript and referenced files using read-only tools.</p>
      </div>

      <template v-for="(row, index) in rows" :key="`${row.kind}-${index}`">
        <article v-if="row.kind === 'user'" class="chat-message user">
          <header><UIcon name="i-lucide-user-round" />You</header>
          <p>{{ row.text }}</p>
        </article>
        <article v-else-if="row.kind === 'assistant'" class="chat-message assistant">
          <header><UIcon name="i-lucide-sparkles" />{{ agentLabels[row.agent] }}</header>
          <Comark
            class="markdown-body"
            :markdown="row.text"
            :plugins="markdownPlugins"
            :components="markdownComponents"
          />
        </article>
        <details v-else-if="row.kind === 'thought'" class="chat-thought">
          <summary><UIcon name="i-lucide-brain" />Reasoning</summary>
          <pre>{{ row.text }}</pre>
        </details>
        <div v-else-if="row.kind === 'tool'" class="chat-tool">
          <UIcon name="i-lucide-wrench" />
          <span><strong>{{ row.title || row.toolKind || 'Tool call' }}</strong><small>{{ row.toolKind }}</small></span>
          <span class="chat-tool-status">{{ row.status || 'running' }}</span>
        </div>
        <div v-else-if="row.kind === 'error'" class="chat-error">
          <UIcon name="i-lucide-circle-alert" />{{ row.text }}
        </div>
        <div v-else-if="row.kind === 'turn-end' && row.stopReason !== 'end_turn'" class="chat-turn-end">
          Turn ended: {{ row.stopReason.replace(/_/g, ' ') }}
        </div>
      </template>

      <div v-if="busy" class="chat-typing">
        <UIcon name="i-lucide-loader-circle" />
        {{ status === 'starting' ? 'Starting local agent…' : 'Reading the session…' }}
      </div>
    </div>

    <div v-if="requestError" class="chat-request-error" role="alert">
      <UIcon name="i-lucide-wifi-off" />{{ requestError }}
    </div>

    <form class="chat-composer" @submit.prevent="send">
      <textarea
        v-model="draft"
        aria-label="Question about this session"
        placeholder="Ask why something happened…"
        rows="3"
        :disabled="!project || !sessionKey"
        @keydown="handleComposerKeydown"
      />
      <div class="chat-composer-footer">
        <span><UIcon name="i-lucide-shield-check" />Read-only tools</span>
        <button type="button" class="chat-secondary" :disabled="actionPending" title="Start a new chat" @click="reset">
          <UIcon name="i-lucide-rotate-ccw" />New
        </button>
        <button v-if="busy" type="button" class="chat-stop" :disabled="actionPending" @click="cancel">
          <UIcon name="i-lucide-square" />Stop
        </button>
        <button v-else type="submit" class="chat-send" :disabled="!canSend">
          <UIcon name="i-lucide-arrow-up" />Send
        </button>
      </div>
    </form>
  </div>
</template>
