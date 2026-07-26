<script setup lang="ts">
import {
  Handle,
  Position,
  VueFlow,
  useVueFlow,
  type Edge,
  type GraphNode,
  type Node,
  type NodeMouseEvent,
  type XYPosition,
} from '@vue-flow/core'
import { Background, BackgroundVariant } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import type { RunResponse } from '#shared/types/run'
import {
  buildExecutionGraph,
  type ExecutionDirection,
  type ExecutionDetail,
  type ExecutionNodeData,
} from '~/utils/execution-graph'

const props = defineProps<{
  run: RunResponse | null
  selectedKey: string | null
}>()

const emit = defineEmits<{ select: [key: string] }>()
const nodes = shallowRef<Array<Node<ExecutionNodeData>>>([])
const edges = shallowRef<Edge[]>([])
const layoutDirection = ref<ExecutionDirection>('left-to-right')
const displayMode = ref<ExecutionDetail>('overview')
const { fitView, onNodesInitialized } = useVueFlow('execution-canvas')

function refreshGraph(preservePositions = true): void {
  const previousPositions = preservePositions
    ? new Map<string, XYPosition>(nodes.value.map(node => [node.id, { ...node.position }]))
    : new Map<string, XYPosition>()
  const graph = buildExecutionGraph(
    props.run?.lanes || [],
    props.selectedKey,
    previousPositions,
    layoutDirection.value,
    displayMode.value,
  )
  nodes.value = graph.nodes
  edges.value = graph.edges
}

function setLayout(direction: ExecutionDirection): void {
  if (layoutDirection.value === direction) return
  layoutDirection.value = direction
  refreshGraph(false)
  void refit()
}

function setDisplayMode(mode: ExecutionDetail): void {
  if (displayMode.value === mode) return
  displayMode.value = mode
  refreshGraph(false)
  void refit()
}

function handleNodeClick({ node }: NodeMouseEvent): void {
  emit('select', node.id)
}

function miniMapColor(node: GraphNode<ExecutionNodeData>): string {
  if (node.data.state === 'live') return '#63bd88'
  if (node.data.state === 'error') return '#bd666d'
  if (node.data.root) return '#9384d8'
  return '#77717f'
}

async function refit(): Promise<void> {
  await nextTick()
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  const focusKey = props.selectedKey || props.run?.key
  const focusNodes = displayMode.value === 'overview'
    ? nodes.value.map(node => node.id)
    : focusKey
    ? [
        focusKey,
        ...edges.value
          .filter(edge => edge.target === focusKey)
          .map(edge => edge.source)
          .slice(0, 1),
        ...edges.value
          .filter(edge => edge.source === focusKey)
          .map(edge => edge.target)
          .slice(0, 4),
      ]
    : nodes.value.slice(0, 5).map(node => node.id)

  await fitView({
    nodes: [...new Set(focusNodes)],
    padding: displayMode.value === 'overview'
      ? { top: '95px', right: '8%', bottom: '8%', left: '8%' }
      : 0.25,
    duration: 250,
    minZoom: 0.55,
    maxZoom: 1.05,
  })
}

watch(
  () => props.run?.lanes,
  () => refreshGraph(),
  { immediate: true, deep: true },
)

watch(
  () => props.selectedKey,
  selectedKey => nodes.value.forEach((node) => {
    if (node.data) node.data.selected = node.id === selectedKey
  }),
)

onNodesInitialized(() => void refit())
</script>

<template>
  <div class="canvas-view">
    <div v-if="!run" class="empty-state">
      <span class="empty-state-icon"><UIcon name="i-lucide-workflow" /></span>
      <h2>No session selected</h2>
      <p>Choose a session to explore its agent canvas.</p>
    </div>

    <template v-else>
      <div class="canvas-heading">
        <div class="canvas-title">
          <span class="section-eyebrow">Agent canvas</span>
          <strong>Execution graph</strong>
          <span v-if="displayMode === 'overview'">
            {{ Math.max(nodes.length - 1, 0) }} workstreams · {{ run.lanes.length }} agents
          </span>
          <span v-else>{{ nodes.length }} {{ nodes.length === 1 ? 'agent' : 'agents' }}</span>
        </div>
        <div class="canvas-toolbar">
          <div class="canvas-layout" aria-label="Graph detail">
            <button
              type="button"
              :class="{ selected: displayMode === 'overview' }"
              :aria-pressed="displayMode === 'overview'"
              title="Group nested agents into readable workstreams"
              @click="setDisplayMode('overview')"
            >
              <UIcon name="i-lucide-scan" />
              <span>Overview</span>
            </button>
            <button
              type="button"
              :class="{ selected: displayMode === 'all-agents' }"
              :aria-pressed="displayMode === 'all-agents'"
              title="Show every individual agent"
              @click="setDisplayMode('all-agents')"
            >
              <UIcon name="i-lucide-list-tree" />
              <span>All agents</span>
            </button>
          </div>
          <div class="canvas-layout" aria-label="Graph direction">
            <button
              type="button"
              :class="{ selected: layoutDirection === 'left-to-right' }"
              :aria-pressed="layoutDirection === 'left-to-right'"
              title="Lay out agents from left to right"
              @click="setLayout('left-to-right')"
            >
              <UIcon name="i-lucide-arrow-right" />
              <span>Left to right</span>
            </button>
            <button
              type="button"
              :class="{ selected: layoutDirection === 'top-to-bottom' }"
              :aria-pressed="layoutDirection === 'top-to-bottom'"
              title="Lay out agents from top to bottom"
              @click="setLayout('top-to-bottom')"
            >
              <UIcon name="i-lucide-arrow-down" />
              <span>Top to bottom</span>
            </button>
          </div>
        </div>
      </div>

      <VueFlow
        id="execution-canvas"
        v-model:nodes="nodes"
        v-model:edges="edges"
        class="execution-canvas"
        :min-zoom="0.2"
        :max-zoom="2"
        :nodes-connectable="false"
        :edges-updatable="false"
        :zoom-on-double-click="false"
        fit-view-on-init
        @node-click="handleNodeClick"
      >
        <Background
          :variant="BackgroundVariant.Dots"
          pattern-color="#3d3a43"
          :gap="22"
          :size="1.15"
        />

        <template #node-agent="{ data }">
          <div
            class="sketch-node"
            :class="[data.state, { root: data.root, selected: data.selected, overview: data.overview }]"
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
                <span class="status-dot" :class="{ running: data.state === 'live' }" />
                {{ data.state === 'live' ? 'Running' : data.state === 'error' ? 'Error' : 'Done' }}
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

        <MiniMap
          v-if="nodes.length > 4 && displayMode === 'all-agents'"
          position="bottom-right"
          :node-color="miniMapColor"
          :pannable="true"
          :zoomable="true"
          mask-color="rgb(14 14 15 / 68%)"
        />
        <Controls
          position="bottom-left"
          :show-interactive="false"
        />
      </VueFlow>
    </template>
  </div>
</template>
