<script setup lang="ts">
import type { RunNode, RunResponse, TranscriptEvent } from '#shared/types/run'
import type { FeedDensity } from '~/composables/useLiveRuns'
import { normalizeSessionLabel } from '#shared/utils/session-label'
import { flattenRunTree } from '~/utils/execution-analysis'
import { agentState } from '~/utils/session-state'

const props = defineProps<{
  run: RunResponse | null
  root: RunNode | null
  selected: RunNode | null
  selectedKey: string | null
  events: TranscriptEvent[]
  eventsLoading: boolean
  density: FeedDensity
  errorsOnly: boolean
  followOutput: boolean
  currentTime?: number | null
  focusedLine?: number | null
  focusedFile?: string | null
}>()

const emit = defineEmits<{
  select: [key: string]
  close: []
  'update:density': [density: FeedDensity]
  'update:errorsOnly': [errorsOnly: boolean]
  'focus-time': [timestamp: number | null, line: number | null]
  'focus-file': [path: string | null]
}>()
type InspectorTab = 'summary' | 'activity' | 'incidents' | 'files' | 'result'
const activeTab = ref<InspectorTab>('summary')

const tabs = [
  { id: 'summary', label: 'Summary', icon: 'i-lucide-list-tree' },
  { id: 'activity', label: 'Activity', icon: 'i-lucide-activity' },
  { id: 'incidents', label: 'Incidents', icon: 'i-lucide-circle-alert' },
  { id: 'files', label: 'Files', icon: 'i-lucide-files' },
  { id: 'result', label: 'Result', icon: 'i-lucide-message-square-text' },
] as const
const inspectorTabs = computed(() => tabs.map(tab => ({
  ...tab,
  value: tab.id,
  badge: tab.id === 'incidents' && selectedIncidents.value.length
    ? { label: String(selectedIncidents.value.length), color: 'error' as const, variant: 'soft' as const }
    : undefined,
})))

const status = computed(() => {
  const summary = agentState(props.selected, props.run?.diagnostics.incidents)
  return { label: summary.label, class: summary.state }
})
const displayLabel = computed(() => normalizeSessionLabel(props.selected?.label || '', 'Details'))
const toolMix = computed(() => Object.entries(props.selected?.toolCounts || {}).sort((a, b) => b[1] - a[1]).slice(0, 6))
const selectedDiagnostics = computed(() => props.run?.diagnostics.agents.find(agent => agent.key === props.selectedKey) || null)
const selectedOutcome = computed(() => props.run?.diagnostics.outcomes.find(outcome => outcome.childKey === props.selectedKey) || null)
const selectedIncidents = computed(() => (props.run?.diagnostics.incidents || []).filter(incident => incident.key === props.selectedKey))
const agentIndex = computed(() => new Map(flattenRunTree(props.root).map(node => [node.key, node])))
const selectedChanges = computed(() => (props.run?.diagnostics.changes || []).filter(change => change.key === props.selectedKey))
const selectedFiles = computed(() => {
  const files = new Map<string, { path: string, ops: number, added: number, removed: number }>()
  for (const file of props.selected?.files || []) files.set(file.path, { path: file.path, ops: file.ops, added: 0, removed: 0 })
  for (const change of selectedChanges.value) {
    const file = files.get(change.path) || { path: change.path, ops: 0, added: 0, removed: 0 }
    file.ops += 1
    file.added += change.linesAdded
    file.removed += change.linesRemoved
    files.set(change.path, file)
  }
  return [...files.values()].sort((a, b) => b.ops - a.ops || a.path.localeCompare(b.path))
})
const promptEvent = computed(() => props.events.find(event => event.kind === 'prompt'))
const lastText = computed(() => [...props.events].reverse().find(event => event.kind === 'text'))

function focusIncident(index: number): void {
  const incident = selectedIncidents.value[index]
  if (!incident) return
  activeTab.value = 'activity'
  emit('focus-time', incident.ts ? Date.parse(incident.ts) : null, incident.line)
}

function focusEventTime(timestamp: number | null, line: number): void {
  emit('focus-time', timestamp, line)
}

function agentSummary(key: string): ReturnType<typeof agentState> {
  return agentState(agentIndex.value.get(key), props.run?.diagnostics.incidents)
}

watch(() => props.selectedKey, () => { activeTab.value = 'summary' })
watch(() => props.focusedFile, file => { if (file) activeTab.value = 'files' })
</script>

<template>
  <aside class="inspector" aria-label="Selected node details">
    <div class="inspector-title">
      <span><small>Selected agent</small><strong>{{ displayLabel }}</strong></span>
      <UButton class="inspector-close" color="neutral" variant="ghost" icon="i-lucide-x" aria-label="Close details" @click="emit('close')" />
    </div>

    <UTabs
      v-if="run && root && selected"
      v-model="activeTab"
      class="inspector-tabs"
      :items="inspectorTabs"
      :content="false"
      color="neutral"
      variant="link"
      size="xs"
      aria-label="Selected agent view"
    />

    <div v-if="run && root && selected && activeTab === 'activity'" class="inspector-activity">
      <div class="session-panel-controls">
        <div class="segments" role="group" aria-label="Agent event detail">
          <button v-for="option in (['compact', 'normal', 'raw'] as const)" :key="option" type="button" :class="{ selected: density === option }" :aria-pressed="density === option" @click="emit('update:density', option)">{{ option }}</button>
        </div>
        <button type="button" class="quiet-action" :class="{ active: errorsOnly }" :aria-pressed="errorsOnly" @click="emit('update:errorsOnly', !errorsOnly)"><UIcon name="i-lucide-circle-alert" />Errors</button>
      </div>
      <UEmpty
        v-if="eventsLoading"
        class="inspector-activity-loading"
        loading
        title="Loading agent activity…"
        variant="naked"
        aria-live="polite"
      />
      <EventFeed
        v-else
        :events="events"
        :density="density"
        :errors-only="errorsOnly"
        :follow-output="followOutput"
        :selected-line="focusedLine"
        :as-of="currentTime"
        @select="emit('select', $event)"
        @focus-time="focusEventTime"
      />
    </div>

    <div v-else-if="run && root && selected && activeTab === 'summary'" class="inspector-details">
      <section class="property-group">
        <div class="property-row"><span>Status</span><strong class="property-value status-value" :class="status.class"><span class="status-dot" :class="status.class" />{{ status.label }}</strong></div>
        <div class="property-row"><span>Role</span><strong class="property-value"><UIcon name="i-lucide-bot" />{{ selected.agentType || 'Main session' }}</strong></div>
        <div class="property-row"><span>Duration</span><strong class="property-value">{{ formatDuration(selected.firstTs, selected.lastTs) }}</strong></div>
        <div v-if="selected.current" class="property-row current-summary"><span>{{ selected.current.tool }}</span><strong>{{ selected.current.summary }}</strong></div>
      </section>
      <details class="inspector-disclosure">
        <summary>
          <span><UIcon name="i-lucide-users" />All agents</span>
          <span>{{ run.lanes.length }}<UIcon class="disclosure-chevron" name="i-lucide-chevron-down" /></span>
        </summary>
        <section class="inspector-section disclosure-content">
          <div class="agent-list">
            <button v-for="lane in run.lanes" :key="lane.key" type="button" class="agent-row" :class="{ selected: lane.key === selectedKey }" :aria-current="lane.key === selectedKey ? 'true' : undefined" @click="emit('select', lane.key)">
              <span class="agent-avatar" :class="agentSummary(lane.key).state"><UIcon :name="lane.depth ? 'i-lucide-bot' : 'i-lucide-terminal-square'" /></span>
              <span class="agent-copy"><strong>{{ normalizeSessionLabel(lane.label, lane.key) }}</strong><small>{{ agentSummary(lane.key).label }} · {{ lane.tools }} tools</small></span>
              <span v-if="lane.live" class="status-dot running" />
            </button>
          </div>
        </section>
      </details>
      <details class="inspector-disclosure">
        <summary>
          <span><UIcon name="i-lucide-settings-2" />Technical details</span>
          <UIcon class="disclosure-chevron" name="i-lucide-chevron-down" />
        </summary>
        <div class="disclosure-content">
          <section class="inspector-section">
            <div class="property-row compact"><span>Provider</span><strong>{{ selected.source ? selected.source[0]?.toUpperCase() + selected.source.slice(1) : 'Not recorded' }}</strong></div>
            <div class="property-row compact"><span>Output</span><strong>{{ selected.tokensOut ? `${formatCount(selected.tokensOut)} tokens` : 'Not recorded' }}</strong></div>
          </section>
          <section v-if="toolMix.length" class="inspector-section"><div class="inspector-section-title"><span>Tool activity</span></div><div class="tool-list"><span v-for="[tool, count] in toolMix" :key="tool" class="tool-chip">{{ tool }} <strong>{{ count }}</strong></span></div></section>
          <section v-if="selectedDiagnostics" class="inspector-section">
            <div class="inspector-section-title"><span>Runtime diagnostics</span></div>
            <div class="property-row compact"><span><UIcon name="i-lucide-cpu" />Model</span><strong>{{ selectedDiagnostics.models.join(', ') || selected.model || 'Unknown' }}</strong></div>
            <div class="property-row compact"><span><UIcon name="i-lucide-brain-circuit" />Cache read</span><strong>{{ formatCount(selectedDiagnostics.usage.cr) }}</strong></div>
            <div class="property-row compact"><span><UIcon name="i-lucide-git-branch" />Causal branches</span><strong>{{ selectedDiagnostics.branchPoints }}</strong></div>
            <div v-if="selectedOutcome" class="property-row compact"><span><UIcon name="i-lucide-timer" />Native duration</span><strong>{{ formatMilliseconds(selectedOutcome.durationMs) }}</strong></div>
            <div v-if="selected.stoppedByUser" class="property-row compact danger"><span><UIcon name="i-lucide-circle-stop" />Stopped by user</span><strong>Yes</strong></div>
          </section>
          <section class="inspector-section">
            <div class="inspector-section-title"><span>Artifacts</span></div>
            <div class="property-row compact"><span><UIcon name="i-lucide-files" />Files changed</span><strong>{{ selected.files.length }}</strong></div>
            <div class="property-row compact"><span><UIcon name="i-lucide-square-terminal" />Commands</span><strong>{{ selected.commands.length }}</strong></div>
            <div class="property-row compact"><span><UIcon name="i-lucide-wrench" />Tool calls</span><strong>{{ selected.tools }}</strong></div>
            <div class="property-row compact" :class="{ danger: selected.errors }"><span><UIcon name="i-lucide-circle-alert" />Tool errors</span><strong>{{ selected.errors }}</strong></div>
          </section>
        </div>
      </details>
    </div>

    <div v-else-if="run && selected && activeTab === 'incidents'" class="inspector-details inspector-list-tab">
      <button v-for="(incident, index) in selectedIncidents" :key="incident.id" type="button" class="inspector-list-row" :class="incident.severity" @click="focusIncident(index)">
        <UIcon :name="incident.severity === 'error' ? 'i-lucide-circle-alert' : 'i-lucide-triangle-alert'" />
        <span><strong>{{ incident.title }}</strong><small>{{ incident.detail }}</small><code>line {{ incident.line + 1 }} · {{ formatTime(incident.ts) }}</code></span>
      </button>
      <UEmpty v-if="!selectedIncidents.length" class="inspector-empty" icon="i-lucide-circle-check" title="No incidents recorded for this agent" variant="naked" />
    </div>

    <div v-else-if="run && selected && activeTab === 'files'" class="inspector-details inspector-list-tab">
      <button v-for="file in selectedFiles" :key="file.path" type="button" class="inspector-list-row file" :class="{ selected: focusedFile === file.path }" @click="emit('focus-file', focusedFile === file.path ? null : file.path)">
        <UIcon name="i-lucide-file-code-2" /><span><strong :title="file.path">{{ file.path }}</strong><small>{{ file.ops }} operations <template v-if="file.added || file.removed">· +{{ file.added }} −{{ file.removed }}</template></small></span>
      </button>
      <UEmpty v-if="!selectedFiles.length" class="inspector-empty" icon="i-lucide-files" title="No file changes recorded for this agent" variant="naked" />
    </div>

    <div v-else-if="run && selected && activeTab === 'result'" class="inspector-details inspector-result">
      <section><span class="section-eyebrow">Prompt</span><pre>{{ promptEvent?.body || 'No prompt event was recorded.' }}</pre></section>
      <section><span class="section-eyebrow">Final result</span><div class="result-copy">{{ selected.finalText || lastText?.body || 'No final result was recorded.' }}</div></section>
    </div>

    <UEmpty v-else class="inspector-empty" icon="i-lucide-panel-right" title="Session properties will appear here" variant="naked" />
  </aside>
</template>
