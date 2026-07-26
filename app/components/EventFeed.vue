<script setup lang="ts">
import security from '@comark/nuxt/plugins/security'
import type { TranscriptEvent } from '#shared/types/run'
import type { FeedDensity } from '~/composables/useLiveRuns'

const markdownPlugins = [
  security({
    blockedTags: ['script', 'iframe', 'object', 'embed', 'link', 'style', 'base', 'meta'],
    allowedProtocols: ['http', 'https', 'mailto'],
  }),
]

const props = defineProps<{
  events: TranscriptEvent[]
  density: FeedDensity
  errorsOnly: boolean
  followOutput: boolean
}>()

const emit = defineEmits<{ select: [key: string] }>()
const feed = useTemplateRef('feed')

const visibleEvents = computed(() => props.events.filter((event) => {
  if (props.errorsOnly) return Boolean(event.error)
  if (props.density === 'raw') return true
  if (props.density === 'compact') {
    return event.kind !== 'thinking'
      && !(event.kind === 'tool_result' && !event.error)
      && event.kind !== 'meta'
      && event.kind !== 'system'
  }
  return event.kind !== 'meta' && event.kind !== 'system'
}))

const emptyState = computed(() => {
  if (!props.events.length) {
    return {
      title: 'No activity yet',
      description: 'Select a session from the sidebar to follow its activity.',
    }
  }
  if (props.errorsOnly) {
    return {
      title: 'No errors found',
      description: 'This session has no recorded error events.',
    }
  }
  return {
    title: 'No matching activity',
    description: 'Try a different event detail level.',
  }
})

function isCompact(event: TranscriptEvent): boolean {
  return props.density === 'compact'
    && (event.kind === 'tool_use'
      || event.kind === 'text'
      || event.kind === 'prompt'
      || (event.kind === 'tool_result' && Boolean(event.error)))
}

function eventClass(event: TranscriptEvent): Record<string, boolean> {
  return {
    user: event.kind === 'prompt',
    assistant: event.kind === 'text',
    thinking: event.kind === 'thinking',
    tool_use: event.kind === 'tool_use',
    tool_result: event.kind === 'tool_result',
    spawn: Boolean(event.spawn),
    write: Boolean(event.write && event.kind === 'tool_use'),
    error: Boolean(event.error),
  }
}

function labelFor(event: TranscriptEvent): string {
  if (event.spawn) return 'Delegated work'
  if (event.kind === 'prompt') return 'You'
  if (event.kind === 'text') return 'Assistant'
  if (event.kind === 'thinking') return 'Reasoning'
  if (event.kind === 'tool_result') return event.error ? `${event.tool || 'Action'} failed` : `${event.tool || 'Action'} result`
  if (event.kind !== 'tool_use') return 'System'

  const labels: Record<string, string> = {
    Read: 'Read file',
    Grep: 'Searched code',
    Glob: 'Located files',
    Bash: 'Ran command',
    Edit: 'Edited file',
    Write: 'Wrote file',
    Agent: 'Delegated work',
    Task: 'Delegated work',
    TodoWrite: 'Updated plan',
    WebSearch: 'Searched the web',
    WebFetch: 'Read web page',
  }
  return labels[event.tool || ''] || event.tool || 'Used tool'
}

function iconFor(event: TranscriptEvent): string {
  if (event.spawn) return 'i-lucide-git-fork'
  if (event.error) return 'i-lucide-circle-alert'
  if (event.kind === 'prompt') return 'i-lucide-user-round'
  if (event.kind === 'text') return 'i-lucide-sparkles'
  if (event.kind === 'thinking') return 'i-lucide-brain'
  if (event.kind === 'tool_result') return 'i-lucide-corner-down-right'

  const icons: Record<string, string> = {
    Read: 'i-lucide-file-search',
    Grep: 'i-lucide-search',
    Glob: 'i-lucide-folder-search',
    Bash: 'i-lucide-square-terminal',
    Edit: 'i-lucide-file-pen-line',
    Write: 'i-lucide-file-plus-2',
    Agent: 'i-lucide-git-fork',
    Task: 'i-lucide-git-fork',
    TodoWrite: 'i-lucide-list-checks',
    WebSearch: 'i-lucide-globe-2',
    WebFetch: 'i-lucide-globe-2',
  }
  return icons[event.tool || ''] || 'i-lucide-wrench'
}

function resultSummary(event: TranscriptEvent): string {
  const first = (event.body || '').split('\n').slice(0, 3).join(' ⏎ ')
  return `${first.slice(0, 170) || '(empty)'} · ${formatCount(event.full || 0)} chars`
}

async function scrollToBottom(): Promise<void> {
  await nextTick()
  const stick = (): void => {
    if (props.followOutput && feed.value) feed.value.scrollTop = feed.value.scrollHeight
  }
  stick()
  if (typeof requestAnimationFrame !== 'undefined') {
    requestAnimationFrame(() => requestAnimationFrame(stick))
  }
}

watch(
  () => visibleEvents.value.length,
  () => {
    if (props.followOutput) void scrollToBottom()
  },
)

watch(
  () => props.followOutput,
  (enabled) => {
    if (enabled) void scrollToBottom()
  },
  { immediate: true },
)
</script>

<template>
  <div ref="feed" class="feed" aria-live="polite">
    <div v-if="!visibleEvents.length" class="empty-state feed-empty">
      <span class="empty-state-icon"><UIcon name="i-lucide-activity" /></span>
      <h2>{{ emptyState.title }}</h2>
      <p>{{ emptyState.description }}</p>
    </div>
    <template v-for="(event, eventIndex) in visibleEvents" :key="`${event.line}-${event.kind}-${event.id || ''}-${eventIndex}`">
      <button
        v-if="isCompact(event)"
        class="compact-row"
        :class="{ write: event.write, error: event.error, spawn: event.spawn, prose: event.kind === 'text' }"
        :disabled="!event.childKey"
        type="button"
        @click="event.childKey && emit('select', event.childKey)"
      >
        <span class="time">{{ formatTime(event.ts, false) }}</span>
        <span class="compact-icon"><UIcon :name="iconFor(event)" /></span>
        <span class="compact-text">
          <b>{{ labelFor(event) }}</b>
          {{ event.kind === 'tool_result'
            ? `— ${(event.body || '').split('\n')[0]?.slice(0, 180)}`
            : event.kind === 'tool_use'
              ? `— ${(event.summary || '').slice(0, 150)}`
              : `— ${(event.body || '').slice(0, event.kind === 'text' ? 400 : 300)}` }}
        </span>
      </button>

      <article v-else class="event" :class="eventClass(event)">
        <div class="event-rail">
          <span class="event-icon"><UIcon :name="iconFor(event)" /></span>
          <span class="event-line" />
        </div>
        <div class="event-content">
          <header>
            <strong>{{ labelFor(event) }}</strong>
            <span>{{ formatTime(event.ts) }}</span>
            <span v-if="event.model" class="event-model">{{ event.model }}</span>
          </header>
          <template v-if="event.kind === 'tool_use'">
            <div class="call-line">{{ (event.summary || '').slice(0, 500) }}</div>
            <details class="event-details">
              <summary>Show tool input</summary>
              <pre>{{ event.input || '' }}</pre>
            </details>
            <button v-if="event.childKey" class="jump" type="button" @click="emit('select', event.childKey)">
              <UIcon name="i-lucide-bot" /> Open subagent
              <UIcon name="i-lucide-arrow-right" />
            </button>
          </template>
          <template v-else-if="event.kind === 'tool_result'">
            <details class="event-details result-details" :open="event.error">
              <summary>{{ resultSummary(event) }}</summary>
              <pre>{{ event.body || '' }}</pre>
            </details>
          </template>
          <Comark
            v-else-if="event.kind === 'text'"
            class="markdown-body"
            :markdown="event.body || ''"
            :plugins="markdownPlugins"
          />
          <pre v-else>{{ event.body || '' }}</pre>
          <div v-if="(event.full || 0) > 8_000" class="truncated">Truncated · {{ formatCount(event.full || 0) }} characters total</div>
          <div v-if="event.usage" class="usage">
            {{ formatCount(event.usage.in) }} in · {{ formatCount(event.usage.out) }} out ·
            cache {{ formatCount(event.usage.cr) }} read / {{ formatCount(event.usage.cw) }} written
          </div>
          <details
            v-if="density === 'raw' && (event.uuid || event.requestId || event.promptId || event.sourceUuid)"
            class="event-details causal-details"
          >
            <summary>Event identity and causal links</summary>
            <dl>
              <div><dt>Line</dt><dd>{{ event.line + 1 }}</dd></div>
              <div v-if="event.uuid"><dt>UUID</dt><dd>{{ event.uuid }}</dd></div>
              <div v-if="event.parentUuid"><dt>Parent</dt><dd>{{ event.parentUuid }}</dd></div>
              <div v-if="event.requestId"><dt>Request</dt><dd>{{ event.requestId }}</dd></div>
              <div v-if="event.promptId"><dt>Prompt</dt><dd>{{ event.promptId }}</dd></div>
              <div v-if="event.sourceUuid"><dt>Source</dt><dd>{{ event.sourceUuid }}</dd></div>
              <div v-if="event.stopReason"><dt>Stop reason</dt><dd>{{ event.stopReason }}</dd></div>
              <div v-if="event.effort"><dt>Effort</dt><dd>{{ event.effort }}</dd></div>
              <div><dt>Sidechain</dt><dd>{{ event.sidechain ? 'yes' : 'no' }}</dd></div>
            </dl>
          </details>
        </div>
      </article>
    </template>
  </div>
</template>
