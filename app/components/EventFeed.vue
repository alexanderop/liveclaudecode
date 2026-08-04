<script setup lang="ts">
import type { TranscriptEvent } from '#shared/types/run'
import type { FeedDensity } from '~/composables/useLiveRuns'
import { parseTimestamp } from '~/utils/format'
import { toolUseIcon, toolUseLabel } from '~/utils/tool-display'

const props = defineProps<{
  events: TranscriptEvent[]
  density: FeedDensity
  errorsOnly: boolean
  followOutput: boolean
  selectedLine?: number | null
  asOf?: number | null
  sessionWide?: boolean
  truncated?: boolean
}>()

const emit = defineEmits<{
  select: [key: string]
  'focus-time': [timestamp: number | null, line: number]
}>()
const feed = useTemplateRef('feed')
const pinnedToBottom = ref(true)
const BOTTOM_THRESHOLD = 32
const { arrivedState } = useScroll(feed, { offset: { bottom: BOTTOM_THRESHOLD }, eventListenerOptions: { passive: true } })
// Not a computed: `resumeFollowing` manually overrides `pinnedToBottom` to
// re-pin without waiting for the scroll to arrive, so the scroll state can
// only be copied in one direction here.
watch(() => arrivedState.bottom, bottom => { pinnedToBottom.value = bottom })

const visibleEvents = computed(() => props.events.filter((event) => {
  if (props.asOf != null) {
    const timestamp = parseTimestamp(event.ts)
    if (timestamp !== null && timestamp > props.asOf) return false
  }
  if (props.errorsOnly) return Boolean(event.error)
  if (event.error) return true
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
      description: 'No transcript activity has been recorded for this selection.',
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
  if (event.kind !== 'tool_use') return event.summary || (event.error ? 'Incident' : 'System')
  return toolUseLabel(event.tool)
}

function iconFor(event: TranscriptEvent): string {
  if (event.kind === 'tool_result') return event.error ? 'i-lucide-circle-alert' : 'i-lucide-corner-down-right'
  if (event.spawn) return 'i-lucide-git-fork'
  if (event.error) return 'i-lucide-circle-alert'
  if (event.kind === 'prompt') return 'i-lucide-user-round'
  if (event.kind === 'text') return 'i-lucide-sparkles'
  if (event.kind === 'thinking') return 'i-lucide-brain'
  return toolUseIcon(event.tool)
}

/**
 * Tool-use ids of delegations, so their results can be told apart from ordinary
 * tool output. A subagent returns its final message, which is prose; command
 * output and file contents are not.
 */
const spawnToolIds = computed(() => {
  const ids = new Set<string>()
  for (const event of props.events) {
    if (event.kind === 'tool_use' && event.spawn && event.id) ids.add(event.id)
  }
  return ids
})

/**
 * Whether an event body is markdown a person wrote or a model produced. Raw
 * tool output, system records, and error text are left verbatim, since markdown
 * rendering would swallow their indentation and punctuation.
 */
function isProse(event: TranscriptEvent): boolean {
  if (event.error) return false
  if (event.kind === 'tool_result') return Boolean(event.id && spawnToolIds.value.has(event.id))
  return event.kind === 'text' || event.kind === 'prompt' || event.kind === 'thinking'
}

function resultSummary(event: TranscriptEvent): string {
  const first = (event.body || '').split('\n').slice(0, 3).join(' ⏎ ')
  return `${first.slice(0, 170) || '(empty)'} · ${formatCount(event.full || 0)} chars`
}

function focusEvent(event: TranscriptEvent): void {
  if (event.agentKey) emit('select', event.agentKey)
  else if (event.childKey) emit('select', event.childKey)
  emit('focus-time', parseTimestamp(event.ts), event.line)
}

async function scrollToBottom(): Promise<void> {
  await nextTick()
  const stick = (): void => {
    if (props.followOutput && pinnedToBottom.value && feed.value) {
      feed.value.scrollTop = feed.value.scrollHeight
    }
  }
  stick()
  if (typeof requestAnimationFrame !== 'undefined') {
    requestAnimationFrame(() => requestAnimationFrame(stick))
  }
}

function resumeFollowing(): void {
  pinnedToBottom.value = true
  void scrollToBottom()
}

async function scrollToSelectedEvent(line: number): Promise<void> {
  await nextTick()
  const container = feed.value
  const target = container?.querySelector<HTMLElement>(`[data-event-line="${line}"]`)
  if (!container || !target) return

  const containerRect = container.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  const top = Math.max(
    0,
    container.scrollTop
    + targetRect.top
    - containerRect.top
    - (containerRect.height - targetRect.height) / 2,
  )

  container.scrollTo({ top, behavior: 'smooth' })
}

watch(
  () => visibleEvents.value.length,
  () => {
    if (props.followOutput && pinnedToBottom.value) void scrollToBottom()
  },
)

watch(
  () => props.followOutput,
  (enabled) => {
    if (enabled) {
      pinnedToBottom.value = true
      void scrollToBottom()
    }
  },
  { immediate: true },
)

watch(
  [
    () => props.selectedLine,
    () => props.events.length,
    () => props.density,
    () => props.errorsOnly,
  ],
  ([line]) => {
    if (line != null) void scrollToSelectedEvent(line)
  },
  { flush: 'post' },
)

onMounted(() => {
  if (props.selectedLine != null) void scrollToSelectedEvent(props.selectedLine)
})
</script>

<template>
  <div ref="feed" class="feed">
    <div v-if="truncated" class="feed-notice" role="status">
      <UIcon name="i-lucide-history" /> Showing the latest {{ formatCount(events.length) }} session events
    </div>
    <UEmpty
      v-if="!visibleEvents.length"
      class="feed-empty"
      icon="i-lucide-activity"
      :title="emptyState.title"
      :description="emptyState.description"
      variant="naked"
    />
    <template v-for="(event, eventIndex) in visibleEvents" :key="`${event.line}-${event.kind}-${event.id || ''}-${eventIndex}`">
      <button
        v-if="isCompact(event)"
        class="compact-row"
        :class="{ write: event.write, error: event.error, spawn: event.spawn, prose: event.kind === 'text', selected: selectedLine === event.line }"
        :data-event-line="event.line"
        type="button"
        @click="focusEvent(event)"
      >
        <span class="time">{{ formatTime(event.ts, false) }}</span>
        <span class="compact-icon"><UIcon :name="iconFor(event)" /></span>
        <span class="compact-text">
          <b>{{ labelFor(event) }}</b>
          <i v-if="sessionWide && event.agentLabel">{{ event.agentLabel }}</i>
          {{ event.kind === 'tool_result'
            ? `— ${(event.body || '').split('\n')[0]?.slice(0, 180)}`
            : event.kind === 'tool_use'
              ? `— ${(event.summary || '').slice(0, 150)}`
              : `— ${(event.body || '').slice(0, event.kind === 'text' ? 400 : 300)}` }}
        </span>
      </button>

      <article
        v-else
        class="event"
        :class="[eventClass(event), { selected: selectedLine === event.line }]"
        :data-event-line="event.line"
      >
        <div class="event-rail">
          <span class="event-icon"><UIcon :name="iconFor(event)" /></span>
          <span class="event-line" />
        </div>
        <div class="event-content">
          <header>
            <strong>{{ labelFor(event) }}</strong>
            <button
              v-if="sessionWide && event.agentKey"
              type="button"
              class="event-agent"
              :title="event.agentLabel"
              @click.stop="emit('select', event.agentKey)"
            ><UIcon name="i-lucide-bot" />{{ event.agentLabel || event.agentType }}</button>
            <button type="button" class="event-time-button" @click="focusEvent(event)">{{ formatTime(event.ts) }}</button>
            <span v-if="event.model" class="event-model">{{ event.model }}</span>
          </header>
          <template v-if="event.kind === 'tool_use'">
            <div class="call-line">{{ (event.summary || '').slice(0, 500) }}</div>
            <ToolInputBlock :tool="event.tool" :input="event.input" />
            <button v-if="event.childKey" class="jump" type="button" @click="emit('select', event.childKey)">
              <UIcon name="i-lucide-bot" /> Open subagent
              <UIcon name="i-lucide-arrow-right" />
            </button>
          </template>
          <template v-else-if="event.kind === 'tool_result'">
            <details class="event-details result-details" :open="event.error">
              <summary>{{ resultSummary(event) }}</summary>
              <TranscriptMarkdown v-if="isProse(event)" :markdown="event.body || ''" />
              <pre v-else>{{ event.body || '' }}</pre>
            </details>
          </template>
          <TranscriptMarkdown v-else-if="isProse(event)" :markdown="event.body || ''" />
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
    <button
      v-if="followOutput && !pinnedToBottom"
      type="button"
      class="feed-resume"
      @click="resumeFollowing"
    ><UIcon name="i-lucide-arrow-down" /> New activity · jump to latest</button>
  </div>
</template>
