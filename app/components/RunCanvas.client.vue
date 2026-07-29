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
import type { DiagnosticIncident, RunNode, RunResponse } from '#shared/types/run'
import ExecutionAgentNode from '~/components/ExecutionAgentNode.vue'
import { ExecutionCanvasKey } from '~/composables/useExecutionCanvas'
import {
  buildExecutionGraph,
  DEFAULT_EXECUTION_DETAIL,
  executionStateLabel,
  type ExecutionDirection,
  type ExecutionDetail,
  type ExecutionLens,
  type ExecutionNodeData,
} from '~/utils/execution-graph'
import { analyzeCoordination, flattenRunTree } from '~/utils/execution-analysis'
import { structuralComputed, structurallyEqual } from '~/utils/structural-computed'
import { normalizeSessionLabel } from '#shared/utils/session-label'

const props = defineProps<{
  run: RunResponse | null
  root?: RunNode | null
  selectedKey: string | null
  inspectorOpen?: boolean
  focusedFile?: string | null
}>()

const emit = defineEmits<{
  select: [key: string]
  deselect: []
  'inspect-incident': [incident: DiagnosticIncident]
  'focus-time': [timestamp: number | null]
  'focus-file': [path: string | null]
}>()

const canvasView = ref<HTMLElement | null>(null)
const layoutDirection = ref<ExecutionDirection>('left-to-right')
const displayMode = ref<ExecutionDetail>(DEFAULT_EXECUTION_DETAIL)
const lens = ref<ExecutionLens>('all')
const searchQuery = ref('')
const searchOpen = ref(false)
const optionsOpen = ref(false)
const replayAt = ref<number | null>(null)
const playing = ref(false)
const positionOverrides = shallowRef<ReadonlyMap<string, XYPosition>>(new Map())
const collapsedKeys = shallowRef<ReadonlySet<string>>(new Set())
const pendingFit = ref(false)
const canvasReady = ref(false)
const announcement = ref('')
const minimapVisible = ref(false)
const storedViewports = new Map<string, ViewportTransform>()
let fitWhenVisible = false
let previousStates = new Map<string, ExecutionNodeData['state']>()
let replayTimer: ReturnType<typeof setInterval> | undefined
let minimapTimer: ReturnType<typeof setTimeout> | undefined

const coordination = computed(() => analyzeCoordination(props.root || null, props.run))
const graph = structuralComputed(
  () => buildExecutionGraph(
    props.run?.lanes || [],
    positionOverrides.value,
    layoutDirection.value,
    displayMode.value,
    {
      root: props.root,
      diagnostics: props.run?.diagnostics,
      lens: lens.value,
      asOf: replayAt.value,
      query: searchQuery.value,
      selectedKey: props.selectedKey,
      focusedFile: props.focusedFile,
      collapsedKeys: collapsedKeys.value,
      coordination: coordination.value,
    },
  ),
  structurallyEqual,
)
const nodes = computed(() => graph.value.nodes)
const edges = computed(() => graph.value.edges)
const nodeDataById = computed<Record<string, ExecutionNodeData>>(() =>
  Object.fromEntries(nodes.value.map(node => [node.id, node.data!])),
)
const sessionLive = computed(() => Boolean(props.run?.root?.live || props.run?.root?.subLive))
const issues = computed(() => (props.run?.diagnostics?.incidents || [])
  .filter(incident => incident.severity !== 'info')
  .sort((a, b) => (a.ts || '').localeCompare(b.ts || '')))

function parsedTime(value: string | null): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

const replayRange = computed(() => {
  const values = [
    ...(props.run?.lanes.flatMap(lane => [parsedTime(lane.firstTs), parsedTime(lane.lastTs)]) || []),
    ...(props.run?.diagnostics?.incidents?.map(incident => parsedTime(incident.ts)) || []),
    ...(props.run?.diagnostics?.changes?.map(change => parsedTime(change.ts)) || []),
  ].filter((value): value is number => value !== null)
  const start = values.length ? Math.min(...values) : 0
  const end = values.length ? Math.max(...values, sessionLive.value ? Date.now() : 0) : start
  return { start, end: Math.max(start + 1, end) }
})
const replayValue = computed(() => replayAt.value ?? replayRange.value.end)
const replayLabel = computed(() => replayAt.value === null
  ? 'Live tail'
  : new Date(replayAt.value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }))
const replayMarkers = computed(() => {
  const markers = [
    ...(props.run?.diagnostics.incidents || []).map(incident => ({
      ts: parsedTime(incident.ts),
      label: incident.title,
      kind: incident.severity === 'error' ? 'error' : 'warning',
      incident,
    })),
    ...(props.run?.phases || []).map(phase => ({
      ts: parsedTime(phase.ts),
      label: phase.title,
      kind: 'phase',
      incident: null,
    })),
  ].filter(marker => marker.ts !== null).slice(-40)
  return markers.map(marker => ({
    ...marker,
    left: `${((marker.ts! - replayRange.value.start) / Math.max(1, replayRange.value.end - replayRange.value.start)) * 100}%`,
  }))
})

const rootNodes = computed(() => flattenRunTree(props.root || null))
const nodeIndex = computed(() => new Map(rootNodes.value.map(node => [node.key, node])))
const breadcrumb = computed(() => {
  if (!props.selectedKey || !props.root) return []
  const parent = new Map<string, string>()
  for (const node of rootNodes.value) node.children.forEach(child => parent.set(child.key, node.key))
  const keys: string[] = []
  let key: string | undefined = props.selectedKey
  while (key) {
    keys.unshift(key)
    key = parent.get(key)
  }
  return keys.map(item => ({ key: item, label: normalizeSessionLabel(nodeIndex.value.get(item)?.label || item, item) }))
})

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
  toggleNode,
})

const minZoomReached = computed(() => viewport.value.zoom <= minZoom.value)
const maxZoomReached = computed(() => viewport.value.zoom >= maxZoom.value)

function toggleNode(key: string): void {
  const next = new Set(collapsedKeys.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedKeys.value = next
}

function setLens(next: ExecutionLens): void {
  lens.value = next
  if (next === 'problems' && issues.value[0]?.key) emit('select', issues.value[0].key)
  void refit()
}

function zoomCanvasIn(): void { void zoomIn() }
function zoomCanvasOut(): void { void zoomOut() }
function viewKey(): string { return `${displayMode.value}:${layoutDirection.value}:${lens.value}` }
function rememberViewport(): void { storedViewports.set(viewKey(), getViewport()) }

async function restoreViewportOrFit(): Promise<void> {
  await nextTick()
  const saved = storedViewports.get(viewKey())
  if (saved) await setViewport(saved, { duration: 200 })
  else await refit()
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

function handleNodeClick({ node }: NodeMouseEvent): void { emit('select', node.id) }
function handleNodeDragStop({ node, nodes: draggedNodes }: NodeDragEvent): void {
  const next = new Map(positionOverrides.value)
  for (const dragged of draggedNodes.length ? draggedNodes : [node]) next.set(dragged.id, { ...dragged.position })
  positionOverrides.value = next
}

function miniMapColor(node: GraphNode<ExecutionNodeData>): string {
  if (node.data.focusedFile) return '#73a7dc'
  if (node.data.collision) return '#d7aa68'
  if (node.data.state === 'active') return '#63bd88'
  if (node.data.state === 'blocked') return '#d7aa68'
  if (node.data.state === 'failed') return '#bd666d'
  if (node.data.state === 'inactive') return '#555159'
  if (node.data.root) return '#9384d8'
  return '#77717f'
}

function showMinimap(): void {
  if (minimapTimer) clearTimeout(minimapTimer)
  minimapVisible.value = true
}
function hideMinimapSoon(): void {
  if (minimapTimer) clearTimeout(minimapTimer)
  minimapTimer = setTimeout(() => { minimapVisible.value = false }, 1_000)
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
  const focusKey = props.selectedKey || props.run?.key
  const focusNodes = displayMode.value === 'overview' || lens.value !== 'all'
    ? nodes.value.filter(node => !node.data?.muted).map(node => node.id)
    : focusKey
      ? [focusKey, ...edges.value.filter(edge => edge.target === focusKey).map(edge => edge.source).slice(0, 1), ...edges.value.filter(edge => edge.source === focusKey).map(edge => edge.target).slice(0, 4)]
      : nodes.value.slice(0, 5).map(node => node.id)
  await fitView({
    nodes: [...new Set(focusNodes.length ? focusNodes : nodes.value.map(node => node.id))],
    padding: { top: '48px', right: '8%', bottom: '90px', left: '8%' },
    duration: 250,
    minZoom: 0.45,
    maxZoom: 1,
  })
  canvasReady.value = true
}

watch(() => props.run?.key, (key, previousKey) => {
  if (key === previousKey) return
  positionOverrides.value = new Map()
  collapsedKeys.value = new Set()
  storedViewports.clear()
  previousStates = new Map()
  displayMode.value = (props.run?.lanes?.length || 0) > 4 ? 'overview' : DEFAULT_EXECUTION_DETAIL
  replayAt.value = null
  lens.value = 'all'
  searchQuery.value = ''
  pendingFit.value = Boolean(key)
  canvasReady.value = !key
}, { immediate: true })

watch(graph, current => {
  const nextStates = new Map(current.nodes.map(node => [node.id, node.data!.state]))
  if (previousStates.size) {
    const changes = current.nodes
      .filter(node => previousStates.get(node.id) !== undefined && previousStates.get(node.id) !== node.data!.state)
      .map(node => `${node.data!.label} is now ${executionStateLabel(node.data!.state).toLowerCase()}`)
    if (changes.length) announcement.value = changes.join('. ')
  }
  previousStates = nextStates
}, { immediate: true })

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
  const target = getNodes.value.find(node => (node.data as ExecutionNodeData).memberKeys.includes(props.selectedKey!))
  const container = canvasView.value
  if (!target || !container) return
  const { x, y, zoom } = getViewport()
  const width = container.clientWidth
  const height = container.clientHeight
  const padding = { top: props.inspectorOpen ? 170 : 130, right: 24, bottom: 100, left: 24 }
  const left = target.computedPosition.x * zoom + x
  const top = target.computedPosition.y * zoom + y
  const right = left + target.dimensions.width * zoom
  const bottom = top + target.dimensions.height * zoom
  const deltaX = left < padding.left ? padding.left - left : right > width - padding.right ? width - padding.right - right : 0
  const deltaY = top < padding.top ? padding.top - top : bottom > height - padding.bottom ? height - padding.bottom - bottom : 0
  if (deltaX || deltaY) await setViewport({ x: x + deltaX, y: y + deltaY, zoom }, { duration: 200 })
}

async function syncSelection(): Promise<void> {
  await nextTick()
  const target = props.selectedKey
    ? getNodes.value.find(node => (node.data as ExecutionNodeData).memberKeys.includes(props.selectedKey!))
    : undefined
  const selected = getSelectedNodes.value
  const toRemove = selected.filter(node => node.id !== target?.id)
  if (toRemove.length) removeSelectedNodes(toRemove)
  if (target && !target.selected) addSelectedNodes([target])
  await bringSelectionIntoView()
}
watch(() => props.selectedKey, () => void syncSelection(), { flush: 'post' })

function navigateIncident(direction: 1 | -1): void {
  if (!issues.value.length) return
  const current = issues.value.findIndex(incident => incident.key === props.selectedKey)
  const index = current < 0 ? (direction > 0 ? 0 : issues.value.length - 1) : (current + direction + issues.value.length) % issues.value.length
  const incident = issues.value[index]!
  if (incident.key) emit('select', incident.key)
  emit('inspect-incident', incident)
  if (incident.ts) setReplayTime(parsedTime(incident.ts))
}

function selectRelated(direction: 'parent' | 'child' | 'previous' | 'next'): void {
  const current = props.selectedKey || props.run?.key
  if (!current) return
  const parentEdge = edges.value.find(edge => edge.target === current)
  const childEdges = edges.value.filter(edge => edge.source === current)
  if (direction === 'parent' && parentEdge) emit('select', parentEdge.source)
  else if (direction === 'child' && childEdges[0]) emit('select', childEdges[0].target)
  else {
    const siblings = parentEdge ? edges.value.filter(edge => edge.source === parentEdge.source).map(edge => edge.target) : []
    const index = siblings.indexOf(current)
    const offset = direction === 'previous' ? -1 : 1
    if (index >= 0 && siblings.length > 1) emit('select', siblings[(index + offset + siblings.length) % siblings.length]!)
  }
}

function handleCanvasKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement
  if (target.matches('input, textarea, select')) return
  const horizontal = layoutDirection.value === 'left-to-right'
  const action = event.key === (horizontal ? 'ArrowLeft' : 'ArrowUp') ? 'parent'
    : event.key === (horizontal ? 'ArrowRight' : 'ArrowDown') ? 'child'
      : event.key === (horizontal ? 'ArrowUp' : 'ArrowLeft') ? 'previous'
        : event.key === (horizontal ? 'ArrowDown' : 'ArrowRight') ? 'next' : null
  if (!action) return
  event.preventDefault()
  selectRelated(action)
}

function setReplayTime(value: number | null): void {
  replayAt.value = value
  emit('focus-time', value)
}
function jumpToMarker(marker: typeof replayMarkers.value[number]): void {
  setReplayTime(marker.ts)
  if (marker.incident) emit('inspect-incident', marker.incident)
}
function onReplayInput(event: Event): void {
  stopPlayback()
  setReplayTime(Number((event.target as HTMLInputElement).value))
}
function stopPlayback(): void {
  playing.value = false
  if (replayTimer) clearInterval(replayTimer)
  replayTimer = undefined
}
function togglePlayback(): void {
  if (playing.value) return stopPlayback()
  if (replayAt.value === null || replayAt.value >= replayRange.value.end) setReplayTime(replayRange.value.start)
  playing.value = true
  replayTimer = setInterval(() => {
    const step = Math.max(250, Math.round((replayRange.value.end - replayRange.value.start) / 120))
    const next = (replayAt.value ?? replayRange.value.start) + step
    if (next >= replayRange.value.end) {
      stopPlayback()
      setReplayTime(null)
    } else setReplayTime(next)
  }, 250)
}

function handleVisibilityChange(): void {
  if (document.hidden || !fitWhenVisible) return
  fitWhenVisible = false
  void refit()
}

onMounted(() => document.addEventListener('visibilitychange', handleVisibilityChange))
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  stopPlayback()
  if (minimapTimer) clearTimeout(minimapTimer)
})
</script>

<template>
  <div ref="canvasView" class="canvas-view" @keydown.capture="handleCanvasKeydown">
    <div v-if="!run" class="empty-state">
      <span class="empty-state-icon"><UIcon name="i-lucide-workflow" /></span>
      <h2>No session selected</h2>
      <p>Choose a session to explore its agent canvas.</p>
    </div>

    <template v-else>
      <div class="canvas-heading" :class="{ 'inspector-open': inspectorOpen }">
        <div class="canvas-title">
          <UIcon name="i-lucide-workflow" />
          <span>
            <strong>Execution graph</strong>
            <small>
              {{ run?.lanes?.length || 0 }} agents<template v-if="nodes.length !== (run?.lanes?.length || 0)"> · {{ nodes.length }} visible</template>
            </small>
          </span>
        </div>
        <div class="canvas-command-bar">
          <div class="canvas-heading-actions">
            <button
              type="button"
              :class="{ selected: searchOpen }"
              :aria-expanded="searchOpen"
              aria-controls="canvas-search-control"
              @click="searchOpen = !searchOpen"
            ><UIcon name="i-lucide-search" /><span>Search</span></button>
            <button
              type="button"
              :class="{ selected: optionsOpen || lens !== 'all' }"
              :aria-expanded="optionsOpen"
              aria-controls="canvas-display-options"
              @click="optionsOpen = !optionsOpen"
            ><UIcon name="i-lucide-sliders-horizontal" /><span>View</span></button>
          </div>
          <slot name="actions" />
        </div>
        <label v-if="searchOpen" id="canvas-search-control" class="canvas-search">
          <UIcon name="i-lucide-search" />
          <input v-model="searchQuery" type="search" placeholder="Find agent or activity" aria-label="Search canvas" />
          <button v-if="searchQuery" type="button" aria-label="Clear canvas search" @click="searchQuery = ''"><UIcon name="i-lucide-x" /></button>
        </label>
        <div v-if="optionsOpen" id="canvas-display-options" class="canvas-options">
          <div class="canvas-lenses" aria-label="Investigation lens">
            <button
              v-for="option in ([
                { id: 'all', label: 'All', icon: 'i-lucide-workflow' },
                { id: 'active', label: 'Active', icon: 'i-lucide-radio' },
                { id: 'problems', label: 'Problems', icon: 'i-lucide-circle-alert' },
                { id: 'files', label: 'Files', icon: 'i-lucide-files' },
                { id: 'coordination', label: 'Coordination', icon: 'i-lucide-git-fork' },
              ] as const)"
              :key="option.id"
              type="button"
              :class="{ selected: lens === option.id }"
              :aria-pressed="lens === option.id"
              @click="setLens(option.id)"
            ><UIcon :name="option.icon" />{{ option.label }}</button>
          </div>
          <div class="canvas-toolbar">
            <div class="canvas-layout" aria-label="Graph detail">
              <button type="button" :class="{ selected: displayMode === 'overview' }" :aria-pressed="displayMode === 'overview'" title="Group nested agents into readable workstreams" @click="setDisplayMode('overview')"><UIcon name="i-lucide-scan" /><span>Overview</span></button>
              <button type="button" :class="{ selected: displayMode === 'all-agents' }" :aria-pressed="displayMode === 'all-agents'" title="Show every individual agent" @click="setDisplayMode('all-agents')"><UIcon name="i-lucide-list-tree" /><span>All agents</span></button>
            </div>
            <div class="canvas-layout" aria-label="Graph direction">
              <button type="button" :class="{ selected: layoutDirection === 'left-to-right' }" :aria-pressed="layoutDirection === 'left-to-right'" title="Lay out agents from left to right" @click="setLayout('left-to-right')"><UIcon name="i-lucide-arrow-right" /><span>Left to right</span></button>
              <button type="button" :class="{ selected: layoutDirection === 'top-to-bottom' }" :aria-pressed="layoutDirection === 'top-to-bottom'" title="Lay out agents from top to bottom" @click="setLayout('top-to-bottom')"><UIcon name="i-lucide-arrow-down" /><span>Top to bottom</span></button>
            </div>
          </div>
        </div>
      </div>

      <div class="canvas-stage">
      <div v-if="breadcrumb.length > 1" class="canvas-breadcrumb" aria-label="Selected agent path">
        <button v-for="(item, index) in breadcrumb" :key="item.key" type="button" @click="emit('select', item.key)">
          <UIcon v-if="index" name="i-lucide-chevron-right" />{{ item.label }}
        </button>
      </div>
      <div class="canvas-status" :class="{ live: sessionLive }" role="status"><i />{{ replayAt !== null ? `Replay · ${replayLabel}` : sessionLive ? 'Session live' : 'Session idle' }}</div>
      <p class="canvas-announcer" aria-live="polite" aria-atomic="true">{{ announcement }}</p>

      <div v-if="lens === 'problems'" class="canvas-issue-nav">
        <span><UIcon name="i-lucide-circle-alert" />{{ issues.length }} incidents</span>
        <button type="button" aria-label="Previous incident" :disabled="!issues.length" @click="navigateIncident(-1)"><UIcon name="i-lucide-chevron-left" /></button>
        <button type="button" aria-label="Next incident" :disabled="!issues.length" @click="navigateIncident(1)"><UIcon name="i-lucide-chevron-right" /></button>
      </div>

      <div v-if="lens === 'coordination'" class="coordination-overlay">
        <header><span><UIcon name="i-lucide-git-fork" />Coordination signals</span><b>{{ coordination.findings.length }}</b></header>
        <button
          v-for="finding in coordination.findings.slice(0, 6)"
          :key="finding.id"
          type="button"
          :class="finding.severity"
          @click="finding.file ? emit('focus-file', finding.file) : finding.keys[0] && emit('select', finding.keys[0])"
        >
          <UIcon :name="finding.kind === 'file-collision' ? 'i-lucide-files' : finding.kind === 'critical-path' ? 'i-lucide-route' : finding.kind === 'bottleneck' ? 'i-lucide-git-fork' : 'i-lucide-timer'" />
          <span><strong>{{ finding.title }}</strong><small>{{ finding.detail }}</small></span>
        </button>
        <p v-if="!coordination.findings.length">No coordination risks detected in this run.</p>
      </div>

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
        @viewport-change-start="showMinimap"
        @viewport-change-end="hideMinimapSoon"
      >
        <Background :variant="BackgroundVariant.Dots" pattern-color="#3d3a43" :gap="22" :size="1.15" />
        <template #node-agent="{ id, selected }">
          <ExecutionAgentNode v-if="nodeDataById[id]" :id="id" :data="nodeDataById[id]" :selected="selected" />
        </template>
        <Transition name="minimap">
          <MiniMap
            v-if="nodes.length > 3 && minimapVisible && !inspectorOpen"
            position="bottom-right"
            :node-color="miniMapColor"
            :pannable="true"
            :zoomable="true"
            mask-color="rgb(14 14 15 / 68%)"
            @mouseenter="showMinimap"
            @mouseleave="hideMinimapSoon"
          />
        </Transition>
        <Controls position="bottom-left" :show-zoom="false" :show-fit-view="false" :show-interactive="false">
          <template #top>
            <button type="button" class="vue-flow__controls-button" aria-label="Zoom in" :disabled="maxZoomReached" @click="zoomCanvasIn"><UIcon name="i-lucide-plus" /></button>
            <button type="button" class="vue-flow__controls-button" aria-label="Zoom out" :disabled="minZoomReached" @click="zoomCanvasOut"><UIcon name="i-lucide-minus" /></button>
            <button type="button" class="vue-flow__controls-button" aria-label="Fit graph to view" @click="refit"><UIcon name="i-lucide-scan" /></button>
          </template>
        </Controls>
      </VueFlow>

      <div v-if="replayRange.start" class="replay-bar">
        <button type="button" :aria-label="playing ? 'Pause replay' : 'Play replay'" @click="togglePlayback"><UIcon :name="playing ? 'i-lucide-pause' : 'i-lucide-play'" /></button>
        <span>{{ new Date(replayRange.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }}</span>
        <div class="replay-track">
          <input :value="replayValue" type="range" :min="replayRange.start" :max="replayRange.end" :step="Math.max(1, Math.round((replayRange.end - replayRange.start) / 500))" aria-label="Replay session timeline" @input="onReplayInput" />
          <button
            v-for="(marker, index) in replayMarkers"
            :key="`${marker.kind}-${marker.ts}-${index}`"
            type="button"
            class="replay-marker"
            :class="marker.kind"
            :style="{ left: marker.left }"
            :title="marker.label"
            :aria-label="`${marker.label} at ${new Date(marker.ts!).toLocaleTimeString()}`"
            @click="jumpToMarker(marker)"
          />
        </div>
        <span>{{ replayAt === null ? new Date(replayRange.end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : replayLabel }}</span>
        <button type="button" class="live-tail" :class="{ selected: replayAt === null }" @click="stopPlayback(); setReplayTime(null)"><i />Live tail</button>
      </div>
      </div>
    </template>
  </div>
</template>
