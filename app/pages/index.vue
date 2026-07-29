<script setup lang="ts">
import type { RunNode, TranscriptEvent } from '#shared/types/run'
import { normalizeSessionLabel } from '#shared/utils/session-label'
import { flattenRunTree } from '~/utils/execution-analysis'

const live = useLiveRuns()
const densities = ['compact', 'normal', 'raw'] as const
const views = [
  { id: 'now', label: 'Now', icon: 'i-lucide-gauge', shortcut: 'N' },
  { id: 'activity', label: 'Activity', icon: 'i-lucide-activity', shortcut: 'A' },
  { id: 'guide', label: 'Guide', icon: 'i-lucide-map', shortcut: 'G' },
  { id: 'diagnostics', label: 'Diagnostics', icon: 'i-lucide-stethoscope', shortcut: 'I' },
  { id: 'changes', label: 'Changes', icon: 'i-lucide-files', shortcut: 'D' },
  { id: 'chat', label: 'Ask', icon: 'i-lucide-message-square', shortcut: 'Q' },
] as const
type SessionPanel = typeof views[number]['id']

const activePanel = ref<SessionPanel | 'inspector' | null>(null)
const inspectedKey = ref<string | null>(null)
const contextKey = ref<string | null>(null)
const canvasTime = ref<number | null>(null)
const focusedLine = ref<number | null>(null)
const focusedFile = ref<string | null>(null)
const activityAgentKey = ref('all')
const searchOpen = ref(false)
const sidebarCollapsed = ref(false)
const viewportWidth = ref(1440)
const sidebarWidth = ref(272)
const panelWidth = ref(380)

const SIDEBAR_MIN = 220
const SIDEBAR_MAX = 480
const SIDEBAR_DEFAULT = 272
const PANEL_MIN = 280
const PANEL_MAX = 720
const PANEL_DEFAULT = 380
const PRIMARY_MIN = 300
const RESIZE_HANDLES_WIDTH = 14
const SIDEBAR_STORAGE_KEY = 'liveclaudecode:sidebar-width'
const PANEL_STORAGE_KEY = 'liveclaudecode:panel-width'
const sidebarVisible = computed(() => !sidebarCollapsed.value)
const mobilePanel = computed(() => viewportWidth.value <= 880)

const sidebarMax = computed(() => {
  if (viewportWidth.value <= 680) return SIDEBAR_MAX
  const dockedPanelWidth = viewportWidth.value > 880 && activePanel.value ? panelWidth.value : 0
  return Math.max(
    SIDEBAR_MIN,
    Math.min(SIDEBAR_MAX, viewportWidth.value - dockedPanelWidth - PRIMARY_MIN - RESIZE_HANDLES_WIDTH),
  )
})

const panelMax = computed(() => {
  if (viewportWidth.value <= 880) return PANEL_MAX
  const browserWidth = sidebarVisible.value ? sidebarWidth.value : 0
  return Math.max(
    PANEL_MIN,
    Math.min(PANEL_MAX, viewportWidth.value - browserWidth - PRIMARY_MIN - RESIZE_HANDLES_WIDTH),
  )
})

const workspaceStyle = computed(() => ({
  '--panel-width': `${panelWidth.value}px`,
}))

let widthsHydrated = false

function clampWidth(width: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(width, min), max))
}

function readStoredWidth(key: string, fallback: number): number {
  try {
    const width = Number.parseInt(window.localStorage.getItem(key) || '', 10)
    return Number.isFinite(width) ? width : fallback
  } catch {
    return fallback
  }
}

function persistWidth(key: string, width: number): void {
  if (!widthsHydrated) return
  try {
    window.localStorage.setItem(key, String(width))
  } catch {
    // The dashboard remains usable when browser storage is unavailable.
  }
}

function fitPanelsToViewport(): void {
  viewportWidth.value = window.innerWidth
  if (viewportWidth.value <= 880) return
  panelWidth.value = clampWidth(panelWidth.value, PANEL_MIN, panelMax.value)
  sidebarWidth.value = clampWidth(sidebarWidth.value, SIDEBAR_MIN, sidebarMax.value)
}

const inspectedNode = computed(() => {
  if (!inspectedKey.value || !live.selectedRoot.value) return null
  const visit = (node: RunNode): RunNode | null => {
    if (node.key === inspectedKey.value) return node
    for (const child of node.children) {
      const found = visit(child)
      if (found) return found
    }
    return null
  }
  return visit(live.selectedRoot.value)
})

const activityAgents = computed(() => flattenRunTree(live.selectedRoot.value))
const activityAgentOptions = computed(() => [
  { label: 'Whole session', value: 'all' },
  ...activityAgents.value.map(agent => ({ label: agent.label, value: agent.key })),
])
const searchGroups = computed(() => [{
  id: 'sessions',
  label: 'Sessions',
  items: live.projects.value.flatMap(project => project.roots.map(root => ({
    id: `${project.id}/${root.key}`,
    label: normalizeSessionLabel(root.label, root.key),
    description: project.name,
    suffix: root.subLive ? 'Running' : root.subErrors ? 'Attention' : root.source,
    icon: root.subLive
      ? 'i-lucide-radio'
      : root.subErrors
        ? 'i-lucide-circle-alert'
        : 'i-lucide-message-square-code',
    onSelect: () => {
      searchOpen.value = false
      void selectSession(project.id, root.key)
    },
  }))),
}, {
  id: 'views',
  label: 'Open view',
  items: views.map(view => ({
    id: view.id,
    label: view.label,
    icon: view.icon,
    kbds: [view.shortcut],
    disabled: !live.selectedRoot.value,
    onSelect: () => {
      searchOpen.value = false
      openSessionPanel(view.id)
    },
  })),
}])
const viewMenuItems = computed(() => [views.map(view => ({
  label: view.label,
  icon: view.icon,
  kbds: [view.shortcut],
  disabled: !live.selectedRoot.value,
  checked: activePanel.value === view.id,
  onSelect: () => openSessionPanel(view.id),
}))])
const activityEvents = computed<TranscriptEvent[]>(() => {
  const root = live.selectedRoot.value
  const base = live.sessionEvents.value.length
    ? live.sessionEvents.value
    : live.events.value.map(event => ({
        ...event,
        agentKey: root?.key,
        agentLabel: root?.label,
        agentType: root?.agentType || 'Main session',
        agentDepth: 0,
      }))
  const eventKeys = new Set(base.filter(event => event.error).map(event => `${event.agentKey || ''}:${event.line}`))
  const incidentEvents: TranscriptEvent[] = (live.run.value?.diagnostics.incidents || [])
    .filter(incident => incident.severity !== 'info' && !eventKeys.has(`${incident.key || ''}:${incident.line}`))
    .map(incident => ({
      role: 'system',
      kind: 'system',
      ts: incident.ts,
      line: incident.line,
      body: incident.detail,
      summary: incident.title,
      tool: incident.tool,
      error: incident.severity === 'error',
      agentKey: incident.key,
      agentLabel: activityAgents.value.find(agent => agent.key === incident.key)?.label || incident.who || 'Session',
      agentType: activityAgents.value.find(agent => agent.key === incident.key)?.agentType || 'Diagnostic incident',
    }))
  return [...base, ...incidentEvents]
    .filter(event => activityAgentKey.value === 'all' || event.agentKey === activityAgentKey.value)
    .sort((left, right) => (left.ts || '').localeCompare(right.ts || '') || left.line - right.line)
})

function closePanel(): void {
  activePanel.value = null
  inspectedKey.value = null
  focusedLine.value = null
  focusedFile.value = null
  live.clearInspection()
}

function inspectCanvasNode(key: string): void {
  inspectedKey.value = key
  contextKey.value = key
  activePanel.value = 'inspector'
  void live.inspect(key)
}

function inspectIncident(incident: { key?: string, line: number, ts: string | null }): void {
  if (incident.key) inspectCanvasNode(incident.key)
  focusedLine.value = incident.line
  canvasTime.value = incident.ts ? Date.parse(incident.ts) : null
}

function focusTime(timestamp: number | null, line: number | null = null): void {
  canvasTime.value = timestamp
  focusedLine.value = line
}

function focusFile(path: string | null): void {
  focusedFile.value = path
}

function openSessionPanel(panel: SessionPanel): void {
  if (activePanel.value === panel) {
    closePanel()
    return
  }
  inspectedKey.value = null
  activePanel.value = panel
}

async function selectSession(project: string, key: string): Promise<void> {
  closePanel()
  contextKey.value = null
  await live.select(key, project)
}

function handleShortcut(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b' && !event.altKey) {
    event.preventDefault()
    sidebarCollapsed.value = !sidebarCollapsed.value
    return
  }
  if (target?.matches('input, textarea, [contenteditable="true"]') || event.metaKey || event.ctrlKey || event.altKey) return
  if (event.key === 'Escape') {
    closePanel()
    return
  }
  if (event.key.toLowerCase() === 'c') {
    closePanel()
    return
  }

  const shortcuts: Record<string, SessionPanel> = {
    n: 'now',
    a: 'activity',
    g: 'guide',
    i: 'diagnostics',
    d: 'changes',
    q: 'chat',
  }
  const panel = shortcuts[event.key.toLowerCase()]
  if (!panel) return
  openSessionPanel(panel)
}

watch(
  () => `${live.selectedProject.value || ''}\0${live.selectedKey.value || ''}`,
  value => {
    closePanel()
    activityAgentKey.value = 'all'
    contextKey.value = null
  },
)

watch(inspectedNode, node => {
  if (inspectedKey.value && !node) closePanel()
})

watch(panelWidth, width => persistWidth(PANEL_STORAGE_KEY, width))
watch(sidebarWidth, width => persistWidth(SIDEBAR_STORAGE_KEY, width))
watch([activePanel, sidebarCollapsed], () => {
  if (import.meta.client) fitPanelsToViewport()
})

onMounted(() => {
  sidebarWidth.value = clampWidth(
    readStoredWidth(SIDEBAR_STORAGE_KEY, SIDEBAR_DEFAULT),
    SIDEBAR_MIN,
    SIDEBAR_MAX,
  )
  panelWidth.value = clampWidth(
    readStoredWidth(PANEL_STORAGE_KEY, PANEL_DEFAULT),
    PANEL_MIN,
    PANEL_MAX,
  )
  fitPanelsToViewport()
  widthsHydrated = true
  window.addEventListener('keydown', handleShortcut)
  window.addEventListener('resize', fitPanelsToViewport)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleShortcut)
  window.removeEventListener('resize', fitPanelsToViewport)
})
</script>

<template>
  <UDashboardGroup
    class="shell"
    storage="local"
    storage-key="liveclaudecode"
    unit="px"
  >
    <UDashboardSearch
      v-model:open="searchOpen"
      :groups="searchGroups"
      placeholder="Jump to a session or view…"
      :color-mode="false"
      virtualize
    />
    <UBadge
      v-if="live.offline.value"
      class="offline-badge"
      color="error"
      variant="soft"
      icon="i-lucide-wifi-off"
      label="Viewer offline — retrying"
    />
    <UDashboardSidebar
      id="session-browser"
      v-model:collapsed="sidebarCollapsed"
      class="dashboard-session-sidebar"
      collapsible
      :style="{ '--custom-sidebar-width': `${sidebarWidth}px` }"
      :collapsed-size="0"
      :ui="{ root: '!min-w-0', body: '!p-0 !gap-0 !overflow-hidden' }"
    >
      <RunSidebar
        v-model:query="live.query.value"
        v-model:source-filter="live.sourceFilter.value"
        v-model:project-filter="live.projectFilter.value"
        v-model:live-only="live.liveOnly.value"
        v-model:attention-only="live.attentionOnly.value"
        v-model:hide-idle="live.hideIdle.value"
        :projects="live.visibleProjects.value"
        :all-projects="live.projects.value"
        :sources="live.sources.value"
        :project-options="live.projectOptions.value"
        :loading="live.loading.value"
        :selected-project="live.selectedProject.value"
        :selected-key="live.selectedKey.value"
        @select="selectSession"
        @collapse="sidebarCollapsed = true"
      />
    </UDashboardSidebar>
    <PanelResizeHandle
      v-if="sidebarVisible"
      v-model="sidebarWidth"
      class="sidebar-resize-handle"
      :min="SIDEBAR_MIN"
      :max="sidebarMax"
      :default-value="SIDEBAR_DEFAULT"
      direction="right"
      label="Resize session browser"
    />
    <UDashboardPanel class="main-content-panel" :ui="{ root: '!min-h-0' }">
      <main class="main-content">
      <RunHero
        v-model:follow-active="live.followActive.value"
        :sidebar-visible="sidebarVisible"
        :root="live.selectedRoot.value"
        :selected="live.selectedNode.value"
        :file-count="live.run.value?.files.length || 0"
        :transcript-path="live.run.value?.transcriptPath || ''"
        @show-sidebar="sidebarCollapsed = false"
      />
      <div
        class="session-workspace"
        :class="{ 'panel-open': activePanel && !mobilePanel }"
        :style="workspaceStyle"
      >
        <section class="session-primary">
          <RunCanvas
            :run="live.run.value"
            :root="live.selectedRoot.value"
            :selected-key="inspectedKey"
            :inspector-open="activePanel === 'inspector'"
            :focused-file="focusedFile"
            @select="inspectCanvasNode"
            @deselect="closePanel"
            @inspect-incident="inspectIncident"
            @focus-time="focusTime"
            @focus-file="focusFile"
          >
            <template #actions>
              <nav class="view-actions" aria-label="Supporting session views">
                <UButton
                  type="button"
                  color="neutral"
                  variant="ghost"
                  icon="i-lucide-activity"
                  label="Activity"
                  :class="{ selected: activePanel === 'activity' }"
                  :aria-pressed="activePanel === 'activity'"
                  @click="openSessionPanel('activity')"
                />
                <UDropdownMenu :items="viewMenuItems" :content="{ align: 'end' }">
                  <UButton
                    type="button"
                    color="neutral"
                    variant="ghost"
                    trailing-icon="i-lucide-chevron-down"
                    :disabled="!live.selectedRoot.value"
                    :label="activePanel && activePanel !== 'activity' && activePanel !== 'inspector' ? views.find(view => view.id === activePanel)?.label : 'More'"
                    aria-label="More session views"
                  />
                </UDropdownMenu>
              </nav>
            </template>
          </RunCanvas>
        </section>

        <PanelResizeHandle
          v-if="activePanel && !mobilePanel"
          v-model="panelWidth"
          class="workspace-panel-resize-handle"
          :min="PANEL_MIN"
          :max="panelMax"
          :default-value="PANEL_DEFAULT"
          direction="left"
          label="Resize details panel"
        />

        <ResponsiveDashboardPanel
          v-if="activePanel"
          :mobile="mobilePanel"
          :title="activePanel === 'inspector' ? 'Selected agent details' : `${views.find(view => view.id === activePanel)?.label || 'Session'} panel`"
          @close="closePanel"
        >
          <RunInspector
            v-if="activePanel === 'inspector'"
            :run="live.run.value"
            :root="live.selectedRoot.value"
            :selected="inspectedNode"
            :selected-key="inspectedKey"
            :events="live.inspectedEvents.value"
            :events-loading="live.inspectedEventsLoading.value"
            :density="live.density.value"
            :errors-only="live.errorsOnly.value"
            :follow-output="live.followOutput.value"
            :current-time="canvasTime"
            :focused-line="focusedLine"
            :focused-file="focusedFile"
            @select="inspectCanvasNode"
            @close="closePanel"
            @focus-time="focusTime"
            @focus-file="focusFile"
            @update:density="live.density.value = $event"
            @update:errors-only="live.errorsOnly.value = $event"
          />

          <aside v-else class="session-panel" :aria-label="`${views.find(view => view.id === activePanel)?.label} panel`">
          <header class="session-panel-title">
            <span>
              <UIcon :name="views.find(view => view.id === activePanel)?.icon" />
              {{ views.find(view => view.id === activePanel)?.label }}
            </span>
            <UButton color="neutral" variant="ghost" icon="i-lucide-x" aria-label="Close panel" @click="closePanel" />
          </header>
          <div v-if="activePanel === 'activity'" class="session-panel-controls">
            <label class="activity-agent-filter">
              <span>Agent</span>
              <USelectMenu
                v-model="activityAgentKey"
                :items="activityAgentOptions"
                value-key="value"
                label-key="label"
                size="xs"
                aria-label="Filter activity by agent"
              />
            </label>
            <div class="segments" role="group" aria-label="Event detail">
              <button
                v-for="option in densities"
                :key="option"
                type="button"
                :class="{ selected: live.density.value === option }"
                :aria-pressed="live.density.value === option"
                @click="live.density.value = option"
              >{{ option }}</button>
            </div>
            <UButton
              type="button"
              class="quiet-action"
              color="neutral"
              variant="ghost"
              icon="i-lucide-circle-alert"
              :class="{ active: live.errorsOnly.value }"
              :aria-pressed="live.errorsOnly.value"
              @click="live.errorsOnly.value = !live.errorsOnly.value"
            >
              Errors
            </UButton>
            <UButton
              type="button"
              class="quiet-action"
              color="neutral"
              variant="ghost"
              icon="i-lucide-arrow-down-to-line"
              :class="{ active: live.followOutput.value }"
              :aria-pressed="live.followOutput.value"
              @click="live.followOutput.value = !live.followOutput.value"
            >
              Follow
            </UButton>
          </div>
          <RunNowBoard
            v-if="activePanel === 'now'"
            :root="live.selectedRoot.value"
            :run="live.run.value"
            @select="inspectCanvasNode"
          />
          <EventFeed
            v-else-if="activePanel === 'activity'"
            :events="activityEvents"
            :density="live.density.value"
            :errors-only="live.errorsOnly.value"
            :follow-output="live.followOutput.value"
            :truncated="live.sessionEventsTruncated.value"
            session-wide
            @select="inspectCanvasNode"
          />
          <RunOverview
            v-else-if="activePanel === 'guide'"
            :run="live.run.value"
            :selected-key="contextKey"
            @select="inspectCanvasNode"
          />
          <RunDiagnostics
            v-else-if="activePanel === 'diagnostics'"
            :run="live.run.value"
            :selected-key="contextKey"
            @select="inspectCanvasNode"
          />
          <RunChanges
            v-else-if="activePanel === 'changes'"
            :run="live.run.value"
            :root="live.selectedRoot.value"
            :selected-key="contextKey"
          />
          <ChatPanel
            v-else-if="activePanel === 'chat'"
            :project="live.selectedProject.value || ''"
            :session-key="live.selectedKey.value || ''"
          />
          </aside>
        </ResponsiveDashboardPanel>
      </div>
      </main>
    </UDashboardPanel>
  </UDashboardGroup>
</template>
