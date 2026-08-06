<script setup lang="ts">
import type { RunNodeWire } from '#shared/schemas/api'
import { normalizeSessionLabel } from '#shared/utils/session-label'
import { formatTime, sessionSourceLabel } from '~/utils/format'

const props = defineProps<{
  node: RunNodeWire
  depth: number
  selectedKey: string | null
}>()

const emit = defineEmits<{ select: [key: string] }>()
interface RunTreeItem {
  key: string
  label: string
  node: RunNodeWire
  slot: 'session'
  defaultExpanded: boolean
  class: Array<string | Record<string, boolean>>
  children: RunTreeItem[]
  onSelect: () => void
}

function statusLabel(node: RunNodeWire): string {
  if (node.spawnState === 'running' || node.subLive || (node.live && node.kind === 'subagent')) return 'running'
  if (node.subErrors) return `${node.subErrors} err`
  return ''
}

function metadata(node: RunNodeWire): string {
  const agentCount = Math.max(1, node.subAgents + 1)
  return [
    sessionSourceLabel(node.source),
    formatTime(node.subLast || node.lastTs, false),
    agentCount > 1 ? `${agentCount} agents` : '',
  ].filter(Boolean).join(' · ')
}

function toItem(node: RunNodeWire): RunTreeItem {
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
      <span
        class="tree-status"
        :class="[item.node.source, { running: item.node.subLive, error: item.node.subErrors && !item.node.subLive }]"
        :title="`${sessionSourceLabel(item.node.source)} · ${item.node.agentType || item.node.sourceDetail || 'Session'}`"
      >
        <UIcon :name="item.node.kind === 'subagent' ? 'i-lucide-bot' : 'i-lucide-message-square-code'" />
      </span>
      <span class="tree-content">
        <span class="tree-title-row">
          <span class="tree-title">{{ item.label }}</span>
        </span>
        <span class="tree-meta">{{ metadata(item.node) }}</span>
      </span>
      <span class="tree-trailing">
        <span
          v-if="statusLabel(item.node)"
          class="tree-end"
          :class="{ hot: item.node.subLive, error: item.node.subErrors && !item.node.subLive }"
        >
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
