<script setup lang="ts">
import type { RunNode, RunResponse } from '#shared/types/run'
import { normalizeSessionLabel, normalizeSessionSummary } from '#shared/utils/session-label'
import { flattenRunTree } from '~/utils/execution-analysis'
import {
  agentState,
  agentStateIcon,
  sessionDisplayState,
  type SessionDisplayKind,
} from '~/utils/session-state'
import type { PrimaryWorkspaceKind } from '~/utils/workspace-state'

const props = withDefaults(defineProps<{
  root?: RunNode | null
  run: RunResponse | null
  loading?: boolean
  /** The provider's storage could not be read at all, so nothing loaded. */
  sourceUnavailable?: boolean
  sourceMessage?: string
  selectedKey?: string | null
}>(), {
  root: null,
  loading: false,
  sourceUnavailable: false,
  sourceMessage: '',
  selectedKey: null,
})

const emit = defineEmits<{
  open: [destination: PrimaryWorkspaceKind]
  ask: []
  select: [key: string]
}>()

const toast = useToast()
const clipboard = useClipboard({ legacy: true })
const overviewRoot = computed<RunNode | null>(() => {
  if (props.root) return props.root
  if (!props.run?.root) return null
  return { ...props.run.root, children: [], subFiles: {} }
})
const agents = computed(() => flattenRunTree(overviewRoot.value))
const incidents = computed(() => (props.run?.diagnostics.incidents || [])
  .filter(incident => incident.severity === 'warning' || incident.severity === 'error'))
const warningCount = computed(() => incidents.value.filter(incident => incident.severity === 'warning').length)
const errorCount = computed(() => incidents.value.filter(incident => incident.severity === 'error').length)
const attentionCount = computed(() => warningCount.value + errorCount.value)
const agentSummaries = computed(() => agents.value.map(node => ({
  node,
  state: agentState(node, props.run?.diagnostics.incidents),
})))
const visibleAgentSummaries = computed(() => agentSummaries.value.slice(0, 6))
const hiddenAgentCount = computed(() => Math.max(0, agentSummaries.value.length - visibleAgentSummaries.value.length))
const stateCounts = computed(() => agentSummaries.value.reduce<Record<string, number>>((counts, item) => {
  counts[item.state.state] = (counts[item.state.state] || 0) + 1
  return counts
}, {}))

const displayState = computed(() => {
  const state = sessionDisplayState(overviewRoot.value, {
    errorCount: errorCount.value,
    attentionCount: attentionCount.value,
  })
  const labels: Record<SessionDisplayKind, string> = {
    inactive: overviewRoot.value ? 'No activity' : 'No recorded activity',
    running: 'Running',
    stopped: 'Stopped',
    failed: 'Failed',
    warning: 'Completed with warnings',
    completed: 'Completed',
  }
  return {
    // A stop keeps the failed tone this view has always used.
    kind: state.kind === 'stopped' ? 'failed' : state.kind,
    label: labels[state.kind],
    icon: state.icon,
  }
})

const sessionTitle = computed(() => normalizeSessionLabel(
  overviewRoot.value?.label || '',
  'Untitled coding session',
))
/**
 * The opening prompt, but only when a recorded title has taken its place as the
 * heading — otherwise the heading would be repeated back under itself.
 */
const openingPrompt = computed(() => {
  const root = overviewRoot.value
  if (!root?.title || !root.openingPrompt) return ''
  return root.openingPrompt === root.label ? '' : root.openingPrompt
})
const finalExcerpt = computed(() => {
  const value = normalizeSessionSummary(overviewRoot.value?.finalText || '')
  if (value) return value
  if (displayState.value.kind === 'failed') return 'The session ended without a usable final response.'
  if (overviewRoot.value?.stoppedByUser) return 'The session stopped before a final response was recorded.'
  return 'No final summary was recorded for this session.'
})
const providerLabel = computed(() => overviewRoot.value?.sourceDetail || overviewRoot.value?.source || 'Unknown provider')
const branchLabel = computed(() => props.run?.diagnostics.environment.gitBranch || '')
const sessionMetadata = computed(() => [
  providerLabel.value,
  overviewRoot.value?.model || '',
  branchLabel.value ? `Branch ${branchLabel.value}` : '',
  overviewRoot.value?.firstTs ? formatTime(overviewRoot.value.firstTs, false) : '',
].filter(Boolean))
/**
 * How the session was allowed to act. `bypassPermissions` in particular
 * changes how much of the result was reviewed, so it belongs beside the title
 * rather than buried in the diagnostics environment list.
 */
const modeChips = computed(() => {
  const environment = props.run?.diagnostics.environment
  if (!environment) return []
  return [environment.mode, environment.permissionMode]
    .filter(Boolean)
    .map(value => ({
      value,
      risky: value === 'bypassPermissions' || value === 'acceptEdits',
    }))
})
/**
 * Records skipped in *this* session's transcripts, not the provider-wide tally
 * the source status carries — a count from some other session cannot be acted
 * on from here.
 */
const parseSummary = computed(() => props.run?.diagnostics.parse || null)
const skippedRecords = computed(() => parseSummary.value?.skipped || 0)

/**
 * Which cause dominates decides who can fix it: unreadable lines are the
 * transcript's problem, an unmodelled shape is liveclaudecode's.
 */
const parseCause = computed(() => {
  const counts = parseSummary.value?.counts
  if (!counts) return ''
  const unmodelled = counts.schemaMismatch + counts.unsupportedShape
  if (unmodelled && counts.invalidJson) {
    return `${unmodelled} used a shape liveclaudecode does not model and ${counts.invalidJson} were not valid JSON.`
  }
  if (unmodelled) {
    return 'They used a shape liveclaudecode does not model, which usually means its transcript schema is out of date.'
  }
  return 'Those lines were not valid JSON — usually a transcript still being written, or a damaged file.'
})
const attentionTitle = computed(() => {
  if (props.sourceUnavailable) return `${providerLabel.value} data could not be read`
  if (skippedRecords.value) {
    return `${skippedRecords.value} record${skippedRecords.value === 1 ? '' : 's'} in this session could not be parsed`
  }
  const total = attentionCount.value || overviewRoot.value?.subErrors || 0
  return `${total} ${total === 1 ? 'incident needs' : 'incidents need'} review`
})
const attentionDetail = computed(() => {
  if (props.sourceUnavailable) {
    return props.sourceMessage || `${providerLabel.value} storage could not be opened, so no counts are available.`
  }
  if (skippedRecords.value) return `${parseCause.value} Counts here may be low.`
  if (displayState.value.kind === 'failed') return 'The session ended without a successful final result.'
  return 'The session recovered, but these warnings may have affected its result.'
})
/** Only a parse problem has a file and a line to show, so only it links out. */
const attentionOpensDebug = computed(() => !props.sourceUnavailable && skippedRecords.value > 0)
const showAttention = computed(() => props.sourceUnavailable
  || skippedRecords.value > 0
  || attentionCount.value > 0
  || Boolean(overviewRoot.value?.subErrors))
/**
 * The harness's own spend, when it recorded one. It outranks the price-table
 * estimate: it is what the session actually reports, not what we infer.
 */
const budget = computed(() => props.run?.diagnostics.budget || null)
const estimatedCost = computed(() => props.run?.diagnostics.cost?.pricedRequests
  ? formatUsd(props.run.diagnostics.cost.usd)
  : '—')

const metrics = computed<Array<{ label: string, value: string | number, icon: string, destination: PrimaryWorkspaceKind }>>(() => {
  const root = overviewRoot.value
  if (!root) return []
  return [
    { label: agents.value.length === 1 ? 'Agent' : 'Agents', value: agents.value.length, icon: 'i-lucide-bot', destination: 'map' },
    { label: 'Tool calls', value: root.subTools, icon: 'i-lucide-wrench', destination: 'activity' },
    { label: props.run?.files.length === 1 ? 'File changed' : 'Files changed', value: props.run?.files.length || 0, icon: 'i-lucide-files', destination: 'changes' },
    { label: 'Elapsed', value: formatDuration(root.firstTs, root.subLast), icon: 'i-lucide-timer', destination: 'activity' },
    {
      label: budget.value ? 'Reported cost' : 'Estimated cost',
      value: budget.value ? formatUsd(budget.value.usedUsd) : estimatedCost.value,
      icon: 'i-lucide-circle-dollar-sign',
      destination: 'diagnostics',
    },
  ]
})

async function copyTranscriptPath(): Promise<void> {
  if (!props.run?.transcriptPath) return
  try {
    await clipboard.copy(props.run.transcriptPath)
    toast.add({ title: 'Transcript path copied', icon: 'i-lucide-check', color: 'success' })
  } catch {
    toast.add({ title: 'Could not copy transcript path', icon: 'i-lucide-copy-x', color: 'error' })
  }
}
</script>

<template>
  <div class="overview-workspace">
    <div v-if="loading && !overviewRoot" class="overview-skeleton" aria-label="Loading selected session">
      <USkeleton class="h-7 w-72" />
      <USkeleton class="h-20 w-full" />
      <USkeleton class="h-24 w-full" />
    </div>

    <div v-else-if="!overviewRoot" class="empty-library">
      <UIcon name="i-lucide-folder-search" />
      <h1 data-workspace-heading tabindex="-1">No local sessions found</h1>
      <p>Start a supported coding-agent session or adjust the project and recency filters.</p>
    </div>

    <template v-else>
      <header class="overview-header">
        <div class="overview-title-block">
          <span
            class="overview-status-icon"
            :class="displayState.kind"
            role="img"
            :aria-label="displayState.label"
          ><UIcon :name="displayState.icon" /></span>
          <div>
            <span class="section-eyebrow">Session overview</span>
            <h1 data-workspace-heading tabindex="-1">{{ sessionTitle }}</h1>
            <p v-if="openingPrompt" class="overview-opening" :title="openingPrompt">
              Started as “{{ openingPrompt }}”
            </p>
            <p class="overview-metadata">
              <span v-for="item in sessionMetadata" :key="item">{{ item }}</span>
              <span
                v-for="chip in modeChips"
                :key="chip.value"
                class="overview-mode-chip"
                :class="{ risky: chip.risky }"
              >{{ chip.value }}</span>
            </p>
          </div>
        </div>
        <span class="overview-status-pill" :class="displayState.kind">{{ displayState.label }}</span>
      </header>

      <slot name="active-agents" />

      <section class="overview-outcome" aria-labelledby="overview-outcome-heading">
        <div>
          <span class="section-eyebrow">Outcome</span>
          <h2 id="overview-outcome-heading">What happened</h2>
        </div>
        <p>{{ finalExcerpt }}</p>
      </section>

      <section class="overview-metrics" aria-label="Session metrics">
        <button
          v-for="metric in metrics"
          :key="metric.label"
          type="button"
          @click="emit('open', metric.destination)"
        >
          <UIcon :name="metric.icon" />
          <span><strong>{{ metric.value }}</strong><small>{{ metric.label }}</small></span>
          <UIcon class="metric-arrow" name="i-lucide-arrow-up-right" />
        </button>
      </section>

      <NuxtLink
        v-if="showAttention && attentionOpensDebug"
        to="/debug"
        class="overview-attention"
      >
        <UIcon name="i-lucide-bug" />
        <span><strong>{{ attentionTitle }}</strong><small>{{ attentionDetail }} See which records and where.</small></span>
        <UIcon name="i-lucide-chevron-right" />
      </NuxtLink>
      <button
        v-else-if="showAttention"
        type="button"
        class="overview-attention"
        :class="{ failed: displayState.kind === 'failed' }"
        @click="emit('open', 'diagnostics')"
      >
        <UIcon :name="displayState.kind === 'failed' ? 'i-lucide-circle-x' : 'i-lucide-triangle-alert'" />
        <span><strong>{{ attentionTitle }}</strong><small>{{ attentionDetail }}</small></span>
        <UIcon name="i-lucide-chevron-right" />
      </button>

      <section class="overview-agents" aria-labelledby="overview-agents-heading">
        <header>
          <div>
            <span class="section-eyebrow">Execution</span>
            <h2 id="overview-agents-heading">Agent activity</h2>
          </div>
          <button type="button" class="overview-section-link" @click="emit('open', 'map')">
            View agent map <UIcon name="i-lucide-arrow-right" />
          </button>
        </header>
        <div class="overview-agent-list">
          <button
            v-for="({ node, state }, index) in visibleAgentSummaries"
            :key="node.key"
            type="button"
            class="overview-agent-row"
            @click="emit('select', node.key)"
          >
            <span class="agent-state-icon" :class="state.state"><UIcon :name="agentStateIcon(state.state)" /></span>
            <span class="agent-identity">
              <strong>{{ normalizeSessionLabel(node.label, node.key) }}</strong>
              <small>{{ index === 0 ? 'Main session' : node.agentType || 'Subagent' }}</small>
            </span>
            <span class="agent-work"><strong>{{ node.subTools || node.tools }}</strong><small>tools</small></span>
            <span class="agent-status" :class="state.state"><strong>{{ state.label }}</strong><small>{{ state.detail }}</small></span>
            <UIcon class="agent-row-arrow" name="i-lucide-chevron-right" />
          </button>
          <button v-if="hiddenAgentCount" type="button" class="overview-more-agents-link" @click="emit('open', 'map')">
            View {{ hiddenAgentCount }} more {{ hiddenAgentCount === 1 ? 'agent' : 'agents' }}
            <UIcon name="i-lucide-arrow-right" />
          </button>
        </div>
      </section>

      <div class="overview-actions">
        <UButton type="button" color="primary" icon="i-lucide-activity" @click="emit('open', 'activity')">View full activity</UButton>
        <UButton type="button" color="neutral" variant="outline" icon="i-lucide-message-square" @click="emit('ask')">Ask about run</UButton>
      </div>

      <details class="run-details">
        <summary>
          <span><UIcon name="i-lucide-list-collapse" /> Technical details</span>
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
              <div><dt>Provider</dt><dd>{{ providerLabel }}</dd></div>
              <div><dt>Model</dt><dd>{{ overviewRoot.model || 'Not recorded' }}</dd></div>
              <div><dt>Output tokens</dt><dd>{{ formatCount(run?.diagnostics.usage.out || overviewRoot.tokensOut) }}</dd></div>
              <div><dt>Cache read</dt><dd>{{ formatCount(run?.diagnostics.usage.cr || 0) }}</dd></div>
              <div><dt>Estimated API cost</dt><dd>{{ run?.diagnostics.cost?.pricedRequests ? formatUsd(run.diagnostics.cost.usd) : 'Not available' }}</dd></div>
              <div v-if="budget"><dt>Reported budget</dt><dd>{{ formatUsd(budget.usedUsd) }} of {{ formatUsd(budget.totalUsd) }} used</dd></div>
              <div><dt>First event</dt><dd>{{ formatTime(overviewRoot.firstTs) }}</dd></div>
              <div><dt>Last event</dt><dd>{{ formatTime(overviewRoot.subLast) }}</dd></div>
            </dl>
          </section>
          <section v-if="run?.phases.length" class="run-details-narrative">
            <h2>Recorded phases</h2>
            <ol>
              <li v-for="phase in run.phases" :key="`${phase.ts}-${phase.title}`">
                <strong>{{ phase.title }}</strong><span>{{ formatTime(phase.ts, false) }}</span>
              </li>
            </ol>
          </section>
          <div v-if="run?.transcriptPath" class="run-details-path">
            <UIcon name="i-lucide-file-json" />
            <code :title="run.transcriptPath">{{ run.transcriptPath }}</code>
            <UButton type="button" color="neutral" variant="ghost" size="xs" icon="i-lucide-copy" aria-label="Copy transcript JSONL path" @click="copyTranscriptPath">Copy</UButton>
          </div>
        </div>
      </details>
    </template>
  </div>
</template>
