<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core'
import { formatDuration } from '~/utils/format'
import {
  executionStateLabel,
  type ExecutionNodeData,
} from '~/utils/execution-graph'
import { useExecutionCanvas } from '~/composables/useExecutionCanvas'

const props = defineProps<{
  id: string
  data: ExecutionNodeData
  selected: boolean
}>()

const { layoutDirection, selectNode } = useExecutionCanvas()

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  selectNode(props.id)
}
</script>

<template>
  <div
    class="sketch-node"
    :class="[data.state, { root: data.root, selected, overview: data.overview }]"
    role="button"
    tabindex="0"
    :aria-pressed="selected"
    :aria-current="selected ? 'true' : undefined"
    :aria-label="`${data.label}, ${executionStateLabel(data.state)}. Open details.`"
    @keydown="handleKeydown"
  >
    <Handle
      type="target"
      :position="layoutDirection === 'left-to-right' ? Position.Left : Position.Top"
      :connectable="false"
    />
    <div class="sketch-node-head">
      <span v-if="data.overview" class="sketch-workstream">
        {{ data.root ? 'Start' : `Workstream ${data.workstream}` }}
      </span>
      <span class="sketch-agent-icon">
        <UIcon :name="data.root ? 'i-lucide-message-square-code' : 'i-lucide-bot'" />
      </span>
      <span class="sketch-agent-type">{{ data.agentType }}</span>
      <span class="sketch-state">
        <span class="status-dot" :class="data.state" />
        {{ executionStateLabel(data.state) }}
      </span>
    </div>
    <strong :title="data.label">{{ data.label }}</strong>
    <div v-if="data.overview" class="sketch-overview-stats">
      <span><b>{{ data.agents }}</b>{{ data.agents === 1 ? 'agent' : 'agents' }}</span>
      <span><b>{{ data.tools }}</b>tools</span>
      <span :class="{ bad: data.errors }"><b>{{ data.errors }}</b>errors</span>
    </div>
    <div class="sketch-node-meta">
      <span><UIcon name="i-lucide-wrench" />{{ data.tools }}</span>
      <span v-if="!data.overview"><UIcon name="i-lucide-files" />{{ data.files }}</span>
      <span><UIcon name="i-lucide-clock-3" />{{ formatDuration(data.firstTs, data.lastTs) }}</span>
    </div>
    <Handle
      type="source"
      :position="layoutDirection === 'left-to-right' ? Position.Right : Position.Bottom"
      :connectable="false"
    />
  </div>
</template>
