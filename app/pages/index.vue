<script setup lang="ts">
import type { DiagnosticIncidentWire } from '#shared/schemas/api'
import { useAtomSet, useAtomValue } from '@effect/atom-vue'
import { normalizeSessionLabel } from '#shared/utils/session-label'
import { activityAtoms, activitySession } from '~/atoms/activity'
import { eventsAtoms, eventsKey } from '~/atoms/events'
import { filtersAtoms } from '~/atoms/filters'
import { preferencesAtoms } from '~/atoms/preferences'
import { rangeAtoms } from '~/atoms/range'
import { runAtoms, runKey } from '~/atoms/run-detail'
import { selectionAtoms } from '~/atoms/selection'
import { sessionEventsAtoms, sessionEventsKey } from '~/atoms/session-events'
import { treeAtoms } from '~/atoms/tree'
import { workspaceAtoms } from '~/atoms/workspace'
import { useAtomModel } from '~/composables/atom'
import { findNode, flattenRunTree } from '~/utils/execution-analysis'
import { feedValue, toFeedView } from '~/utils/feed-view'
import { parseTimestamp } from '~/utils/format'
import { structuralComputed, structurallyEqual } from '~/utils/structural-computed'
import {
  closeContext,
  exitFocus,
  focusFile as focusInvestigationFile,
  focusIncident as focusInvestigationIncident,
  openAgentDetails,
  openAsk,
  openPrimary,
  switchSelectedSession,
  toggleFocus,
  type PrimaryWorkspaceKind,
} from '~/utils/workspace-state'

const route = useRoute()
const router = useRouter()

/**
 * Every atom this page reads, bound once, here.
 *
 * All of it has to happen during `setup()`: the binding resolves its registry
 * with `inject` and falls back to a module-level singleton rather than throwing,
 * so a `useAtom*` call from `onMounted`, a watcher, or a handler would silently
 * read and write state shared with every other component in the process.
 *
 * The four per-selection feeds are subscribed through thunks that read the
 * selection refs, so choosing another agent swaps which atom this component is
 * bound to — and the node behind the old one is torn down with its in-flight
 * request.
 */
const projects = useAtomValue(() => treeAtoms.projects)
const sources = useAtomValue(() => treeAtoms.sources)
const costs = useAtomValue(() => treeAtoms.costs)
const loading = useAtomValue(() => treeAtoms.loading)
const offline = useAtomValue(() => treeAtoms.offline)
const visibleProjects = useAtomValue(() => filtersAtoms.visibleProjects)
const projectOptions = useAtomValue(() => filtersAtoms.projectOptions)
const query = useAtomModel(() => filtersAtoms.query)
const sourceFilter = useAtomModel(() => filtersAtoms.source)
const projectFilter = useAtomModel(() => filtersAtoms.project)
const liveOnly = useAtomModel(() => filtersAtoms.liveOnly)
const attentionOnly = useAtomModel(() => filtersAtoms.attentionOnly)
const hideIdle = useAtomModel(() => filtersAtoms.hideIdle)
const minimumSubagents = useAtomModel(() => filtersAtoms.minimumSubagents)
const sessionSort = useAtomModel(() => filtersAtoms.sort)
const followActive = useAtomModel(() => preferencesAtoms.followActive)
const followOutput = useAtomModel(() => preferencesAtoms.followOutput)
const errorsOnly = useAtomModel(() => preferencesAtoms.errorsOnly)
const density = useAtomModel(() => preferencesAtoms.density)
const hours = useAtomModel(() => rangeAtoms.hours)
const workspaceState = useAtomModel(() => workspaceAtoms.workspace)
const selectedProject = useAtomValue(() => selectionAtoms.project)
const selectedKey = useAtomValue(() => selectionAtoms.key)
const selectedRoot = useAtomValue(() => selectionAtoms.root)
const inspectedKey = useAtomValue(() => selectionAtoms.inspected)
const setSelection = useAtomSet(() => selectionAtoms.selection)
const setInspected = useAtomSet(() => selectionAtoms.inspected)
const runResult = useAtomValue(() =>
  runAtoms.run(runKey(selectedProject.value, selectedKey.value, hours.value)))
const inspectedResult = useAtomValue(() =>
  eventsAtoms.events(eventsKey(selectedProject.value, inspectedKey.value, hours.value)))
const sessionResult = useAtomValue(() =>
  sessionEventsAtoms.sessionEvents(sessionEventsKey(
    selectedProject.value,
    selectedRoot.value?.key ?? selectedKey.value,
    hours.value,
  )))
const activityFeed = useAtomValue(() => activityAtoms.feed)
const activityAgents = useAtomValue(() => activityAtoms.agents)
const activityAgentKey = useAtomModel(() =>
  activityAtoms.agent(activitySession(
    selectedProject.value,
    selectedRoot.value?.key ?? selectedKey.value,
  )))

const run = computed(() => feedValue(runResult.value, response => response, null))
const inspectedEvents = computed(() =>
  feedValue(inspectedResult.value, events => events, []))
// Only while something is inspected: with the overlay closed the feed is gated
// off and sits at `loading` forever, which is not a spinner anybody should see.
const inspectedEventsLoading = computed(() =>
  Boolean(inspectedKey.value) && toFeedView(inspectedResult.value).tag === 'loading')
const sessionEventsTruncated = computed(() =>
  feedValue(sessionResult.value, response => response.truncated, false))
const sessionEventCount = computed(() =>
  feedValue(sessionResult.value, response => response.events.length, 0))

function selectSessionKey(key: string, project = selectedProject.value): void {
  if (project) setSelection({ project, key })
}
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

// A `?view=` in the URL is a view the user asked for, so it wins over whichever
// one the workspace atom was left in.
const initialView = typeof route.query.view === 'string'
  && primaryViews.some(view => view.id === route.query.view)
  ? route.query.view as PrimaryWorkspaceKind
  : 'overview'
workspaceState.value = { ...workspaceState.value, primary: initialView }
// View-local state, and deliberately not atoms: none of it outlives the page,
// and two of them are positions inside a rendered list.
const contextKey = ref<string | null>(null)
const canvasTime = ref<number | null>(null)
const focusedLine = ref<number | null>(null)
const focusedFile = ref<string | null>(null)
const searchOpen = ref(false)
const sidebarCollapsed = ref(false)
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
const { width: viewportWidth } = useWindowSize({ initialWidth: 1440 })
const sidebarWidth = useLocalStorage(SIDEBAR_STORAGE_KEY, SIDEBAR_DEFAULT, { initOnMounted: true })
const panelWidth = useLocalStorage(PANEL_STORAGE_KEY, PANEL_DEFAULT, { initOnMounted: true })
const focusMode = computed(() => workspaceState.value.focused)
// Focus view hides the browser without touching the user's own collapse
// preference, so the layout math has to treat it as hidden all the same.
const sidebarVisible = computed(() => !sidebarCollapsed.value && !focusMode.value)
const effectivePanelWidth = computed(() => Math.min(panelWidth.value, viewportWidth.value * 0.4, PANEL_MAX))
const selectedSessionKey = computed(() => selectedRoot.value?.key || null)
const sessionIdentity = computed(() => selectedProject.value && selectedSessionKey.value
  ? `${selectedProject.value}/${selectedSessionKey.value}`
  : '')
const selectedContextVisible = computed(() => workspaceState.value.context.kind !== 'closed')
const focusTitle = computed(() => normalizeSessionLabel(selectedRoot.value?.label || '', 'Local sessions'))
const contextUsesModal = computed(() => {
  if (viewportWidth.value <= 680) return true
  const browserWidth = sidebarVisible.value ? sidebarWidth.value + 7 : 0
  const availablePrimary = viewportWidth.value - browserWidth - effectivePanelWidth.value - 7
  return availablePrimary < 640
})
/**
 * Only a source we could not open at all belongs on the session overview. A
 * merely degraded source carries a provider-wide skipped-record tally that may
 * come from other sessions entirely; the selected session's own skipped
 * records travel with its run diagnostics instead.
 */
const unavailableSource = computed(() => {
  const source = selectedRoot.value?.source
  if (!source) return null
  return sources.value.find(status => status.source === source && status.state === 'unavailable') || null
})
const sourceUnavailable = computed(() => Boolean(unavailableSource.value))
const selectedSourceMessage = computed(() => unavailableSource.value?.message || '')
const attentionCount = computed(() => (run.value?.diagnostics.incidents || [])
  .filter(incident => incident.severity !== 'info').length)
const sessionAgentCount = computed(() => flattenRunTree(selectedRoot.value).length)
const sessionActivityCount = computed(() => sessionEventCount.value || selectedRoot.value?.subTools || 0)
const sessionChangeCount = computed(() => run.value?.files.length || 0)
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

function clampWidth(width: number, min: number, max: number): number {
  if (!Number.isFinite(width)) return min
  return Math.round(Math.min(Math.max(width, min), max))
}
function fitPanelsToViewport(): void {
  panelWidth.value = clampWidth(panelWidth.value, PANEL_MIN, PANEL_MAX)
  if (viewportWidth.value > 680) {
    sidebarWidth.value = clampWidth(sidebarWidth.value, SIDEBAR_MIN, sidebarMax.value)
  }
}
const inspectedNode = computed(() => findNode(selectedRoot.value, inspectedKey.value))
// The merge itself is an atom; this is only the re-render suppression, which
// `Atom.withEquality` would have carried if the published dist exported it.
const activityEvents = structuralComputed(() => activityFeed.value, structurallyEqual)
const activityAgentOptions = computed(() => [
  { label: 'Whole session', value: 'all' },
  ...activityAgents.value.map(agent => ({ label: agent.label, value: agent.key })),
])

const searchGroups = computed(() => [{
  id: 'sessions',
  label: 'Sessions',
  items: projects.value.flatMap(project => project.roots.map(root => ({
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
    disabled: !selectedRoot.value,
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
  setInspected(null)
  focusedLine.value = null
  focusedFile.value = null
}
function closeContextPanel(): void {
  const wasAgent = workspaceState.value.context.kind === 'agent-details'
  workspaceState.value = closeContext(workspaceState.value)
  if (wasAgent) closeAgentInspection()
  focusWorkspaceHeading()
}
function inspectAgent(key: string): void {
  const alreadyOpen = workspaceState.value.context.kind === 'agent-details'
  setInspected(key)
  contextKey.value = key
  workspaceState.value = openAgentDetails(workspaceState.value, key)
  setInspected(key)
  if (!alreadyOpen) {
    nextTick(() => document.querySelector<HTMLElement>('.inspector-title strong, .inspector-close')?.focus())
  }
}
function inspectIncident(incident: DiagnosticIncidentWire): void {
  if (incident.key) inspectAgent(incident.key)
  focusedLine.value = incident.line
  canvasTime.value = parseTimestamp(incident.ts)
  workspaceState.value = focusInvestigationIncident(workspaceState.value, incident.id)
}
function focusTime(timestamp: number | null, line: number | null = null): void {
  canvasTime.value = timestamp
  focusedLine.value = line
}
function focusFile(path: string | null): void {
  focusedFile.value = path
  workspaceState.value = focusInvestigationFile(workspaceState.value, path || undefined)
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
function leaveFocusView(): void {
  if (!focusMode.value) return
  workspaceState.value = exitFocus(workspaceState.value)
  statusAnnouncement.value = 'Focus view off'
  nextTick(() => document.querySelector<HTMLElement>('.focus-view-action')?.focus())
}
function toggleFocusView(): void {
  if (focusMode.value) {
    leaveFocusView()
    return
  }
  if (!selectedRoot.value) return
  workspaceState.value = toggleFocus(workspaceState.value)
  statusAnnouncement.value = 'Focus view on. Press Escape to exit.'
  focusWorkspaceHeading()
}
function chooseDestination(destination: PrimaryWorkspaceKind | 'ask'): void {
  if (destination === 'ask') openAskPanel()
  else openWorkspace(destination)
}

async function selectSession(project: string, key: string): Promise<void> {
  const projectRuns = projects.value.find(entry => entry.id === project)
  const root = projectRuns?.roots.find(candidate => findNode(candidate, key)) || null
  if (root && root.key !== key) {
    if (selectedProject.value !== project || selectedSessionKey.value !== root.key) {
      sessionSelectionIsManual.value = true
      selectSessionKey(root.key, project)
    }
    inspectAgent(key)
    return
  }
  sessionSelectionIsManual.value = true
  selectSessionKey(key, project)
}

/**
 * Single-key shortcuts must stay out of the way of every text surface the
 * dashboard has: filters, the Ask composer, and the command palette input.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return ['input', 'textarea', 'select'].includes(target.tagName.toLowerCase())
}
function handleShortcut(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing) return
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b' && !event.altKey) {
    event.preventDefault()
    sidebarCollapsed.value = !sidebarCollapsed.value
    return
  }
  if (event.key === 'Escape') {
    // The context panel sits on top of focus view, so it unwinds first.
    if (selectedContextVisible.value) {
      event.preventDefault()
      closeContextPanel()
      return
    }
    if (!focusMode.value) return
    event.preventDefault()
    leaveFocusView()
    return
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return
  if (searchOpen.value || isTypingTarget(event.target)) return
  if (event.key.toLowerCase() !== 'f') return
  event.preventDefault()
  toggleFocusView()
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
        project: selectedProject.value || undefined,
        session: selectedSessionKey.value || undefined,
        view: workspaceState.value.primary,
      },
    })
    if (shouldMoveFocus) focusWorkspaceHeading()
  },
)
watch(
  projects,
  (projects) => {
    if (routeSelectionApplied.value || !projects.length) return
    routeSelectionApplied.value = true
    const projectId = typeof route.query.project === 'string' ? route.query.project : ''
    const rootKey = typeof route.query.session === 'string' ? route.query.session : ''
    if (!projectId || !rootKey) return
    const project = projects.find(entry => entry.id === projectId)
    const root = project?.roots.find(entry => entry.key === rootKey)
    if (!root || (selectedProject.value === projectId && selectedSessionKey.value === rootKey)) return
    selectSessionKey(rootKey, projectId)
  },
  { deep: false },
)
watch(inspectedNode, node => {
  if (inspectedKey.value && !node) closeContextPanel()
})
watch(selectedRoot, root => {
  // Nothing left to focus on; drop back to the full shell rather than
  // stranding the user in a chrome-less empty workspace.
  if (!root && focusMode.value) workspaceState.value = exitFocus(workspaceState.value)
})
watch(attentionCount, (count, previous = 0) => {
  if (count > previous) statusAnnouncement.value = `${count} warning or error ${count === 1 ? 'incident' : 'incidents'} recorded`
})
watch(offline, offline => {
  statusAnnouncement.value = offline ? 'Viewer disconnected' : 'Viewer reconnected'
})
watch(sourceUnavailable, unavailable => {
  statusAnnouncement.value = unavailable ? 'Session source unavailable' : 'Session source recovered'
})
watch(
  () => ({
    identity: sessionIdentity.value,
    live: selectedRoot.value?.subLive,
    finalText: selectedRoot.value?.finalText,
    errors: selectedRoot.value?.subErrors,
  }),
  (current, previous) => {
    if (!previous || current.identity !== previous.identity || previous.live !== true || current.live !== false) return
    statusAnnouncement.value = current.errors && !current.finalText
      ? 'Session failed'
      : 'Session completed'
  },
)
watch(viewportWidth, fitPanelsToViewport)
watch([selectedContextVisible, sidebarCollapsed], () => {
  if (import.meta.client) fitPanelsToViewport()
})
useEventListener('keydown', handleShortcut)
onMounted(() => {
  fitPanelsToViewport()
})
</script>

<template>
  <UDashboardGroup
    class="shell"
    :class="{ 'focus-mode': focusMode }"
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
    <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">{{ statusAnnouncement }}</p>
    <UBadge
      v-if="offline"
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
        v-model:query="query"
        v-model:source-filter="sourceFilter"
        v-model:project-filter="projectFilter"
        v-model:live-only="liveOnly"
        v-model:attention-only="attentionOnly"
        v-model:hide-idle="hideIdle"
        v-model:minimum-subagents="minimumSubagents"
        v-model:session-sort="sessionSort"
        v-model:hours="hours"
        :projects="visibleProjects"
        :all-projects="projects"
        :sources="sources"
        :costs="costs"
        :project-options="projectOptions"
        :loading="loading"
        :selected-project="selectedProject"
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
          v-show="!focusMode"
          v-model:follow-active="followActive"
          :sidebar-visible="sidebarVisible"
          :root="selectedRoot"
          :workspace="workspaceState.primary"
          @show-sidebar="sidebarCollapsed = false"
          @focus="toggleFocusView"
        />

        <div
          class="session-workspace progressive-workspace"
          :class="{ 'panel-open': selectedContextVisible && !contextUsesModal }"
          :style="workspaceStyle"
        >
          <section class="session-primary" :aria-label="`${primaryViews.find(view => view.id === workspaceState.primary)?.label} workspace`">
            <div v-if="focusMode" class="focus-exit">
              <span class="focus-exit-session">
                <UIcon name="i-lucide-focus" />{{ focusTitle }}
              </span>
              <UKbd value="Esc" />
              <UButton
                class="focus-exit-action"
                color="neutral"
                variant="ghost"
                icon="i-lucide-minimize-2"
                aria-label="Exit focus view"
                aria-keyshortcuts="Escape F"
                @click="leaveFocusView"
              />
            </div>

            <OpenViewLauncher
              v-if="!focusMode"
              :current="workspaceState.primary"
              :agent-count="sessionAgentCount"
              :activity-count="sessionActivityCount"
              :change-count="sessionChangeCount"
              :attention-count="attentionCount"
              :ask-active="workspaceState.context.kind === 'ask'"
              :disabled="!selectedRoot"
              @select="chooseDestination"
            />

            <!--
              Lazy on purpose: the canvas pulls in Vue Flow and dagre, which is
              the largest chunk in the app, and the dashboard opens on the
              overview. Loading it with the page would spend that download and
              parse before the first tree ever renders.
            -->
            <KeepAlive :max="10">
              <LazyRunCanvas
                v-if="workspaceState.primary === 'map'"
                :key="sessionIdentity"
                :run="run"
                :root="selectedRoot"
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
                :root="selectedRoot"
                :run="run"
                :loading="loading"
                :source-unavailable="sourceUnavailable"
                :source-message="selectedSourceMessage"
                @open="openWorkspace"
                @ask="openAskPanel"
                @select="inspectAgent"
            >
              <template #active-agents>
                <ActiveAgentsOverview
                  :projects="projects"
                  @select="selectSession"
                />
              </template>
            </RunOverview>

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
                        :class="{ selected: density === option }"
                        :aria-pressed="density === option"
                        @click="density = option"
                      >{{ option }}</button>
                    </div>
                    <UButton
                      type="button"
                      class="quiet-action"
                      color="neutral"
                      variant="ghost"
                      icon="i-lucide-circle-alert"
                      :class="{ active: errorsOnly }"
                      :aria-pressed="errorsOnly"
                      @click="errorsOnly = !errorsOnly"
                    >Errors</UButton>
                    <UButton
                      type="button"
                      class="quiet-action"
                      color="neutral"
                      variant="ghost"
                      icon="i-lucide-arrow-down-to-line"
                      :class="{ active: followOutput }"
                      :aria-pressed="followOutput"
                      @click="followOutput = !followOutput"
                    >Follow</UButton>
                  </div>
                </header>
                <EventFeed
                  :events="activityEvents"
                  :density="density"
                  :errors-only="errorsOnly"
                  :follow-output="followOutput"
                  :truncated="sessionEventsTruncated"
                  session-wide
                  @select="inspectAgent"
                />
            </div>

            <div v-if="workspaceState.primary === 'changes'" class="primary-list-workspace">
              <RunChanges
                :run="run"
                :root="selectedRoot"
                :selected-key="contextKey"
              />
            </div>

            <div v-if="workspaceState.primary === 'diagnostics'" class="primary-list-workspace">
              <RunDiagnostics
                :run="run"
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
              :run="run"
              :root="selectedRoot"
              :selected="inspectedNode"
              :selected-key="inspectedKey"
              :project="selectedProject || ''"
              :hours="hours"
              :events="inspectedEvents"
              :events-loading="inspectedEventsLoading"
              :current-time="canvasTime"
              :focused-line="focusedLine"
              :focused-file="focusedFile"
              @select="inspectAgent"
              @close="closeContextPanel"
              @focus-time="focusTime"
              @focus-file="focusFile"
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
                  :project="selectedProject || ''"
                  :session-key="selectedSessionKey || ''"
                  :hours="hours"
                />
              </KeepAlive>
            </aside>
          </ResponsiveDashboardPanel>
        </div>
      </main>
    </UDashboardPanel>
  </UDashboardGroup>
</template>
