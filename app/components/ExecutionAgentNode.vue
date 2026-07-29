<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core'
import {
  type ExecutionNodeData,
} from '~/utils/execution-graph'
import { agentDisplayStateLabel } from '~/utils/session-state'
import { useExecutionCanvas } from '~/composables/useExecutionCanvas'

const props = defineProps<{
  id: string
  data: ExecutionNodeData
  selected: boolean
}>()

const { layoutDirection, selectNode, toggleNode } = useExecutionCanvas()

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  selectNode(props.id)
}

</script>

<template>
  <div
    class="sketch-node"
    :class="[data.state, {
      root: data.root,
      selected,
      overview: data.overview,
      muted: data.muted,
      'on-path': data.onPath,
      collision: data.collision,
      critical: data.critical,
      bottleneck: data.bottleneck,
      'focused-file': data.focusedFile,
      [`display-${data.displayState}`]: true,
    }]"
    role="button"
    tabindex="0"
    :aria-pressed="selected"
    :aria-current="selected ? 'true' : undefined"
    :aria-label="`${data.label}, ${agentDisplayStateLabel(data.displayState)}. Open details.`"
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
        <span class="status-dot" :class="data.displayState" />
        {{ agentDisplayStateLabel(data.displayState) }}
      </span>
    </div>
    <strong :title="data.label">{{ data.label }}</strong>
    <p class="sketch-node-summary" :title="data.summary">
      <span v-if="data.currentTool">{{ data.currentTool }}</span>{{ data.summary }}
    </p>
    <div v-if="data.issues || data.collision || data.bottleneck || data.critical" class="sketch-signals">
      <span v-if="data.issues" class="bad"><UIcon name="i-lucide-circle-alert" />{{ data.issues }}</span>
      <span v-if="data.collision" class="warn"><UIcon name="i-lucide-files" />collision</span>
      <span v-if="data.bottleneck"><UIcon name="i-lucide-git-fork" />fan-out</span>
      <span v-if="data.critical"><UIcon name="i-lucide-route" />critical</span>
    </div>
    <div v-if="data.overview" class="sketch-overview-stats">
      <span><b>{{ data.agents }}</b>{{ data.agents === 1 ? 'agent' : 'agents' }}</span>
    </div>
    <div v-if="data.collapsible" class="sketch-node-actions">
      <button
        type="button"
        class="sketch-collapse"
        :aria-label="data.collapsed ? 'Expand workstream' : 'Collapse workstream'"
        :title="data.collapsed ? 'Expand workstream' : 'Collapse workstream'"
        @click.stop="toggleNode(id)"
      >
        <UIcon :name="data.collapsed ? 'i-lucide-chevrons-out' : 'i-lucide-chevrons-in'" />
      </button>
    </div>
    <Handle
      type="source"
      :position="layoutDirection === 'left-to-right' ? Position.Right : Position.Bottom"
      :connectable="false"
    />
  </div>
</template>
