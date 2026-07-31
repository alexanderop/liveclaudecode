<script setup lang="ts">
import type { RunNode, TranscriptEvent } from '#shared/types/run'
import { normalizeSessionLabel } from '#shared/utils/session-label'
import { flattenRunTree } from '~/utils/execution-analysis'
import {
  closeContext,
  initialWorkspaceState,
  openAgentDetails,
  openAsk,
  openPrimary,
  switchSelectedSession,
  type PrimaryWorkspaceKind,
  type WorkspaceState,
} from '~/utils/workspace-state'

const live = useLiveRuns()
const route = useRoute()
const router = useRouter()
const densities = ['compact', 'normal', 'raw'] as const
const primaryViews = [
  { id: 'overview', label: 'Overview', icon: 'i-lucide-layout-dashboard', shortcut: 'N' },
  { id: 'map', label: 'Agents', icon: 'i-lucide-workflow', shortcut: 'M' },
  { id: 'activity', label: 'Activity', icon: 'i-lucide-activity', shortcut: 'A' },
  { id: 'changes', label: 'Changes', icon: 'i-lucide-files', shortcut: 'D' },
  { id: 'diagnostics', label: 'Diagnostics', icon: 'i-lucide-stethoscope', shortcut: 'I' },
] as const
const launcherViews = [
  ...primaryViews,
  { id: 'ask', label: 'Ask', icon: 'i-lucide-message-square', shortcut: 'Q' },
] as const

const initialView = typeof route.query.view === 'string'
  && primaryViews.some(view => view.id === route.query.view)
  ? route.query.view as PrimaryWorkspaceKind
  : 'overview'
const workspaceState = ref<WorkspaceState>({
  ...initialWorkspaceState(),
  primary: initialView,
})
const inspectedKey = ref<string | null>(null)
const contextKey = ref<string | null>(null)
const canvasTime = ref<number | null>(null)
const focusedLine = ref<number | null>(null)
const focusedFile = ref<string | null>(null)
const activityAgentBySession = reactive<Record<string, string>>({})
const searchOpen = ref(false)
const sidebarCollapsed = ref(false)
const viewportWidth = ref(1440)
const sidebarWidth = ref(272)
const panelWidth = ref(380)
const statusAnnouncement = ref('')
const sessionSelectionIsManual = ref(false)
const routeSelectionApplied = ref(false)

const SIDEBAR_MIN = 220
const SIDEBAR_MAX = 480
const SIDEBAR_DEFAULT = 272
const PANEL_MIN = 280
const PANEL_MAX = 720
const PANEL_DEFAULT = 380
const RESIZE_HANDLES_WIDTH = 14
const SIDEBAR_STORAGE_KEY = 'liveclaudecode:sidebar-width'
const PANEL_STORAGE_KEY = 'liveclaudecode:panel-width'
const sidebarVisible = computed(() => !sidebarCollapsed.value)
const effectivePanelWidth = computed(() => Math.min(panelWidth.value, viewportWidth.value * 0.4, PANEL_MAX))
const selectedSessionKey = computed(() => live.selectedRoot.value?.key || null)
const sessionIdentity = computed(() => live.selectedProject.value && selectedSessionKey.value
  ? `${live.selectedProject.value}/${selectedSessionKey.value}`
  : '')
const selectedContextVisible = computed(() => workspaceState.value.context.kind !== 'closed')
const contextUsesModal = computed(() => {
  if (viewportWidth.value <= 680) return true
  const browserWidth = sidebarVisible.value ? sidebarWidth.value + 7 : 0
  const availablePrimary = viewportWidth.value - browserWidth - effectivePanelWidth.value - 7
  return availablePrimary < 640
})
const sourceIncomplete = computed(() => {
  const source = live.selectedRoot.value?.source
  if (!source) return false
  return live.sources.value.some(status => status.source === source && status.state !== 'ready')
})
const selectedSourceMessage = computed(() => {
  const source = live.selectedRoot.value?.source
  if (!source) return ''
  return live.sources.value.find(status => status.source === source && status.state !== 'ready')?.message || ''
})
const attentionCount = computed(() => (live.run.value?.diagnostics.incidents || [])
  .filter(incident => incident.severity !== 'info').length)
const sessionAgentCount = computed(() => flattenRunTree(live.selectedRoot.value).length)
const sessionActivityCount = computed(() => live.sessionEvents.value.length || live.selectedRoot.value?.subTools || 0)
const sessionChangeCount = computed(() => live.run.value?.files.length || 0)
const activityAgentKey = computed({
  get: () => activityAgentBySession[sessionIdentity.value] || 'all',
  set: value => {
    if (sessionIdentity.value) activityAgentBySession[sessionIdentity.value] = value
  },
})

const sidebarMax = computed(() => {
  if (viewportWidth.value <= 680) return SIDEBAR_MAX
  const dockedPanelWidth = selectedContextVisible.value && !contextUsesModal.value ? panelWidth.value : 0
  return Math.max(
    SIDEBAR_MIN,
    Math.min(SIDEBAR_MAX, viewportWidth.value - dockedPanelWidth - 640 - RESIZE_HANDLES_WIDTH),
  )
})
const panelMax = computed(() => {
  const browserWidth = sidebarVisible.value ? sidebarWidth.value : 0
  return Math.max(
    PANEL_MIN,
    Math.min(PANEL_MAX, viewportWidth.value * 0.4, viewportWidth.value - browserWidth - 640 - RESIZE_HANDLES_WIDTH),
  )
})
const workspaceStyle = computed(() => ({ '--panel-width': `${effectivePanelWidth.value}px` }))
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
    // Storage is an enhancement; the workspace remains usable without it.
  }
}
function fitPanelsToViewport(): void {
  viewportWidth.value = window.innerWidth
  panelWidth.value = clampWidth(panelWidth.value, PANEL_MIN, PANEL_MAX)
  if (viewportWidth.value > 680) {
    sidebarWidth.value = clampWidth(sidebarWidth.value, SIDEBAR_MIN, sidebarMax.value)
  }
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

const searchGroups = computed(() => [{
  id: 'sessions',
  label: 'Sessions',
  items: live.projects.value.flatMap(project => project.roots.map(root => ({
    id: `${project.id}/${root.key}`,
    label: normalizeSessionLabel(root.label, root.key),
    description: project.name,
    suffix: root.subLive ? 'Running' : root.subErrors ? 'Attention' : root.source,
    icon: root.subLive ? 'i-lucide-radio' : root.subErrors ? 'i-lucide-circle-alert' : 'i-lucide-message-square-code',
    onSelect: () => {
      searchOpen.value = false
      void selectSession(project.id, root.key)
    },
  }))),
}, {
  id: 'views',
  label: 'Session views',
  items: launcherViews.map(view => ({
    id: view.id,
    label: view.label,
    icon: view.icon,
    kbds: [view.shortcut],
    disabled: !live.selectedRoot.value,
    onSelect: () => {
      searchOpen.value = false
      chooseDestination(view.id)
    },
  })),
}])

function focusWorkspaceHeading(): void {
  nextTick(() => {
    document.querySelector<HTMLElement>('.session-primary [data-workspace-heading], .session-primary h2')?.focus()
  })
}
function closeAgentInspection(): void {
  inspectedKey.value = null
  focusedLine.value = null
  focusedFile.value = null
  live.clearInspection()
}
function closeContextPanel(): void {
  const wasAgent = workspaceState.value.context.kind === 'agent-details'
  workspaceState.value = closeContext(workspaceState.value)
  if (wasAgent) closeAgentInspection()
  focusWorkspaceHeading()
}
function inspectAgent(key: string): void {
  const alreadyOpen = workspaceState.value.context.kind === 'agent-details'
  inspectedKey.value = key
  contextKey.value = key
  workspaceState.value = openAgentDetails(workspaceState.value, key)
  void live.inspect(key)
  if (!alreadyOpen) {
    nextTick(() => document.querySelector<HTMLElement>('.inspector-title strong, .inspector-close')?.focus())
  }
}
function inspectIncident(incident: { id?: string, key?: string, line: number, ts: string | null }): void {
  if (incident.key) inspectAgent(incident.key)
  focusedLine.value = incident.line
  canvasTime.value = incident.ts ? Date.parse(incident.ts) : null
  workspaceState.value.investigation.incidentId = incident.id
}
function focusTime(timestamp: number | null, line: number | null = null): void {
  canvasTime.value = timestamp
  focusedLine.value = line
}
function focusFile(path: string | null): void {
  focusedFile.value = path
  workspaceState.value.investigation.filePath = path || undefined
}
function openWorkspace(destination: PrimaryWorkspaceKind): void {
  const closingAgent = workspaceState.value.context.kind === 'agent-details'
  workspaceState.value = openPrimary(workspaceState.value, destination)
  if (closingAgent) closeAgentInspection()
  void router.replace({ query: { ...route.query, view: destination } })
  focusWorkspaceHeading()
}
function openAskPanel(): void {
  if (!sessionIdentity.value) return
  if (workspaceState.value.context.kind === 'agent-details') closeAgentInspection()
  workspaceState.value = openAsk(workspaceState.value, sessionIdentity.value)
  nextTick(() => document.querySelector<HTMLElement>('.chat-panel [aria-label="Question about this session"], .chat-panel button')?.focus())
}
function chooseDestination(destination: PrimaryWorkspaceKind | 'ask'): void {
  if (destination === 'ask') openAskPanel()
  else openWorkspace(destination)
}

async function selectSession(project: string, key: string): Promise<void> {
  const projectRuns = live.projects.value.find(entry => entry.id === project)
  const findRootForKey = (nodes: RunNode[]): RunNode | null => {
    for (const node of nodes) {
      if (node.key === key || flattenRunTree(node).some(candidate => candidate.key === key)) return node
    }
    return null
  }
  const root = projectRuns ? findRootForKey(projectRuns.roots) : null
  if (root && root.key !== key) {
    if (live.selectedProject.value !== project || selectedSessionKey.value !== root.key) {
      sessionSelectionIsManual.value = true
      await live.select(root.key, project)
    }
    inspectAgent(key)
    return
  }
  sessionSelectionIsManual.value = true
  await live.select(key, project)
}

function handleShortcut(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing) return
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b' && !event.altKey) {
    event.preventDefault()
    sidebarCollapsed.value = !sidebarCollapsed.value
    return
  }
  if (event.key !== 'Escape') return
  if (selectedContextVisible.value && contextUsesModal.value) {
    event.preventDefault()
    closeContextPanel()
  } else if (selectedContextVisible.value) {
    event.preventDefault()
    closeContextPanel()
  }
}

watch(
  sessionIdentity,
  (identity, previous) => {
    if (!identity || identity === previous) return
    const shouldMoveFocus = Boolean(previous && sessionSelectionIsManual.value)
    workspaceState.value = switchSelectedSession(workspaceState.value)
    closeAgentInspection()
    contextKey.value = null
    if (!previous || !sessionSelectionIsManual.value) {
      workspaceState.value = { ...workspaceState.value, primary: initialView }
    }
    sessionSelectionIsManual.value = false
    void router.replace({
      query: {
        ...route.query,
        project: live.selectedProject.value || undefined,
        session: selectedSessionKey.value || undefined,
        view: workspaceState.value.primary,
      },
    })
    if (shouldMoveFocus) focusWorkspaceHeading()
  },
)
watch(
  () => live.projects.value,
  (projects) => {
    if (routeSelectionApplied.value || !projects.length) return
    routeSelectionApplied.value = true
    const projectId = typeof route.query.project === 'string' ? route.query.project : ''
    const rootKey = typeof route.query.session === 'string' ? route.query.session : ''
    if (!projectId || !rootKey) return
    const project = projects.find(entry => entry.id === projectId)
    const root = project?.roots.find(entry => entry.key === rootKey)
    if (!root || (live.selectedProject.value === projectId && selectedSessionKey.value === rootKey)) return
    void live.select(rootKey, projectId)
  },
  { deep: false },
)
watch(inspectedNode, node => {
  if (inspectedKey.value && !node) closeContextPanel()
})
watch(attentionCount, (count, previous = 0) => {
  if (count > previous) statusAnnouncement.value = `${count} warning or error ${count === 1 ? 'incident' : 'incidents'} recorded`
})
watch(() => live.offline.value, offline => {
  statusAnnouncement.value = offline ? 'Viewer disconnected' : 'Viewer reconnected'
})
watch(sourceIncomplete, incomplete => {
  statusAnnouncement.value = incomplete ? 'Session source degraded' : 'Session source recovered'
})
watch(
  () => ({
    identity: sessionIdentity.value,
    live: live.selectedRoot.value?.subLive,
    finalText: live.selectedRoot.value?.finalText,
    errors: live.selectedRoot.value?.subErrors,
  }),
  (current, previous) => {
    if (!previous || current.identity !== previous.identity || previous.live !== true || current.live !== false) return
    statusAnnouncement.value = current.errors && !current.finalText
      ? 'Session failed'
      : 'Session completed'
  },
)
watch(panelWidth, width => persistWidth(PANEL_STORAGE_KEY, width))
watch(sidebarWidth, width => persistWidth(SIDEBAR_STORAGE_KEY, width))
watch([selectedContextVisible, sidebarCollapsed], () => {
  if (import.meta.client) fitPanelsToViewport()
})
onMounted(() => {
  sidebarWidth.value = clampWidth(readStoredWidth(SIDEBAR_STORAGE_KEY, SIDEBAR_DEFAULT), SIDEBAR_MIN, SIDEBAR_MAX)
  panelWidth.value = clampWidth(readStoredWidth(PANEL_STORAGE_KEY, PANEL_DEFAULT), PANEL_MIN, PANEL_MAX)
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
  <UDashboardGroup class="shell" storage="local" storage-key="liveclaudecode" unit="px">
    <UDashboardSearch
      v-model:open="searchOpen"
      :groups="searchGroups"
      placeholder="Jump to a session or view…"
      :color-mode="false"
      virtualize
    />
    <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">{{ statusAnnouncement }}</p>
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
        v-model:minimum-subagents="live.minimumSubagents.value"
        v-model:session-sort="live.sessionSort.value"
        v-model:hours="live.hours.value"
        :projects="live.visibleProjects.value"
        :all-projects="live.projects.value"
        :sources="live.sources.value"
        :project-options="live.projectOptions.value"
        :loading="live.loading.value"
        :selected-project="live.selectedProject.value"
        :selected-key="selectedSessionKey"
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
          :workspace="workspaceState.primary"
          @show-sidebar="sidebarCollapsed = false"
        />

        <div
          class="session-workspace progressive-workspace"
          :class="{ 'panel-open': selectedContextVisible && !contextUsesModal }"
          :style="workspaceStyle"
        >
          <section class="session-primary" :aria-label="`${primaryViews.find(view => view.id === workspaceState.primary)?.label} workspace`">
            <OpenViewLauncher
              :current="workspaceState.primary"
              :agent-count="sessionAgentCount"
              :activity-count="sessionActivityCount"
              :change-count="sessionChangeCount"
              :attention-count="attentionCount"
              :ask-active="workspaceState.context.kind === 'ask'"
              :disabled="!live.selectedRoot.value"
              @select="chooseDestination"
            />

            <KeepAlive :max="10">
              <RunCanvas
                v-if="workspaceState.primary === 'map'"
                :key="sessionIdentity"
                :run="live.run.value"
                :root="live.selectedRoot.value"
                :selected-key="inspectedKey"
                :inspector-open="workspaceState.context.kind === 'agent-details'"
                :focused-file="focusedFile"
                @select="inspectAgent"
                @deselect="workspaceState.context.kind === 'agent-details' && closeContextPanel()"
                @inspect-incident="inspectIncident"
                @focus-time="focusTime"
                @focus-file="focusFile"
                @open-activity="openWorkspace('activity')"
              />
            </KeepAlive>

            <RunOverview
                v-if="workspaceState.primary === 'overview'"
                :root="live.selectedRoot.value"
                :run="live.run.value"
                :loading="live.loading.value"
                :source-incomplete="sourceIncomplete"
                :source-message="selectedSourceMessage"
                :projects="live.projects.value"
                @open="openWorkspace"
                @ask="openAskPanel"
                @select="inspectAgent"
                @select-agent="selectSession"
            />

            <div v-if="workspaceState.primary === 'activity'" class="primary-list-workspace activity-workspace">
                <header class="primary-workspace-heading">
                  <div>
                    <span class="section-eyebrow">Session timeline</span>
                    <h1 data-workspace-heading tabindex="-1">Activity</h1>
                  </div>
                  <div class="session-panel-controls">
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
                    >Errors</UButton>
                    <UButton
                      type="button"
                      class="quiet-action"
                      color="neutral"
                      variant="ghost"
                      icon="i-lucide-arrow-down-to-line"
                      :class="{ active: live.followOutput.value }"
                      :aria-pressed="live.followOutput.value"
                      @click="live.followOutput.value = !live.followOutput.value"
                    >Follow</UButton>
                  </div>
                </header>
                <EventFeed
                  :events="activityEvents"
                  :density="live.density.value"
                  :errors-only="live.errorsOnly.value"
                  :follow-output="live.followOutput.value"
                  :truncated="live.sessionEventsTruncated.value"
                  session-wide
                  @select="inspectAgent"
                />
            </div>

            <div v-if="workspaceState.primary === 'changes'" class="primary-list-workspace">
              <RunChanges
                :run="live.run.value"
                :root="live.selectedRoot.value"
                :selected-key="contextKey"
              />
            </div>

            <div v-if="workspaceState.primary === 'diagnostics'" class="primary-list-workspace">
              <RunDiagnostics
                :run="live.run.value"
                :selected-key="contextKey"
                @select="inspectAgent"
              />
            </div>
          </section>

          <PanelResizeHandle
            v-if="selectedContextVisible && !contextUsesModal"
            v-model="panelWidth"
            class="workspace-panel-resize-handle"
            :min="PANEL_MIN"
            :max="panelMax"
            :default-value="PANEL_DEFAULT"
            direction="left"
            label="Resize context panel"
          />

          <ResponsiveDashboardPanel
            v-if="selectedContextVisible"
            :mobile="contextUsesModal"
            :title="workspaceState.context.kind === 'agent-details' ? 'Agent details' : 'Ask about this session'"
            @close="closeContextPanel"
          >
            <RunInspector
              v-if="workspaceState.context.kind === 'agent-details'"
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
              @select="inspectAgent"
              @close="closeContextPanel"
              @focus-time="focusTime"
              @focus-file="focusFile"
              @update:density="live.density.value = $event"
              @update:errors-only="live.errorsOnly.value = $event"
            />

            <aside v-else class="session-panel ask-context" aria-label="Ask about this session">
              <header class="session-panel-title">
                <span><UIcon name="i-lucide-message-square" />Ask</span>
                <UButton color="neutral" variant="ghost" icon="i-lucide-x" aria-label="Close Ask" @click="closeContextPanel" />
              </header>
              <KeepAlive :max="10">
                <ChatPanel
                  v-if="workspaceState.context.kind === 'ask'"
                  :key="sessionIdentity"
                  :project="live.selectedProject.value || ''"
                  :session-key="selectedSessionKey || ''"
                  :hours="live.hours.value"
                />
              </KeepAlive>
            </aside>
          </ResponsiveDashboardPanel>
        </div>
      </main>
    </UDashboardPanel>
  </UDashboardGroup>
</template>
