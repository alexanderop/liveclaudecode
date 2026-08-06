import type { ComputedRef, ShallowRef } from 'vue'
import type {
  CostSummary,
  ProjectRuns,
  RunNode,
  RunResponse,
  SessionEventsResponse,
  SessionSourceStatus,
  TranscriptEvent,
  TreeResponse,
} from '#shared/types/run'
import type { SessionSort } from '~/utils/session-filter'
import type { ProjectOption, SessionSourceFilter } from '~/composables/useSessionFilters'
import { createLatestRequestGate } from '~/utils/latest-request-gate'
import { deepestLiveNode, flattenRunTree } from '~/utils/execution-analysis'

export type FeedDensity = 'compact' | 'normal' | 'raw'
export type SessionRangeHours = number

export interface UseLiveRunsOptions {
  /**
   * Poll cadence for the session tree, in milliseconds.
   *
   * @default 4000
   */
  treeIntervalMs?: number
  /**
   * Poll cadence for selected and inspected transcript events, in
   * milliseconds.
   *
   * @default 2000
   */
  eventsIntervalMs?: number
  /**
   * Poll cadence for the selected run detail, in milliseconds.
   *
   * @default 6000
   */
  runIntervalMs?: number
  /**
   * Poll cadence for the merged session activity feed, in milliseconds.
   *
   * @default 4000
   */
  sessionEventsIntervalMs?: number
  /**
   * Maximum number of merged session events fetched per poll.
   *
   * @default 800
   */
  sessionEventsLimit?: number
}

export interface UseLiveRunsReturn {
  /** All discovered projects with their session trees, unfiltered. */
  readonly projects: Readonly<ShallowRef<ProjectRuns[]>>
  /** Per-source scanner status, e.g. a provider that failed to load. */
  readonly sources: Readonly<ShallowRef<SessionSourceStatus[]>>
  /** Aggregated cost summary for the visible range, when available. */
  readonly costs: Readonly<ShallowRef<CostSummary | null>>
  /** True until the first tree response (or failure) arrives. */
  readonly loading: Readonly<ShallowRef<boolean>>
  /** True while the server is unreachable; cleared by the next success. */
  readonly offline: Readonly<ShallowRef<boolean>>
  /** Projects with the sidebar filters applied. */
  readonly visibleProjects: ComputedRef<ProjectRuns[]>
  /** All known projects as name-sorted select options, unfiltered. */
  readonly projectOptions: ComputedRef<ProjectOption[]>
  /** Project id of the current selection, or `null` before the first load. */
  readonly selectedProject: Readonly<ShallowRef<string | null>>
  /** Key of the selected agent, or `null` before the first load. */
  readonly selectedKey: Readonly<ShallowRef<string | null>>
  /** Tree node of the selected agent, when it exists in the current tree. */
  readonly selectedNode: ComputedRef<RunNode | null>
  /** Root session node the selected agent belongs to. */
  readonly selectedRoot: ComputedRef<RunNode | null>
  /** Detail payload for the selected agent (lanes, files, diagnostics). */
  readonly run: Readonly<ShallowRef<RunResponse | null>>
  /** Transcript events of the selected agent. */
  readonly events: Readonly<ShallowRef<TranscriptEvent[]>>
  /** Merged activity feed across every agent of the selected session. */
  readonly sessionEvents: Readonly<ShallowRef<TranscriptEvent[]>>
  /** True when the session feed hit the per-poll limit and dropped events. */
  readonly sessionEventsTruncated: Readonly<ShallowRef<boolean>>
  /** Transcript events of the agent opened in the inspector overlay. */
  readonly inspectedEvents: Readonly<ShallowRef<TranscriptEvent[]>>
  /** True while the first inspector poll for a new target is in flight. */
  readonly inspectedEventsLoading: Readonly<ShallowRef<boolean>>
  /** Free-text search across projects, session labels, and agents. */
  readonly query: ShallowRef<string>
  /** Restrict sessions to one transcript source. */
  readonly sourceFilter: ShallowRef<SessionSourceFilter>
  /** Restrict sessions to one project id, or `'all'`. */
  readonly projectFilter: ShallowRef<string>
  /** Show only sessions with live activity. */
  readonly liveOnly: ShallowRef<boolean>
  /** Show only finished sessions that ended with errors. */
  readonly attentionOnly: ShallowRef<boolean>
  /** Hide empty sessions that never recorded any activity. */
  readonly hideIdle: ShallowRef<boolean>
  /** Minimum number of subagents a session must have spawned. */
  readonly minimumSubagents: ShallowRef<number>
  /** Session ordering within a project. */
  readonly sessionSort: ShallowRef<SessionSort>
  /** Automatically follow the most recently active live agent. */
  readonly followActive: ShallowRef<boolean>
  /** Keep the event feed scrolled to the newest output. */
  readonly followOutput: ShallowRef<boolean>
  /** Show only error events in the feed. */
  readonly errorsOnly: ShallowRef<boolean>
  /** Rendering density of the event feed. */
  readonly density: ShallowRef<FeedDensity>
  /** Time range of sessions to show, in hours; `0` means all time. */
  readonly hours: ShallowRef<SessionRangeHours>
  /** Select an agent (and optionally another project) and load its detail. */
  readonly select: (key: string, project?: string | null) => Promise<void>
  /** Open an agent of the selected session in the inspector overlay. */
  readonly inspect: (key: string) => Promise<void>
  /** Close the inspector overlay and drop its stream. */
  readonly clearInspection: () => void
}

/**
 * Client state for the live dashboard: polls the session tree, the selected
 * run's detail and transcript streams, exposes sidebar filters, and keeps
 * every response guarded against stale delivery when the selection or time
 * range changes mid-flight.
 */
export function useLiveRuns(options: UseLiveRunsOptions = {}): UseLiveRunsReturn {
  const {
    treeIntervalMs = 4_000,
    eventsIntervalMs = 2_000,
    runIntervalMs = 6_000,
    sessionEventsIntervalMs = 4_000,
    sessionEventsLimit = 800,
  } = options

  const projects = shallowRef<ProjectRuns[]>([])
  const sources = shallowRef<SessionSourceStatus[]>([])
  const costs = shallowRef<CostSummary | null>(null)
  const loading = shallowRef(true)
  const offline = shallowRef(false)
  const selectedProject = shallowRef<string | null>(null)
  const selectedKey = shallowRef<string | null>(null)
  const run = shallowRef<RunResponse | null>(null)
  const sessionEvents = shallowRef<TranscriptEvent[]>([])
  const sessionEventsTruncated = shallowRef(false)
  const inspectedKey = shallowRef<string | null>(null)
  const inspectedEventsLoading = shallowRef(false)
  const followActive = shallowRef(false)
  const followOutput = shallowRef(true)
  const errorsOnly = shallowRef(false)
  const density = shallowRef<FeedDensity>('normal')
  const hours = shallowRef<SessionRangeHours>(168)
  let treePending = false
  let treeReloadQueued = false
  let treeGeneration = 0
  let rangeInitialized = false
  let disposed = false
  const requestControllers = new Set<AbortController>()
  const runRequests = createLatestRequestGate()
  const sessionEventRequests = createLatestRequestGate()

  const filters = useSessionFilters(projects)

  const nodeIndex = computed(() => {
    const map = new Map<string, { node: RunNode, parent: string | null }>()
    const visit = (project: string, nodes: RunNode[], parent: string | null): void => {
      nodes.forEach((node) => {
        map.set(`${project}\0${node.key}`, { node, parent })
        visit(project, node.children, node.key)
      })
    }
    projects.value.forEach(project => visit(project.id, project.roots, null))
    return map
  })

  const selectedIndexKey = computed(() =>
    selectedProject.value && selectedKey.value
      ? `${selectedProject.value}\0${selectedKey.value}`
      : null,
  )

  const selectedNode = computed(() =>
    selectedIndexKey.value ? nodeIndex.value.get(selectedIndexKey.value)?.node || null : null,
  )

  const selectedRoot = computed(() => {
    if (!selectedIndexKey.value || !selectedProject.value) return null
    let current = nodeIndex.value.get(selectedIndexKey.value)
    while (current?.parent) current = nodeIndex.value.get(`${selectedProject.value}\0${current.parent}`)
    return current?.node || null
  })

  async function request<T>(
    url: string,
    isCurrent: () => boolean = () => true,
  ): Promise<T | null> {
    if (disposed) return null
    const controller = new AbortController()
    requestControllers.add(controller)
    try {
      const result = await $fetch(url, { signal: controller.signal })
      if (disposed) return null
      if (isCurrent()) offline.value = false
      return result as T
    } catch {
      if (!disposed && !controller.signal.aborted && isCurrent()) offline.value = true
      return null
    } finally {
      requestControllers.delete(controller)
    }
  }

  async function loadTree(): Promise<void> {
    if (disposed) return
    if (treePending) {
      treeReloadQueued = true
      return
    }
    treePending = true
    const requestGeneration = treeGeneration
    const requestedHours = rangeInitialized ? hours.value : null
    const isCurrent = () => treeGeneration === requestGeneration
      && (requestedHours === null ? !rangeInitialized : requestedHours === hours.value)
    try {
      const response = await request<TreeResponse>(requestedHours === null
        ? '/api/tree'
        : `/api/tree?hours=${requestedHours}`, isCurrent)
      if (!isCurrent()) return
      if (!response) {
        loading.value = false
        return
      }
      if (!rangeInitialized) {
        hours.value = response.hours
        await nextTick()
        if (!isCurrent()) return
        rangeInitialized = true
      }
      projects.value = response.projects
      sources.value = response.sources
      costs.value = response.costs || null
      loading.value = false

      if (!selectedKey.value) {
        const firstProject = filters.visibleProjects.value.find(project => project.roots.length)
        if (firstProject) void select(deepestLiveNode(firstProject.roots[0]!).key, firstProject.id)
        return
      }
      if (followActive.value && selectedRoot.value) {
        const live = flattenRunTree(selectedRoot.value)
          .filter(node => node.live)
          .sort((a, b) => b.mtime - a.mtime)[0]
        if (live && live.key !== selectedKey.value) void select(live.key, selectedProject.value!)
      }
    } finally {
      treePending = false
      if (treeReloadQueued) {
        treeReloadQueued = false
        void loadTree()
      }
    }
  }

  async function loadRun(): Promise<void> {
    const key = selectedKey.value
    const project = selectedProject.value
    if (!key || !project) return
    const requestedHours = hours.value
    const requestKey = `${project}\0${key}\0${requestedHours}`
    const pending = runRequests.start(requestKey)
    if (!pending) return
    try {
      const response = await request<RunResponse>(
        `/api/run?project=${encodeURIComponent(project)}&key=${encodeURIComponent(key)}&hours=${requestedHours}`,
        () => runRequests.isCurrent(pending),
      )
      if (
        response
        && runRequests.isCurrent(pending)
        && selectedKey.value === key
        && selectedProject.value === project
        && hours.value === requestedHours
      ) run.value = response
    } finally {
      runRequests.settle(pending)
    }
  }

  const selectedStream = useEventStream({
    key: () => selectedKey.value,
    project: () => selectedProject.value,
    hours: () => hours.value,
    request,
  })

  async function pollSessionEvents(): Promise<void> {
    const key = selectedRoot.value?.key || selectedKey.value
    const project = selectedProject.value
    if (!key || !project) return
    const requestedHours = hours.value
    const requestKey = `${project}\0${key}\0${requestedHours}`
    const pending = sessionEventRequests.start(requestKey)
    if (!pending) return
    try {
      const response = await request<SessionEventsResponse>(
        `/api/session-events?project=${encodeURIComponent(project)}&key=${encodeURIComponent(key)}&limit=${sessionEventsLimit}&hours=${requestedHours}`,
        () => sessionEventRequests.isCurrent(pending),
      )
      if (
        !response
        || !sessionEventRequests.isCurrent(pending)
        || (selectedRoot.value?.key || selectedKey.value) !== key
        || selectedProject.value !== project
        || hours.value !== requestedHours
      ) return
      sessionEvents.value = response.events
      sessionEventsTruncated.value = response.truncated
    } finally {
      sessionEventRequests.settle(pending)
    }
  }

  const inspectedStream = useEventStream({
    key: () => inspectedKey.value,
    project: () => selectedProject.value,
    hours: () => hours.value,
    request,
    settled: (key) => {
      if (inspectedKey.value === key) inspectedEventsLoading.value = false
      else if (inspectedKey.value) void inspectedStream.poll()
    },
  })

  async function inspect(key: string): Promise<void> {
    if (!selectedProject.value) return
    if (inspectedKey.value !== key) {
      inspectedKey.value = key
      inspectedStream.reset()
      inspectedEventsLoading.value = true
    }
    await inspectedStream.poll()
  }

  function clearInspection(): void {
    inspectedKey.value = null
    inspectedStream.reset()
    inspectedEventsLoading.value = false
  }

  async function select(key: string, project = selectedProject.value): Promise<void> {
    if (!project) return
    if (key === selectedKey.value && project === selectedProject.value && run.value) return
    clearInspection()
    selectedProject.value = project
    selectedKey.value = key
    selectedStream.reset()
    sessionEvents.value = []
    sessionEventsTruncated.value = false
    run.value = null
    await Promise.all([selectedStream.poll(), loadRun(), pollSessionEvents()])
  }

  watch(hours, () => {
    if (!rangeInitialized) return
    treeGeneration += 1
    loading.value = true
    projects.value = []
    selectedProject.value = null
    selectedKey.value = null
    run.value = null
    selectedStream.reset()
    runRequests.invalidate()
    sessionEventRequests.invalidate()
    sessionEvents.value = []
    sessionEventsTruncated.value = false
    clearInspection()
    void loadTree()
  })

  const pollers = [
    useIntervalFn(loadTree, treeIntervalMs, { immediate: false }),
    useIntervalFn(() => {
      void selectedStream.poll()
      void inspectedStream.poll()
    }, eventsIntervalMs, { immediate: false }),
    useIntervalFn(loadRun, runIntervalMs, { immediate: false }),
    useIntervalFn(pollSessionEvents, sessionEventsIntervalMs, { immediate: false }),
  ]

  onMounted(() => {
    void loadTree()
    pollers.forEach(poller => poller.resume())
  })

  tryOnScopeDispose(() => {
    disposed = true
    treeGeneration += 1
    treeReloadQueued = false
    runRequests.invalidate()
    sessionEventRequests.invalidate()
    selectedStream.reset()
    inspectedStream.reset()
    requestControllers.forEach(controller => controller.abort())
    requestControllers.clear()
  })

  return {
    projects: shallowReadonly(projects),
    sources: shallowReadonly(sources),
    costs: shallowReadonly(costs),
    loading: shallowReadonly(loading),
    offline: shallowReadonly(offline),
    visibleProjects: filters.visibleProjects,
    projectOptions: filters.projectOptions,
    selectedProject: shallowReadonly(selectedProject),
    selectedKey: shallowReadonly(selectedKey),
    selectedNode,
    selectedRoot,
    run: shallowReadonly(run),
    events: shallowReadonly(selectedStream.events),
    sessionEvents: shallowReadonly(sessionEvents),
    sessionEventsTruncated: shallowReadonly(sessionEventsTruncated),
    inspectedEvents: shallowReadonly(inspectedStream.events),
    inspectedEventsLoading: shallowReadonly(inspectedEventsLoading),
    query: filters.query,
    sourceFilter: filters.sourceFilter,
    projectFilter: filters.projectFilter,
    liveOnly: filters.liveOnly,
    attentionOnly: filters.attentionOnly,
    hideIdle: filters.hideIdle,
    minimumSubagents: filters.minimumSubagents,
    sessionSort: filters.sessionSort,
    followActive,
    followOutput,
    errorsOnly,
    density,
    hours,
    select,
    inspect,
    clearInspection,
  }
}
