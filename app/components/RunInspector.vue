<script setup lang="ts">
import type { RunNode, RunResponse } from '#shared/types/run'

const props = defineProps<{
  run: RunResponse | null
  root: RunNode | null
  selected: RunNode | null
  selectedKey: string | null
}>()

const emit = defineEmits<{ select: [key: string] }>()

const status = computed(() => {
  if (!props.root) return { label: '—', class: '' }
  if (props.root.subLive) return { label: 'Running', class: 'running' }
  if (props.root.subErrors) return { label: 'Needs attention', class: 'failed' }
  return { label: 'Complete', class: 'complete' }
})

const toolMix = computed(() =>
  Object.entries(props.run?.node.toolCounts || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6),
)

const selectedDiagnostics = computed(() =>
  props.run?.diagnostics.agents.find(agent => agent.key === props.selectedKey) || null,
)

const selectedOutcome = computed(() =>
  props.run?.diagnostics.outcomes.find(outcome => outcome.childKey === props.selectedKey) || null,
)
</script>

<template>
  <aside class="inspector">
    <div class="inspector-title">
      <span>Properties</span>
    </div>

    <template v-if="run && root && selected">
      <section class="property-group">
        <div class="property-row">
          <span>Status</span>
          <strong class="property-value status-value" :class="status.class">
            <span class="status-dot" :class="status.class" />{{ status.label }}
          </strong>
        </div>
        <div class="property-row">
          <span>Viewing</span>
          <strong class="property-value"><UIcon name="i-lucide-bot" />{{ selected.agentType || 'Main session' }}</strong>
        </div>
        <div class="property-row">
          <span>Duration</span>
          <strong class="property-value">{{ formatDuration(root.firstTs, root.subLast) }}</strong>
        </div>
        <div class="property-row">
          <span>Output</span>
          <strong class="property-value">{{ formatCount(root.tokensOut) }} tokens</strong>
        </div>
      </section>

      <section class="inspector-section">
        <div class="inspector-section-title">
          <span>Agents</span>
          <span>{{ run.lanes.length }}</span>
        </div>
        <div class="agent-list">
          <button
            v-for="lane in run.lanes"
            :key="lane.key"
            type="button"
            class="agent-row"
            :class="{ selected: lane.key === selectedKey }"
            :aria-current="lane.key === selectedKey ? 'true' : undefined"
            @click="emit('select', lane.key)"
          >
            <span class="agent-avatar" :class="{ live: lane.live, error: lane.errors }">
              <UIcon :name="lane.depth ? 'i-lucide-bot' : 'i-lucide-terminal-square'" />
            </span>
            <span class="agent-copy">
              <strong>{{ lane.label }}</strong>
              <small>{{ lane.live ? 'Working now' : lane.errors ? `${lane.errors} errors` : `${lane.tools} tools` }}</small>
            </span>
            <span v-if="lane.live" class="status-dot running" />
          </button>
        </div>
      </section>

      <section v-if="toolMix.length" class="inspector-section">
        <div class="inspector-section-title"><span>Tool activity</span></div>
        <div class="tool-list">
          <span v-for="[tool, count] in toolMix" :key="tool" class="tool-chip">
            {{ tool }} <strong>{{ count }}</strong>
          </span>
        </div>
      </section>

      <section v-if="selectedDiagnostics" class="inspector-section">
        <div class="inspector-section-title"><span>Runtime diagnostics</span></div>
        <div class="property-row compact">
          <span><UIcon name="i-lucide-cpu" /> Model</span>
          <strong :title="selectedDiagnostics.models.join(', ')">{{ selectedDiagnostics.models.join(', ') || selected.model || 'Unknown' }}</strong>
        </div>
        <div class="property-row compact">
          <span><UIcon name="i-lucide-brain-circuit" /> Cache read</span>
          <strong>{{ formatCount(selectedDiagnostics.usage.cr) }}</strong>
        </div>
        <div class="property-row compact">
          <span><UIcon name="i-lucide-git-branch" /> Causal branches</span>
          <strong>{{ selectedDiagnostics.branchPoints }}</strong>
        </div>
        <div v-if="selectedOutcome" class="property-row compact">
          <span><UIcon name="i-lucide-timer" /> Native duration</span>
          <strong>{{ formatMilliseconds(selectedOutcome.durationMs) }}</strong>
        </div>
        <div v-if="selected.stoppedByUser" class="property-row compact danger">
          <span><UIcon name="i-lucide-circle-stop" /> Stopped by user</span>
          <strong>Yes</strong>
        </div>
      </section>

      <section class="inspector-section">
        <div class="inspector-section-title"><span>Artifacts</span></div>
        <div class="property-row compact">
          <span><UIcon name="i-lucide-files" /> Files changed</span>
          <strong>{{ run.files.length }}</strong>
        </div>
        <div class="property-row compact">
          <span><UIcon name="i-lucide-square-terminal" /> Commands</span>
          <strong>{{ selected.commands.length }}</strong>
        </div>
        <div class="property-row compact">
          <span><UIcon name="i-lucide-wrench" /> Tool calls</span>
          <strong>{{ selected.tools }}</strong>
        </div>
        <div class="property-row compact" :class="{ danger: selected.errors }">
          <span><UIcon name="i-lucide-circle-alert" /> Errors</span>
          <strong>{{ selected.errors }}</strong>
        </div>
      </section>
    </template>

    <div v-else class="inspector-empty">
      <UIcon name="i-lucide-panel-right" />
      <span>Session properties will appear here.</span>
    </div>
  </aside>
</template>
