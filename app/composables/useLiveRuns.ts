import type { Ref } from 'vue'
import type {
  CostSummary,
  EventsResponse,
  ProjectRuns,
  RunNode,
  RunResponse,
  SessionEventsResponse,
  SessionSourceStatus,
  TranscriptEvent,
  TreeResponse,
} from '#shared/types/run'
import type { SessionSort } from '~/utils/session-filter'

export type FeedDensity = 'compact' | 'normal' | 'raw'
export type SessionRangeHours = number

interface EventCursor {
  readonly since: Ref<number>
  readonly revision: Ref<number>
  readonly events: Ref<TranscriptEvent[]>
}

interface EventPollerOptions {
  readonly currentKey: () => string | null
  readonly currentProject: () => string | null
  readonly currentHours: () => SessionRangeHours
  readonly cursor: EventCursor
  readonly request: (
    url: string,
    isCurrent: () => boolean,
  ) => Promise<EventsResponse | null>
  readonly settled?: (requestedKey: string) => void
}

interface EventPoller {
  readonly poll: () => Promise<void>
  readonly reset: () => void
}

interface RequestToken {
  readonly key: string
  readonly generation: number
}

interface LatestRequestGate {
  readonly start: (key: string) => RequestToken | null
  readonly isCurrent: (request: RequestToken) => boolean
  readonly settle: (request: RequestToken) => void
  readonly invalidate: () => void
}

function createLatestRequestGate(): LatestRequestGate {
  let generation = 0
  let pending: RequestToken | null = null

  return {
    start(key) {
      if (pending?.key === key) return null
      const request = { key, generation: generation += 1 }
      pending = request
      return request
    },
    isCurrent: request => request.generation === generation,
    settle(request) {
      if (pending === request) pending = null
    },
    invalidate() {
      generation += 1
      pending = null
    },
  }
}

function createEventPoller(options: EventPollerOptions): EventPoller {
  let generation = 0
  let pending: { readonly key: string, readonly generation: number } | null = null

  async function poll(): Promise<void> {
    const key = options.currentKey()
    const project = options.currentProject()
    if (!key || !project) return
    const hours = options.currentHours()
    const requestKey = `${project}\0${key}\0${hours}`
    const requestGeneration = generation
    if (pending?.key === requestKey && pending.generation === requestGeneration) return
    const request = { key: requestKey, generation: requestGeneration }
    pending = request
    const isCurrent = () => generation === requestGeneration
      && options.currentKey() === key
      && options.currentProject() === project
      && options.currentHours() === hours
    try {
      const response = await options.request(
        `/api/events?project=${encodeURIComponent(project)}&key=${encodeURIComponent(key)}&since=${options.cursor.since.value}&revision=${options.cursor.revision.value}&hours=${hours}`,
        isCurrent,
      )
      if (!response || !isCurrent()) return
      options.cursor.since.value = response.next
      options.cursor.revision.value = response.revision
      if (response.reset) options.cursor.events.value = [...response.events]
      else options.cursor.events.value.push(...response.events)
    } finally {
      if (pending === request) pending = null
      if (generation === requestGeneration) options.settled?.(key)
    }
  }

  function reset(): void {
    generation += 1
    options.cursor.since.value = 0
    options.cursor.revision.value = 0
    options.cursor.events.value = []
  }

  return { poll, reset }
}

function descendants(node: RunNode, output: RunNode[] = []): RunNode[] {
  output.push(node)
  node.children.forEach(child => descendants(child, output))
  return output
}

function deepestLive(node: RunNode): RunNode {
  const liveChildren = node.children.filter(child => child.subLive)
  return liveChildren.length ? deepestLive(liveChildren.at(-1)!) : node
}

export function useLiveRuns() {
  const projects = ref<ProjectRuns[]>([])
  const sources = ref<SessionSourceStatus[]>([])
  const costs = ref<CostSummary | null>(null)
  const loading = ref(true)
  const selectedProject = ref<string | null>(null)
  const selectedKey = ref<string | null>(null)
  const run = ref<RunResponse | null>(null)
  const events = ref<TranscriptEvent[]>([])
  const sessionEvents = ref<TranscriptEvent[]>([])
  const sessionEventsTruncated = ref(false)
  const inspectedKey = ref<string | null>(null)
  const inspectedEvents = ref<TranscriptEvent[]>([])
  const inspectedEventsLoading = ref(false)
  const since = ref(0)
  const eventRevision = ref(0)
  const inspectedSince = ref(0)
  const inspectedEventRevision = ref(0)
  const offline = ref(false)
  const query = ref('')
  const sourceFilter = ref<'all' | 'claude' | 'codex' | 'copilot'>('all')
  const projectFilter = ref('all')
  const liveOnly = ref(false)
  const attentionOnly = ref(false)
  const hideIdle = ref(true)
  const minimumSubagents = ref(0)
  const sessionSort = ref<SessionSort>('updated')
  const followActive = ref(false)
  const followOutput = ref(true)
  const errorsOnly = ref(false)
  const density = ref<FeedDensity>('normal')
  const hours = ref<SessionRangeHours>(168)
  let treeTimer: ReturnType<typeof setInterval> | undefined
  let eventTimer: ReturnType<typeof setInterval> | undefined
  let runTimer: ReturnType<typeof setInterval> | undefined
  let sessionEventTimer: ReturnType<typeof setInterval> | undefined
  let treePending = false
  let treeReloadQueued = false
  let treeGeneration = 0
  let rangeInitialized = false
  let disposed = false
  const requestControllers = new Set<AbortController>()
  const runRequests = createLatestRequestGate()
  const sessionEventRequests = createLatestRequestGate()

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

  const visibleProjects = computed(() => {
    return filterSessionProjects(projects.value, {
      query: query.value,
      source: sourceFilter.value,
      project: projectFilter.value,
      liveOnly: liveOnly.value,
      attentionOnly: attentionOnly.value,
      hideIdle: hideIdle.value,
      minimumSubagents: minimumSubagents.value,
      sort: sessionSort.value,
    })
  })

  const projectOptions = computed(() => projects.value
    .map(project => ({ id: project.id, name: project.name }))
    .sort((a, b) => a.name.localeCompare(b.name)))

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
        const firstProject = visibleProjects.value.find(project => project.roots.length)
        if (firstProject) void select(deepestLive(firstProject.roots[0]!).key, firstProject.id)
        return
      }
      if (followActive.value && selectedRoot.value) {
        const live = descendants(selectedRoot.value)
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

  const selectedEventPoller = createEventPoller({
    currentKey: () => selectedKey.value,
    currentProject: () => selectedProject.value,
    currentHours: () => hours.value,
    cursor: { since, revision: eventRevision, events },
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
        `/api/session-events?project=${encodeURIComponent(project)}&key=${encodeURIComponent(key)}&limit=800&hours=${requestedHours}`,
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

  const inspectedEventPoller = createEventPoller({
    currentKey: () => inspectedKey.value,
    currentProject: () => selectedProject.value,
    currentHours: () => hours.value,
    cursor: {
      since: inspectedSince,
      revision: inspectedEventRevision,
      events: inspectedEvents,
    },
    request,
    settled: (key) => {
      if (inspectedKey.value === key) inspectedEventsLoading.value = false
      else if (inspectedKey.value) void inspectedEventPoller.poll()
    },
  })

  async function inspect(key: string): Promise<void> {
    if (!selectedProject.value) return
    if (inspectedKey.value !== key) {
      inspectedKey.value = key
      inspectedEventPoller.reset()
      inspectedEventsLoading.value = true
    }
    await inspectedEventPoller.poll()
  }

  function clearInspection(): void {
    inspectedKey.value = null
    inspectedEventPoller.reset()
    inspectedEventsLoading.value = false
  }

  async function select(key: string, project = selectedProject.value): Promise<void> {
    if (!project) return
    if (key === selectedKey.value && project === selectedProject.value && run.value) return
    clearInspection()
    selectedProject.value = project
    selectedKey.value = key
    selectedEventPoller.reset()
    sessionEvents.value = []
    sessionEventsTruncated.value = false
    run.value = null
    await Promise.all([selectedEventPoller.poll(), loadRun(), pollSessionEvents()])
  }

  watch(hours, () => {
    if (!rangeInitialized) return
    treeGeneration += 1
    loading.value = true
    projects.value = []
    selectedProject.value = null
    selectedKey.value = null
    run.value = null
    selectedEventPoller.reset()
    runRequests.invalidate()
    sessionEventRequests.invalidate()
    sessionEvents.value = []
    sessionEventsTruncated.value = false
    clearInspection()
    void loadTree()
  })

  onMounted(() => {
    void loadTree()
    treeTimer = setInterval(loadTree, 4_000)
    eventTimer = setInterval(() => {
      void selectedEventPoller.poll()
      void inspectedEventPoller.poll()
    }, 2_000)
    runTimer = setInterval(loadRun, 6_000)
    sessionEventTimer = setInterval(pollSessionEvents, 4_000)
  })

  onUnmounted(() => {
    disposed = true
    treeGeneration += 1
    treeReloadQueued = false
    runRequests.invalidate()
    sessionEventRequests.invalidate()
    selectedEventPoller.reset()
    inspectedEventPoller.reset()
    requestControllers.forEach(controller => controller.abort())
    requestControllers.clear()
    if (treeTimer) clearInterval(treeTimer)
    if (eventTimer) clearInterval(eventTimer)
    if (runTimer) clearInterval(runTimer)
    if (sessionEventTimer) clearInterval(sessionEventTimer)
  })

  return {
    projects,
    sources,
    costs,
    loading,
    visibleProjects,
    projectOptions,
    selectedProject,
    selectedKey,
    selectedNode,
    selectedRoot,
    run,
    events,
    sessionEvents,
    sessionEventsTruncated,
    inspectedEvents,
    inspectedEventsLoading,
    offline,
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
