import type { ComputedRef, Ref, ShallowRef, WritableComputedRef } from 'vue'
import type {
  RunResponse,
  SessionEventsResponse,
  TranscriptEvent,
} from '#shared/types/run'
import type {
  CostSummaryWire,
  ProjectRunsWire,
  RunNodeWire,
  SessionSourceStatusWire,
} from '#shared/schemas/api'
import { useAtomValue } from '@effect/atom-vue'
import type { SessionSort } from '~/utils/session-filter'
import type { ProjectOption, SessionSourceFilter } from '~/atoms/filters'
import type { FeedDensity } from '~/atoms/preferences'
import type { SessionRangeHours } from '~/atoms/range'
import { filtersAtoms } from '~/atoms/filters'
import { preferencesAtoms } from '~/atoms/preferences'
import { rangeAtoms } from '~/atoms/range'
import { treeAtoms } from '~/atoms/tree'
import { useAtomModel } from '~/composables/atom'
import { createLatestRequestGate } from '~/utils/latest-request-gate'
import { deepestLiveNode, flattenRunTree } from '~/utils/execution-analysis'

export interface UseLiveRunsOptions {
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
  readonly projects: Readonly<Ref<ReadonlyArray<ProjectRunsWire>>>
  /** Per-source scanner status, e.g. a provider that failed to load. */
  readonly sources: Readonly<Ref<ReadonlyArray<SessionSourceStatusWire>>>
  /** Aggregated cost summary for the visible range, when available. */
  readonly costs: Readonly<Ref<CostSummaryWire | null>>
  /** True until the first tree response (or failure) arrives. */
  readonly loading: Readonly<Ref<boolean>>
  /** True while the *tree* poll is failing; cleared by its next success. */
  readonly offline: Readonly<Ref<boolean>>
  /** Projects with the sidebar filters applied. */
  readonly visibleProjects: Readonly<Ref<ProjectRunsWire[]>>
  /** All known projects as name-sorted select options, unfiltered. */
  readonly projectOptions: Readonly<Ref<ProjectOption[]>>
  /** Project id of the current selection, or `null` before the first load. */
  readonly selectedProject: Readonly<ShallowRef<string | null>>
  /** Key of the selected agent, or `null` before the first load. */
  readonly selectedKey: Readonly<ShallowRef<string | null>>
  /** Tree node of the selected agent, when it exists in the current tree. */
  readonly selectedNode: ComputedRef<RunNodeWire | null>
  /** Root session node the selected agent belongs to. */
  readonly selectedRoot: ComputedRef<RunNodeWire | null>
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
  readonly query: WritableComputedRef<string>
  /** Restrict sessions to one transcript source. */
  readonly sourceFilter: WritableComputedRef<SessionSourceFilter>
  /** Restrict sessions to one project id, or `'all'`. */
  readonly projectFilter: WritableComputedRef<string>
  /** Show only sessions with live activity. */
  readonly liveOnly: WritableComputedRef<boolean>
  /** Show only finished sessions that ended with errors. */
  readonly attentionOnly: WritableComputedRef<boolean>
  /** Hide empty sessions that never recorded any activity. */
  readonly hideIdle: WritableComputedRef<boolean>
  /** Minimum number of subagents a session must have spawned. */
  readonly minimumSubagents: WritableComputedRef<number>
  /** Session ordering within a project. */
  readonly sessionSort: WritableComputedRef<SessionSort>
  /** Automatically follow the most recently active live agent. */
  readonly followActive: WritableComputedRef<boolean>
  /** Keep the event feed scrolled to the newest output. */
  readonly followOutput: WritableComputedRef<boolean>
  /** Show only error events in the feed. */
  readonly errorsOnly: WritableComputedRef<boolean>
  /** Rendering density of the event feed. */
  readonly density: WritableComputedRef<FeedDensity>
  /** Time range of sessions to show, in hours; `0` means all time. */
  readonly hours: WritableComputedRef<SessionRangeHours>
  /** Select an agent (and optionally another project) and load its detail. */
  readonly select: (key: string, project?: string | null) => Promise<void>
  /** Open an agent of the selected session in the inspector overlay. */
  readonly inspect: (key: string) => Promise<void>
  /** Close the inspector overlay and drop its stream. */
  readonly clearInspection: () => void
}

/**
 * Client state for the live dashboard: polls the session tree, the selected
 * run's detail and transcript streams, and keeps every response guarded against
 * stale delivery when the selection or time range changes mid-flight.
 *
 * The filters, the display preferences, and the range are no longer owned here
 * — they are atoms, and what is left of them in the return value is a set of
 * `v-model` bindings `index.vue` still reads through. That indirection goes with
 * this composable in Stage 7.
 */
export function useLiveRuns(options: UseLiveRunsOptions = {}): UseLiveRunsReturn {
  const {
    eventsIntervalMs = 2_000,
    runIntervalMs = 6_000,
    sessionEventsIntervalMs = 4_000,
    sessionEventsLimit = 800,
  } = options

  // The tree is an atom now: one poll loop, its own cancellation, and a value
  // that survives a failed refresh. Everything below it here is still a ref.
  const projects = useAtomValue(() => treeAtoms.projects)
  const sources = useAtomValue(() => treeAtoms.sources)
  const costs = useAtomValue(() => treeAtoms.costs)
  const loading = useAtomValue(() => treeAtoms.loading)
  const offline = useAtomValue(() => treeAtoms.offline)
  const visibleProjects = useAtomValue(() => filtersAtoms.visibleProjects)
  const projectOptions = useAtomValue(() => filtersAtoms.projectOptions)
  const selectedProject = shallowRef<string | null>(null)
  const selectedKey = shallowRef<string | null>(null)
  const run = shallowRef<RunResponse | null>(null)
  const sessionEvents = shallowRef<TranscriptEvent[]>([])
  const sessionEventsTruncated = shallowRef(false)
  const inspectedKey = shallowRef<string | null>(null)
  const inspectedEventsLoading = shallowRef(false)
  // Filters, display preferences, and the range are app-wide state held in the
  // atom registry. Every one of these bindings has to be created here, during
  // `setup()`: `injectRegistry` falls back to a module-level singleton instead
  // of throwing, so a late call binds to shared global state without a warning.
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
  // The range the user picked, as opposed to the one in effect. Only a change
  // to this one means "show me a different window".
  const explicitHours = useAtomValue(() => rangeAtoms.explicit)
  let disposed = false
  const requestControllers = new Set<AbortController>()
  const runRequests = createLatestRequestGate()
  const sessionEventRequests = createLatestRequestGate()

  const nodeIndex = computed(() => {
    const map = new Map<string, { node: RunNodeWire, parent: string | null }>()
    const visit = (
      project: string,
      nodes: ReadonlyArray<RunNodeWire>,
      parent: string | null,
    ): void => {
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

  /**
   * One detail request.
   *
   * No longer touches `offline`: that is the tree's poll now, which is the only
   * one that runs unconditionally and therefore the only one that can tell
   * "the server is gone" from "nothing is selected".
   */
  async function request<T>(url: string): Promise<T | null> {
    if (disposed) return null
    const controller = new AbortController()
    requestControllers.add(controller)
    try {
      const result = await $fetch(url, { signal: controller.signal })
      if (disposed) return null
      return result as T
    } catch {
      return null
    } finally {
      requestControllers.delete(controller)
    }
  }

  /**
   * What the tree poll used to do with each response, now that it does not
   * deliver one: pick something on first load, and follow the newest live agent.
   *
   * Both become atoms in Stage 6. Until then this watcher stands in for the tail
   * of `loadTree`, and fires on the same cadence — every response is a fresh
   * array, so `projects` changes identity on every poll.
   */
  function reconcileSelection(): void {
    if (!selectedKey.value) {
      const firstProject = visibleProjects.value.find(project => project.roots.length)
      if (firstProject) void select(deepestLiveNode(firstProject.roots[0]!).key, firstProject.id)
      return
    }
    if (followActive.value && selectedRoot.value) {
      const live = flattenRunTree(selectedRoot.value)
        .filter(node => node.live)
        .sort((a, b) => b.mtime - a.mtime)[0]
      if (live && live.key !== selectedKey.value) void select(live.key, selectedProject.value!)
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

  /** A range the *user* chose invalidates everything scoped to the old one. */
  function discardRangeScopedState(): void {
    selectedProject.value = null
    selectedKey.value = null
    run.value = null
    selectedStream.reset()
    runRequests.invalidate()
    sessionEventRequests.invalidate()
    sessionEvents.value = []
    sessionEventsTruncated.value = false
    clearInspection()
  }

  /**
   * One watcher for both, because the order between them is load-bearing: a
   * range change discards the selection and then picks a new one, and two
   * separate watchers would have that order decided by which was registered
   * first.
   *
   * The tree itself is not reset here. It re-keys on the explicit range and
   * rebuilds its own loop, which is why the sidebar keeps the previous range's
   * sessions on screen for the moment the new ones take to arrive instead of
   * blanking, and why this fires again when they do — every response is a fresh
   * array, so `projects` changes identity on every poll.
   *
   * Watching the *explicit* choice rather than the effective range is what the
   * `rangeInitialized` flag used to do: adopting the server's range on first
   * load changes what the sidebar displays but is not a change of range, and
   * must not throw away the selection the same response just produced.
   *
   * `immediate` because the feed can already hold a value by the time this is
   * registered — the atom's stream runs to its first emission synchronously when
   * the request resolves synchronously, which is every mounted test with a
   * stubbed `Api`.
   */
  watch(
    [projects, explicitHours] as const,
    ([, chosen], previous) => {
      if (previous && chosen !== previous[1]) discardRangeScopedState()
      reconcileSelection()
    },
    { immediate: true },
  )

  const pollers = [
    useIntervalFn(() => {
      void selectedStream.poll()
      void inspectedStream.poll()
    }, eventsIntervalMs, { immediate: false }),
    useIntervalFn(loadRun, runIntervalMs, { immediate: false }),
    useIntervalFn(pollSessionEvents, sessionEventsIntervalMs, { immediate: false }),
  ]

  onMounted(() => {
    pollers.forEach(poller => poller.resume())
  })

  tryOnScopeDispose(() => {
    disposed = true
    runRequests.invalidate()
    sessionEventRequests.invalidate()
    selectedStream.reset()
    inspectedStream.reset()
    requestControllers.forEach(controller => controller.abort())
    requestControllers.clear()
  })

  return {
    projects,
    sources,
    costs,
    loading,
    offline,
    visibleProjects,
    projectOptions,
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
    query,
    sourceFilter,
    projectFilter,
    liveOnly,
    attentionOnly,
    hideIdle,
    minimumSubagents,
    sessionSort,
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
