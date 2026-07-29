<script setup lang="ts">
import type { RunNode } from '#shared/types/run'
import { normalizeSessionLabel } from '#shared/utils/session-label'

const props = defineProps<{
  node: RunNode
  depth: number
  selectedKey: string | null
}>()

const emit = defineEmits<{ select: [key: string] }>()
interface RunTreeItem {
  key: string
  label: string
  node: RunNode
  slot: 'session'
  defaultExpanded: boolean
  class: Array<string | Record<string, boolean>>
  children: RunTreeItem[]
  onSelect: () => void
}

function sourceLabel(node: RunNode): string {
  return node.source === 'claude' ? 'Claude' : node.source === 'codex' ? 'Codex' : 'Copilot'
}

function statusLabel(node: RunNode): string {
  if (node.spawnState === 'running' || node.subLive || (node.live && node.kind === 'subagent')) return 'running'
  if (node.subErrors) return `${node.subErrors} err`
  return 'complete'
}

function toItem(node: RunNode): RunTreeItem {
  return {
    key: node.key,
    label: normalizeSessionLabel(node.label, node.key),
    node,
    slot: 'session',
    defaultExpanded: true,
    class: ['tree-node', { selected: props.selectedKey === node.key }],
    children: node.children.map(toItem),
    onSelect: () => emit('select', node.key),
  }
}

const items = computed(() => [toItem(props.node)])
const selectedItem = computed(() => {
  const visit = (entries: RunTreeItem[]): RunTreeItem | undefined => {
    for (const item of entries) {
      if (item.node.key === props.selectedKey) return item
      const child = visit(item.children)
      if (child) return child
    }
  }
  return visit(items.value)
})
</script>

<template>
  <UTree
    :items="items"
    :model-value="selectedItem"
    :get-key="item => item.key"
    :aria-label="depth ? 'Agent subtree' : 'Session agents'"
    :ui="{ listWithChildren: 'tree-children', itemWithChildren: 'tree-child' }"
  >
    <template #session="{ item, expanded }">
      <span class="tree-status" :class="{ running: item.node.subLive, error: item.node.subErrors && !item.node.subLive }">
        <UIcon :name="item.node.kind === 'subagent' ? 'i-lucide-bot' : 'i-lucide-message-square-code'" />
      </span>
      <span class="tree-content">
        <span class="tree-title-row">
          <span class="tree-title">{{ item.label }}</span>
          <span class="source-tag" :class="item.node.source">
            {{ sourceLabel(item.node) }}
          </span>
        </span>
        <span class="tree-meta">
          <span>{{ item.node.agentType || item.node.sourceDetail || sourceLabel(item.node) }}</span>
          <span aria-hidden="true">·</span>
          <span>{{ item.node.subTools }} tools</span>
          <span v-if="item.node.subAgents">· {{ item.node.subAgents }} agents</span>
          <span>· {{ formatDuration(item.node.firstTs, item.node.subLast) }}</span>
        </span>
        <span v-if="item.node.current" class="current-activity">
          {{ item.node.current.tool }} {{ item.node.current.summary.slice(0, 54) }}
        </span>
      </span>
      <span class="tree-trailing">
        <span class="tree-end" :class="{ hot: item.node.subLive, error: item.node.subErrors && !item.node.subLive }">
          {{ statusLabel(item.node) }}
        </span>
        <UIcon
          v-if="item.children.length"
          class="tree-chevron"
          :class="{ expanded }"
          name="i-lucide-chevron-right"
          aria-hidden="true"
        />
      </span>
    </template>
  </UTree>
</template>
