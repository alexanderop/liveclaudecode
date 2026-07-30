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
  hours: number
}>()

type ChatRow =
  | { kind: 'user' | 'error', text: string }
  | { kind: 'assistant' | 'thought', agent: ChatAgentId, text: string }
  | { kind: 'tool', toolCallId: string, title: string, toolKind: string, status: string }
  | { kind: 'turn-end', stopReason: string }

type ChatSessionState = {
  events: ChatEvent[]
  since: number
  revision: number
  status: ChatStatus
  selectedAgent: ChatAgentId
  draft: string
}

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

const sessionState = useState<ChatSessionState>(
  `liveclaudecode:ask:${encodeURIComponent(props.project)}:${encodeURIComponent(props.sessionKey)}`,
  () => ({
    events: [],
    since: 0,
    revision: 0,
    status: 'idle',
    selectedAgent: 'claude',
    draft: '',
  }),
)
const {
  events,
  since,
  revision,
  status,
  selectedAgent,
  draft,
} = toRefs(sessionState.value)
const actionPending = ref(false)
const pollPending = ref(false)
const requestError = ref('')
let timer: ReturnType<typeof setInterval> | undefined

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

async function poll(): Promise<void> {
  const project = props.project
  const key = props.sessionKey
  const requestedHours = props.hours
  if (!project || !key || pollPending.value) return
  pollPending.value = true
  try {
    const response = await $fetch<ChatEventsResponse>(
      `/api/chat?project=${encodeURIComponent(project)}&key=${encodeURIComponent(key)}&since=${since.value}&revision=${revision.value}&hours=${requestedHours}`,
    )
    if (props.project !== project || props.sessionKey !== key || props.hours !== requestedHours) return
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
    const response = await $fetch<{ status: ChatStatus }>(`/api/chat?hours=${props.hours}`, {
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

watch(
  () => `${props.project}\0${props.sessionKey}\0${props.hours}`,
  () => {
    events.value = []
    since.value = 0
    revision.value = 0
    status.value = 'idle'
    requestError.value = ''
    void poll()
  },
)

function startPolling(): void {
  void poll()
  if (!timer) timer = setInterval(() => void poll(), 800)
}

function stopPolling(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}

onMounted(startPolling)
onActivated(startPolling)
onDeactivated(stopPolling)
onUnmounted(stopPolling)
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

      <template v-for="(row, index) in rows" :key="`${row.kind}-${index}`">
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
