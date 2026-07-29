<script setup lang="ts">
import type { RunNode, RunResponse, TranscriptEvent } from '#shared/types/run'
import type { FeedDensity } from '~/composables/useLiveRuns'
import { normalizeSessionLabel } from '#shared/utils/session-label'

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
const activeTab = ref<InspectorTab>('activity')

const tabs = [
  { id: 'summary', label: 'Summary', icon: 'i-lucide-list-tree' },
  { id: 'activity', label: 'Activity', icon: 'i-lucide-activity' },
  { id: 'incidents', label: 'Incidents', icon: 'i-lucide-circle-alert' },
  { id: 'files', label: 'Files', icon: 'i-lucide-files' },
  { id: 'result', label: 'Result', icon: 'i-lucide-message-square-text' },
] as const

const status = computed(() => {
  if (!props.selected) return { label: 'Inactive', class: 'inactive' }
  if (props.selected.live) return { label: 'Active', class: 'active' }
  if (props.selected.spawnState === 'running') return { label: 'Blocked', class: 'blocked' }
  if (props.selected.errors) return { label: 'Failed', class: 'failed' }
  if (!props.selected.firstTs && !props.selected.lastTs && !props.selected.tools) return { label: 'Inactive', class: 'inactive' }
  return { label: 'Completed', class: 'completed' }
})
const displayLabel = computed(() => normalizeSessionLabel(props.selected?.label || '', 'Details'))
const toolMix = computed(() => Object.entries(props.selected?.toolCounts || {}).sort((a, b) => b[1] - a[1]).slice(0, 6))
const selectedDiagnostics = computed(() => props.run?.diagnostics.agents.find(agent => agent.key === props.selectedKey) || null)
const selectedOutcome = computed(() => props.run?.diagnostics.outcomes.find(outcome => outcome.childKey === props.selectedKey) || null)
const selectedIncidents = computed(() => (props.run?.diagnostics.incidents || []).filter(incident => incident.key === props.selectedKey))
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

watch(() => props.selectedKey, () => { activeTab.value = 'activity' })
watch(() => props.focusedFile, file => { if (file) activeTab.value = 'files' })
</script>

<template>
  <aside class="inspector" aria-label="Selected node details">
    <div class="inspector-title">
      <span><small>Selected agent</small><strong>{{ displayLabel }}</strong></span>
      <button type="button" class="inspector-close" aria-label="Close details" @click="emit('close')"><UIcon name="i-lucide-x" /></button>
    </div>

    <div v-if="run && root && selected" class="inspector-tabs" role="tablist" aria-label="Selected agent view">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        role="tab"
        :aria-selected="activeTab === tab.id"
        :class="{ selected: activeTab === tab.id }"
        :title="tab.label"
        @click="activeTab = tab.id"
      ><UIcon :name="tab.icon" /><span>{{ tab.label }}</span><b v-if="tab.id === 'incidents' && selectedIncidents.length">{{ selectedIncidents.length }}</b></button>
    </div>

    <div v-if="run && root && selected && activeTab === 'activity'" class="inspector-activity">
      <div class="session-panel-controls">
        <div class="segments" role="group" aria-label="Agent event detail">
          <button v-for="option in (['compact', 'normal', 'raw'] as const)" :key="option" type="button" :class="{ selected: density === option }" :aria-pressed="density === option" @click="emit('update:density', option)">{{ option }}</button>
        </div>
        <button type="button" class="quiet-action" :class="{ active: errorsOnly }" :aria-pressed="errorsOnly" @click="emit('update:errorsOnly', !errorsOnly)"><UIcon name="i-lucide-circle-alert" />Errors</button>
      </div>
      <div v-if="eventsLoading" class="inspector-activity-loading" aria-live="polite"><UIcon name="i-lucide-loader-circle" />Loading agent activity…</div>
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
        <div class="property-row"><span>Provider</span><strong class="property-value">{{ selected.source ? selected.source[0]?.toUpperCase() + selected.source.slice(1) : 'Not recorded' }}</strong></div>
        <div class="property-row"><span>Duration</span><strong class="property-value">{{ formatDuration(selected.firstTs, selected.lastTs) }}</strong></div>
        <div class="property-row"><span>Output</span><strong class="property-value">{{ selected.tokensOut ? `${formatCount(selected.tokensOut)} tokens` : 'Not recorded' }}</strong></div>
        <div v-if="selected.current" class="property-row current-summary"><span>{{ selected.current.tool }}</span><strong>{{ selected.current.summary }}</strong></div>
      </section>
      <section class="inspector-section">
        <div class="inspector-section-title"><span>Agents</span><span>{{ run.lanes.length }}</span></div>
        <div class="agent-list">
          <button v-for="lane in run.lanes" :key="lane.key" type="button" class="agent-row" :class="{ selected: lane.key === selectedKey }" :aria-current="lane.key === selectedKey ? 'true' : undefined" @click="emit('select', lane.key)">
            <span class="agent-avatar" :class="{ live: lane.live, error: lane.errors }"><UIcon :name="lane.depth ? 'i-lucide-bot' : 'i-lucide-terminal-square'" /></span>
            <span class="agent-copy"><strong>{{ normalizeSessionLabel(lane.label, lane.key) }}</strong><small>{{ lane.live ? 'Active now' : lane.spawnState === 'running' ? 'Blocked or waiting' : lane.errors ? `${lane.errors} errors` : `${lane.tools} tools` }}</small></span>
            <span v-if="lane.live" class="status-dot running" />
          </button>
        </div>
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
        <div class="property-row compact" :class="{ danger: selected.errors }"><span><UIcon name="i-lucide-circle-alert" />Errors</span><strong>{{ selected.errors }}</strong></div>
      </section>
    </div>

    <div v-else-if="run && selected && activeTab === 'incidents'" class="inspector-details inspector-list-tab">
      <button v-for="(incident, index) in selectedIncidents" :key="incident.id" type="button" class="inspector-list-row" :class="incident.severity" @click="focusIncident(index)">
        <UIcon :name="incident.severity === 'error' ? 'i-lucide-circle-alert' : 'i-lucide-triangle-alert'" />
        <span><strong>{{ incident.title }}</strong><small>{{ incident.detail }}</small><code>line {{ incident.line + 1 }} · {{ formatTime(incident.ts) }}</code></span>
      </button>
      <div v-if="!selectedIncidents.length" class="inspector-empty"><UIcon name="i-lucide-circle-check" /><span>No incidents recorded for this agent.</span></div>
    </div>

    <div v-else-if="run && selected && activeTab === 'files'" class="inspector-details inspector-list-tab">
      <button v-for="file in selectedFiles" :key="file.path" type="button" class="inspector-list-row file" :class="{ selected: focusedFile === file.path }" @click="emit('focus-file', focusedFile === file.path ? null : file.path)">
        <UIcon name="i-lucide-file-code-2" /><span><strong :title="file.path">{{ file.path }}</strong><small>{{ file.ops }} operations <template v-if="file.added || file.removed">· +{{ file.added }} −{{ file.removed }}</template></small></span>
      </button>
      <div v-if="!selectedFiles.length" class="inspector-empty"><UIcon name="i-lucide-files" /><span>No file changes recorded for this agent.</span></div>
    </div>

    <div v-else-if="run && selected && activeTab === 'result'" class="inspector-details inspector-result">
      <section><span class="section-eyebrow">Prompt</span><pre>{{ promptEvent?.body || 'No prompt event was recorded.' }}</pre></section>
      <section><span class="section-eyebrow">Final result</span><div class="result-copy">{{ selected.finalText || lastText?.body || 'No final result was recorded.' }}</div></section>
    </div>

    <div v-else class="inspector-empty"><UIcon name="i-lucide-panel-right" /><span>Session properties will appear here.</span></div>
  </aside>
</template>
