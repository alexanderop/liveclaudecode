<script setup lang="ts">
import type { RunNode } from '#shared/types/run'

const props = defineProps<{
  node: RunNode
  depth: number
  selectedKey: string | null
}>()

const emit = defineEmits<{ select: [key: string] }>()
const expanded = ref(true)
const hasChildren = computed(() => props.node.children.length > 0)

const running = computed(() =>
  props.node.spawnState === 'running'
  || (props.node.live && props.node.kind === 'subagent'),
)

const statusLabel = computed(() => {
  if (running.value || props.node.subLive) return 'running'
  if (props.node.subErrors) return `${props.node.subErrors} err`
  return 'complete'
})

function handleClick(): void {
  emit('select', props.node.key)
  if (hasChildren.value) expanded.value = !expanded.value
}
</script>

<template>
  <div :class="{ kid: depth > 0 }">
    <button
      class="tree-node"
      :class="{ selected: selectedKey === node.key }"
      type="button"
      :aria-expanded="hasChildren ? expanded : undefined"
      @click="handleClick"
    >
      <span class="tree-status" :class="{ running: node.subLive, error: node.subErrors && !node.subLive }">
        <UIcon :name="node.kind === 'subagent' ? 'i-lucide-bot' : 'i-lucide-message-square-code'" />
      </span>
      <span class="tree-content">
        <span class="tree-title-row">
          <span class="tree-title">{{ node.label || node.key }}</span>
          <span class="source-tag" :class="node.source">
            {{ node.source === 'claude' ? 'Claude' : 'Codex' }}
          </span>
        </span>
        <span class="tree-meta">
          <span>{{ node.agentType || node.sourceDetail || (node.source === 'claude' ? 'Claude Code' : 'Codex') }}</span>
          <span aria-hidden="true">·</span>
          <span>{{ node.subTools }} tools</span>
          <span v-if="node.subAgents">· {{ node.subAgents }} agents</span>
          <span>· {{ formatDuration(node.firstTs, node.subLast) }}</span>
        </span>
        <span v-if="node.current" class="current-activity">
          {{ node.current.tool }} {{ node.current.summary.slice(0, 54) }}
        </span>
      </span>
      <span class="tree-trailing">
        <span class="tree-end" :class="{ hot: node.subLive, error: node.subErrors && !node.subLive }">
          {{ statusLabel }}
        </span>
        <UIcon
          v-if="hasChildren"
          class="tree-chevron"
          :class="{ expanded }"
          name="i-lucide-chevron-right"
          aria-hidden="true"
        />
      </span>
    </button>
    <div v-if="hasChildren" v-show="expanded" class="tree-children">
      <RunTreeNode
        v-for="child in node.children"
        :key="child.key"
        :node="child"
        :depth="depth + 1"
        :selected-key="selectedKey"
        @select="emit('select', $event)"
      />
    </div>
  </div>
</template>
