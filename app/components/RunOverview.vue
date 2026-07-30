<script setup lang="ts">
import type { RunNode, RunResponse } from '#shared/types/run'
import { normalizeSessionLabel } from '#shared/utils/session-label'
import { flattenRunTree } from '~/utils/execution-analysis'
import { agentState } from '~/utils/session-state'
import type { PrimaryWorkspaceKind } from '~/utils/workspace-state'

const props = withDefaults(defineProps<{
  root?: RunNode | null
  run: RunResponse | null
  loading?: boolean
  sourceIncomplete?: boolean
  selectedKey?: string | null
}>(), {
  root: null,
  loading: false,
  sourceIncomplete: false,
  selectedKey: null,
})

const emit = defineEmits<{
  open: [destination: PrimaryWorkspaceKind]
  ask: []
  select: [key: string]
}>()

const toast = useToast()
const overviewRoot = computed<RunNode | null>(() => {
  if (props.root) return props.root
  if (!props.run?.root) return null
  return { ...props.run.root, children: [], subFiles: {} }
})
const agents = computed(() => flattenRunTree(overviewRoot.value))
const activeAgents = computed(() => agents.value
  .filter(node => node.live || node.current)
  .sort((left, right) => (right.mtime || 0) - (left.mtime || 0)))
const primaryAgent = computed(() => activeAgents.value.find(node => node.current) || activeAgents.value[0] || overviewRoot.value)
const incidents = computed(() => (props.run?.diagnostics.incidents || [])
  .filter(incident => incident.severity === 'warning' || incident.severity === 'error'))
const warningCount = computed(() => incidents.value.filter(incident => incident.severity === 'warning').length)
const errorCount = computed(() => incidents.value.filter(incident => incident.severity === 'error').length)
const attentionCount = computed(() => warningCount.value + errorCount.value)
const agentStatuses = computed(() => agents.value.map(node => agentState(node, props.run?.diagnostics.incidents)))
const stateCounts = computed(() => agentStatuses.value.reduce<Record<string, number>>((counts, state) => {
  counts[state.state] = (counts[state.state] || 0) + 1
  return counts
}, {}))

const displayState = computed(() => {
  const root = overviewRoot.value
  if (!root) return { kind: 'inactive', label: 'No recorded activity', icon: 'i-lucide-circle' }
  if (root.subLive) return { kind: 'running', label: 'Session running', icon: 'i-lucide-radio' }
  if (root.stoppedByUser) {
    return {
      kind: root.finalText ? 'stopped' : 'warning',
      label: 'Session stopped',
      icon: 'i-lucide-circle-stop',
    }
  }
  if ((errorCount.value || root.subErrors) && !root.finalText) {
    return { kind: 'failed', label: 'Session failed', icon: 'i-lucide-circle-x' }
  }
  if (attentionCount.value || root.subErrors) {
    return { kind: 'warning', label: 'Completed with warnings', icon: 'i-lucide-triangle-alert' }
  }
  if (root.finalText || root.lastTs) {
    return { kind: 'completed', label: 'Session completed', icon: 'i-lucide-circle-check' }
  }
  return { kind: 'inactive', label: 'No recorded activity', icon: 'i-lucide-circle' }
})

const attentionMessage = computed(() => {
  if (props.sourceIncomplete) return 'Session data may be incomplete'
  if (!attentionCount.value && !overviewRoot.value?.subErrors) return ''
  const total = attentionCount.value || overviewRoot.value?.subErrors || 0
  if (displayState.value.kind === 'failed') {
    return `${total} recorded ${total === 1 ? 'failure needs' : 'failures need'} review`
  }
  return `${total} recovered ${total === 1 ? 'incident may' : 'incidents may'} affect the result`
})

const finalExcerpt = computed(() => {
  const value = overviewRoot.value?.finalText?.replace(/\s+/g, ' ').trim() || ''
  if (!value) {
    if (displayState.value.kind === 'failed') return 'The session ended without a usable final response.'
    if (overviewRoot.value?.stoppedByUser) return 'The session stopped before a final response was recorded.'
    return ''
  }
  return value.length > 240 ? `${value.slice(0, 237)}…` : value
})

const actions = computed<Array<{ destination: PrimaryWorkspaceKind | 'ask', label: string, icon: string }>>(() => {
  if (overviewRoot.value?.subLive) {
    return attentionCount.value || props.sourceIncomplete
      ? [
          { destination: 'diagnostics', label: 'Review diagnostics', icon: 'i-lucide-stethoscope' },
          { destination: 'map', label: 'View live agents', icon: 'i-lucide-workflow' },
        ]
      : [
          { destination: 'map', label: 'View live agents', icon: 'i-lucide-workflow' },
          { destination: 'activity', label: 'Read activity', icon: 'i-lucide-activity' },
        ]
  }
  const result: Array<{ destination: PrimaryWorkspaceKind | 'ask', label: string, icon: string }> = []
  if (props.run?.files.length) result.push({ destination: 'changes', label: 'Review changes', icon: 'i-lucide-files' })
  if (attentionCount.value || props.sourceIncomplete || overviewRoot.value?.subErrors) {
    result.push({ destination: 'diagnostics', label: 'Review diagnostics', icon: 'i-lucide-stethoscope' })
  }
  if (result.length < 2) result.push({ destination: 'ask', label: 'Ask about run', icon: 'i-lucide-message-square' })
  if (result.length < 2) result.push({ destination: 'activity', label: 'Read activity', icon: 'i-lucide-activity' })
  return result.slice(0, 2)
})

async function copyTranscriptPath(): Promise<void> {
  if (!props.run?.transcriptPath) return
  try {
    await navigator.clipboard.writeText(props.run.transcriptPath)
    toast.add({ title: 'Transcript path copied', icon: 'i-lucide-check', color: 'success' })
  } catch {
    toast.add({ title: 'Could not copy transcript path', icon: 'i-lucide-copy-x', color: 'error' })
  }
}

function openAction(destination: PrimaryWorkspaceKind | 'ask'): void {
  if (destination === 'ask') emit('ask')
  else emit('open', destination)
}
</script>

<template>
  <div class="overview-workspace">
    <div v-if="loading && !overviewRoot" class="overview-skeleton" aria-label="Loading selected session">
      <USkeleton class="h-5 w-36" />
      <USkeleton class="h-9 w-64" />
      <USkeleton class="h-16 w-full" />
      <USkeleton class="h-10 w-48" />
    </div>

    <div v-else-if="!overviewRoot" class="empty-library">
      <UIcon name="i-lucide-folder-search" />
      <h1 data-workspace-heading tabindex="-1">No local sessions found</h1>
      <p>Start a supported coding-agent session or adjust the project and recency filters.</p>
    </div>

    <template v-else>
      <section class="overview-summary" :class="displayState.kind">
        <span class="overview-status-icon"><UIcon :name="displayState.icon" /></span>
        <p v-if="overviewRoot.subLive" class="overview-agent-count">
          {{ activeAgents.length || overviewRoot.subRunning || 1 }}
          {{ (activeAgents.length || overviewRoot.subRunning || 1) === 1 ? 'agent active' : 'agents active' }}
        </p>
        <h1 data-workspace-heading tabindex="-1">{{ displayState.label }}</h1>

        <button
          v-if="overviewRoot.subLive && primaryAgent"
          type="button"
          class="overview-current-action"
          @click="emit('select', primaryAgent.key)"
        >
          <span>
            <strong>{{ normalizeSessionLabel(primaryAgent.label, primaryAgent.key) }}</strong>
            <small>{{ primaryAgent.current?.tool || 'Working' }}</small>
          </span>
          <p>{{ primaryAgent.current?.summary || 'Active work is recorded for this agent.' }}</p>
          <UIcon name="i-lucide-chevron-right" />
        </button>

        <details v-if="activeAgents.length > 1" class="overview-more-agents">
          <summary>{{ activeAgents.length - 1 }} more active {{ activeAgents.length === 2 ? 'agent' : 'agents' }}</summary>
          <button
            v-for="agent in activeAgents.slice(1)"
            :key="agent.key"
            type="button"
            @click="emit('select', agent.key)"
          >
            <span>{{ normalizeSessionLabel(agent.label, agent.key) }}</span>
            <small>{{ agent.current?.tool || 'Working' }} · {{ agent.current?.summary || 'Active' }}</small>
          </button>
        </details>

        <p v-if="!overviewRoot.subLive && finalExcerpt" class="overview-result">{{ finalExcerpt }}</p>

        <button
          v-if="attentionMessage"
          type="button"
          class="overview-attention"
          :class="{ failed: displayState.kind === 'failed' }"
          @click="emit('open', 'diagnostics')"
        >
          <UIcon :name="displayState.kind === 'failed' ? 'i-lucide-circle-x' : 'i-lucide-triangle-alert'" />
          <span>{{ attentionMessage }}</span>
          <UIcon name="i-lucide-chevron-right" />
        </button>
        <p v-else-if="run && !sourceIncomplete" class="overview-clear">
          <UIcon name="i-lucide-circle-check" /> No recorded warnings or errors
        </p>

        <div class="overview-actions">
          <UButton
            v-for="action in actions"
            :key="action.destination"
            type="button"
            :color="action === actions[0] ? 'primary' : 'neutral'"
            :variant="action === actions[0] ? 'solid' : 'outline'"
            :icon="action.icon"
            @click="openAction(action.destination)"
          >{{ action.label }}</UButton>
        </div>
      </section>

      <details class="run-details">
        <summary>
          <span><UIcon name="i-lucide-list-collapse" /> Run details</span>
          <UIcon class="disclosure-chevron" name="i-lucide-chevron-down" />
        </summary>
        <div class="run-details-content">
          <section>
            <h2>Execution</h2>
            <dl>
              <div><dt>Agents</dt><dd>{{ agents.length }}</dd></div>
              <div><dt>Running</dt><dd>{{ stateCounts.running || 0 }}</dd></div>
              <div><dt>Waiting</dt><dd>{{ stateCounts.waiting || 0 }}</dd></div>
              <div><dt>Completed</dt><dd>{{ (stateCounts.completed || 0) + (stateCounts.warning || 0) }}</dd></div>
              <div><dt>Tool calls</dt><dd>{{ overviewRoot.subTools }}</dd></div>
              <div><dt>Files changed</dt><dd>{{ run?.files.length || 0 }}</dd></div>
              <div><dt>Elapsed</dt><dd>{{ formatDuration(overviewRoot.firstTs, overviewRoot.subLast) }}</dd></div>
            </dl>
          </section>
          <section>
            <h2>Session</h2>
            <dl>
              <div><dt>Session ID</dt><dd><code>{{ overviewRoot.sid }}</code></dd></div>
              <div><dt>Provider</dt><dd>{{ overviewRoot.sourceDetail || overviewRoot.source }}</dd></div>
              <div><dt>Model</dt><dd>{{ overviewRoot.model || 'Not recorded' }}</dd></div>
              <div><dt>Output tokens</dt><dd>{{ formatCount(run?.diagnostics.usage.out || overviewRoot.tokensOut) }}</dd></div>
              <div><dt>Cache read</dt><dd>{{ formatCount(run?.diagnostics.usage.cr || 0) }}</dd></div>
              <div><dt>First event</dt><dd>{{ formatTime(overviewRoot.firstTs) }}</dd></div>
              <div><dt>Last event</dt><dd>{{ formatTime(overviewRoot.subLast) }}</dd></div>
            </dl>
          </section>
          <section v-if="run?.phases.length || overviewRoot.finalText" class="run-details-narrative">
            <h2>Narrative and phases</h2>
            <ol v-if="run?.phases.length">
              <li v-for="phase in run.phases" :key="`${phase.ts}-${phase.title}`">
                <strong>{{ phase.title }}</strong><span>{{ formatTime(phase.ts, false) }}</span>
              </li>
            </ol>
            <p v-if="overviewRoot.finalText">{{ overviewRoot.finalText }}</p>
          </section>
          <div v-if="run?.transcriptPath" class="run-details-path">
            <UIcon name="i-lucide-file-json" />
            <code :title="run.transcriptPath">{{ run.transcriptPath }}</code>
            <UButton
              type="button"
              color="neutral"
              variant="ghost"
              size="xs"
              icon="i-lucide-copy"
              aria-label="Copy transcript JSONL path"
              @click="copyTranscriptPath"
            >Copy</UButton>
          </div>
        </div>
      </details>
    </template>
  </div>
</template>
