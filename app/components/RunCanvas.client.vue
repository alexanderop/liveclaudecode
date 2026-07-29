<script setup lang="ts">
import {
  VueFlow,
  useVueFlow,
  type GraphNode,
  type NodeDragEvent,
  type NodeMouseEvent,
  type ViewportTransform,
  type XYPosition,
} from '@vue-flow/core'
import { Background, BackgroundVariant } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  provide,
  ref,
  shallowRef,
  watch,
} from 'vue'
import type { RunResponse } from '#shared/types/run'
import ExecutionAgentNode from '~/components/ExecutionAgentNode.vue'
import { ExecutionCanvasKey } from '~/composables/useExecutionCanvas'
import {
  buildExecutionGraph,
  DEFAULT_EXECUTION_DETAIL,
  executionStateLabel,
  type ExecutionDirection,
  type ExecutionDetail,
  type ExecutionNodeData,
} from '~/utils/execution-graph'
import { structuralComputed, structurallyEqual } from '~/utils/structural-computed'

const props = defineProps<{
  run: RunResponse | null
  selectedKey: string | null
}>()

const emit = defineEmits<{
  select: [key: string]
  deselect: []
}>()

const canvasView = ref<HTMLElement | null>(null)
const layoutDirection = ref<ExecutionDirection>('left-to-right')
const displayMode = ref<ExecutionDetail>(DEFAULT_EXECUTION_DETAIL)
const positionOverrides = shallowRef<ReadonlyMap<string, XYPosition>>(new Map())
const pendingFit = ref(false)
const canvasReady = ref(false)
const announcement = ref('')
const storedViewports = new Map<string, ViewportTransform>()
let fitWhenVisible = false
let previousStates = new Map<string, ExecutionNodeData['state']>()

const graph = structuralComputed(
  () => buildExecutionGraph(
    props.run?.lanes || [],
    positionOverrides.value,
    layoutDirection.value,
    displayMode.value,
  ),
  structurallyEqual,
)
const nodes = computed(() => graph.value.nodes)
const edges = computed(() => graph.value.edges)
const nodeDataById = computed<Record<string, ExecutionNodeData>>(() =>
  Object.fromEntries(nodes.value.map(node => [node.id, node.data!])),
)
const sessionLive = computed(() => Boolean(props.run?.root?.live || props.run?.root?.subLive))

const {
  addSelectedNodes,
  fitView,
  getNodes,
  getSelectedNodes,
  getViewport,
  maxZoom,
  minZoom,
  onNodesInitialized,
  removeSelectedNodes,
  setViewport,
  viewport,
  zoomIn,
  zoomOut,
} = useVueFlow('execution-canvas')

provide(ExecutionCanvasKey, {
  layoutDirection,
  selectNode: key => emit('select', key),
})

const minZoomReached = computed(() => viewport.value.zoom <= minZoom.value)
const maxZoomReached = computed(() => viewport.value.zoom >= maxZoom.value)

function zoomCanvasIn(): void {
  void zoomIn()
}

function zoomCanvasOut(): void {
  void zoomOut()
}

function viewKey(): string {
  return `${displayMode.value}:${layoutDirection.value}`
}

function rememberViewport(): void {
  storedViewports.set(viewKey(), getViewport())
}

async function restoreViewportOrFit(): Promise<void> {
  await nextTick()
  const viewport = storedViewports.get(viewKey())
  if (viewport) {
    await setViewport(viewport, { duration: 200 })
    return
  }
  await refit()
}

function setLayout(direction: ExecutionDirection): void {
  if (layoutDirection.value === direction) return
  rememberViewport()
  layoutDirection.value = direction
  positionOverrides.value = new Map()
  void restoreViewportOrFit()
}

function setDisplayMode(mode: ExecutionDetail): void {
  if (displayMode.value === mode) return
  rememberViewport()
  displayMode.value = mode
  positionOverrides.value = new Map()
  void restoreViewportOrFit()
}

function handleNodeClick({ node }: NodeMouseEvent): void {
  emit('select', node.id)
}

function handleNodeDragStop({ node, nodes: draggedNodes }: NodeDragEvent): void {
  const next = new Map(positionOverrides.value)
  for (const dragged of draggedNodes.length ? draggedNodes : [node]) {
    next.set(dragged.id, { ...dragged.position })
  }
  positionOverrides.value = next
}

function miniMapColor(node: GraphNode<ExecutionNodeData>): string {
  if (node.data.state === 'active') return '#63bd88'
  if (node.data.state === 'blocked') return '#d7aa68'
  if (node.data.state === 'failed') return '#bd666d'
  if (node.data.state === 'inactive') return '#555159'
  if (node.data.root) return '#9384d8'
  return '#77717f'
}

function afterPaint(): Promise<void> {
  if (typeof requestAnimationFrame === 'undefined') return Promise.resolve()
  return new Promise(resolve => requestAnimationFrame(() => resolve()))
}

async function refit(): Promise<void> {
  if (typeof document !== 'undefined' && document.hidden) {
    fitWhenVisible = true
    return
  }
  await nextTick()
  await afterPaint()
  if (typeof document !== 'undefined' && document.hidden) {
    fitWhenVisible = true
    return
  }
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
    maxZoom: 1,
  })
  canvasReady.value = true
}

watch(
  () => props.run?.key,
  (key, previousKey) => {
    if (key === previousKey) return
    positionOverrides.value = new Map()
    storedViewports.clear()
    previousStates = new Map()
    pendingFit.value = Boolean(key)
    canvasReady.value = !key
  },
  { immediate: true },
)

watch(
  graph,
  (current) => {
    const nextStates = new Map(current.nodes.map(node => [node.id, node.data!.state]))
    if (previousStates.size) {
      const changes = current.nodes
        .filter(node => previousStates.get(node.id) !== undefined
          && previousStates.get(node.id) !== node.data!.state)
        .map(node => `${node.data!.label} is now ${executionStateLabel(node.data!.state).toLowerCase()}`)
      if (changes.length) announcement.value = changes.join('. ')
    }
    previousStates = nextStates
  },
  { immediate: true },
)

onNodesInitialized(() => {
  void syncSelection()
  if (pendingFit.value) {
    pendingFit.value = false
    void refit()
  }
})

async function bringSelectionIntoView(): Promise<void> {
  if (!props.selectedKey || pendingFit.value || !canvasReady.value) return
  await nextTick()
  await afterPaint()

  const target = getNodes.value.find(node =>
    (node.data as ExecutionNodeData).memberKeys.includes(props.selectedKey!),
  )
  const container = canvasView.value
  if (!target || !container) return

  const { x, y, zoom } = getViewport()
  const width = container.clientWidth
  const height = container.clientHeight
  const padding = { top: 96, right: 24, bottom: 24, left: 24 }
  const nodeWidth = target.dimensions.width * zoom
  const nodeHeight = target.dimensions.height * zoom
  const left = target.computedPosition.x * zoom + x
  const top = target.computedPosition.y * zoom + y
  const right = left + nodeWidth
  const bottom = top + nodeHeight
  const availableWidth = width - padding.left - padding.right
  const availableHeight = height - padding.top - padding.bottom

  const deltaX = nodeWidth > availableWidth
    ? 0
    : left < padding.left
      ? padding.left - left
      : right > width - padding.right
        ? width - padding.right - right
        : 0
  const deltaY = nodeHeight > availableHeight
    ? 0
    : top < padding.top
      ? padding.top - top
      : bottom > height - padding.bottom
        ? height - padding.bottom - bottom
        : 0

  if (deltaX || deltaY) {
    await setViewport({ x: x + deltaX, y: y + deltaY, zoom }, { duration: 200 })
  }
}

async function syncSelection(): Promise<void> {
  await nextTick()
  const target = props.selectedKey
    ? getNodes.value.find(node =>
        (node.data as ExecutionNodeData).memberKeys.includes(props.selectedKey!),
      )
    : undefined
  const selected = getSelectedNodes.value
  const toRemove = selected.filter(node => node.id !== target?.id)
  if (toRemove.length) removeSelectedNodes(toRemove)
  if (target && !target.selected) addSelectedNodes([target])
  await bringSelectionIntoView()
}

watch(
  [() => props.selectedKey, graph],
  () => void syncSelection(),
  { flush: 'post' },
)

function handleVisibilityChange(): void {
  if (document.hidden || !fitWhenVisible) return
  fitWhenVisible = false
  void refit()
}

onMounted(() => document.addEventListener('visibilitychange', handleVisibilityChange))
onBeforeUnmount(() => document.removeEventListener('visibilitychange', handleVisibilityChange))
</script>

<template>
  <div ref="canvasView" class="canvas-view">
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
        <div class="canvas-legend" aria-label="Node status legend">
          <span class="active"><i />Active</span>
          <span class="completed"><i />Complete</span>
          <span class="failed"><i />Failed</span>
          <span class="blocked"><i />Blocked</span>
          <span class="inactive"><i />Inactive</span>
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

      <div
        class="canvas-status"
        :class="{ live: sessionLive }"
        role="status"
      >
        <i />
        {{ sessionLive ? 'Session live' : 'Session idle' }}
      </div>
      <p class="canvas-announcer" aria-live="polite" aria-atomic="true">
        {{ announcement }}
      </p>

      <VueFlow
        id="execution-canvas"
        :nodes="nodes"
        :edges="edges"
        class="execution-canvas"
        :class="{ ready: canvasReady }"
        :min-zoom="0.2"
        :max-zoom="2"
        :nodes-connectable="false"
        :edges-updatable="false"
        :zoom-on-double-click="false"
        aria-label="Session execution canvas"
        @node-click="handleNodeClick"
        @node-drag-stop="handleNodeDragStop"
        @pane-click="emit('deselect')"
      >
        <Background
          :variant="BackgroundVariant.Dots"
          pattern-color="#3d3a43"
          :gap="22"
          :size="1.15"
        />

        <template #node-agent="{ id, selected }">
          <ExecutionAgentNode
            v-if="nodeDataById[id]"
            :id="id"
            :data="nodeDataById[id]"
            :selected="selected"
          />
        </template>

        <MiniMap
          v-if="nodes.length > 3"
          position="bottom-right"
          :node-color="miniMapColor"
          :pannable="true"
          :zoomable="true"
          mask-color="rgb(14 14 15 / 68%)"
        />
        <Controls
          position="bottom-left"
          :show-zoom="false"
          :show-fit-view="false"
          :show-interactive="false"
        >
          <template #top>
            <button
              type="button"
              class="vue-flow__controls-button vue-flow__controls-zoomin"
              aria-label="Zoom in"
              :disabled="maxZoomReached"
              @click="zoomCanvasIn"
            >
              <UIcon name="i-lucide-plus" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="vue-flow__controls-button vue-flow__controls-zoomout"
              aria-label="Zoom out"
              :disabled="minZoomReached"
              @click="zoomCanvasOut"
            >
              <UIcon name="i-lucide-minus" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="vue-flow__controls-button vue-flow__controls-fitview"
              aria-label="Fit graph to view"
              @click="fitView()"
            >
              <UIcon name="i-lucide-scan" aria-hidden="true" />
            </button>
          </template>
        </Controls>
      </VueFlow>
    </template>
  </div>
</template>
