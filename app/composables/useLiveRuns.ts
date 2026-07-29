import type {
  EventsResponse,
  ProjectRuns,
  RunNode,
  RunResponse,
  SessionEventsResponse,
  SessionSourceStatus,
  TranscriptEvent,
  TreeResponse,
} from '#shared/types/run'

export type FeedDensity = 'compact' | 'normal' | 'raw'

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
  const followActive = ref(false)
  const followOutput = ref(true)
  const errorsOnly = ref(false)
  const density = ref<FeedDensity>('normal')
  let treeTimer: ReturnType<typeof setInterval> | undefined
  let eventTimer: ReturnType<typeof setInterval> | undefined
  let runTimer: ReturnType<typeof setInterval> | undefined
  let sessionEventTimer: ReturnType<typeof setInterval> | undefined
  let treePending = false
  let eventPendingKey: string | null = null
  let inspectedEventPendingKey: string | null = null
  let runPendingKey: string | null = null
  let sessionEventPendingKey: string | null = null

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
    })
  })

  const projectOptions = computed(() => projects.value
    .map(project => ({ id: project.id, name: project.name }))
    .sort((a, b) => a.name.localeCompare(b.name)))

  async function request<T>(url: string): Promise<T | null> {
    try {
      const result = await $fetch(url)
      offline.value = false
      return result as T
    } catch {
      offline.value = true
      return null
    }
  }

  async function loadTree(): Promise<void> {
    if (treePending) return
    treePending = true
    try {
      const response = await request<TreeResponse>('/api/tree')
      if (!response) {
        loading.value = false
        return
      }
      projects.value = response.projects
      sources.value = response.sources
      loading.value = false

      if (!selectedKey.value) {
        const firstProject = visibleProjects.value.find(project => project.roots.length)
        if (firstProject) await select(deepestLive(firstProject.roots[0]!).key, firstProject.id)
        return
      }
      if (followActive.value && selectedRoot.value) {
        const live = descendants(selectedRoot.value)
          .filter(node => node.live)
          .sort((a, b) => b.mtime - a.mtime)[0]
        if (live && live.key !== selectedKey.value) await select(live.key, selectedProject.value!)
      }
    } finally {
      treePending = false
    }
  }

  async function loadRun(): Promise<void> {
    const key = selectedKey.value
    const project = selectedProject.value
    if (!key || !project) return
    const requestKey = `${project}\0${key}`
    if (runPendingKey === requestKey) return
    runPendingKey = requestKey
    try {
      const response = await request<RunResponse>(`/api/run?project=${encodeURIComponent(project)}&key=${encodeURIComponent(key)}`)
      if (response && selectedKey.value === key && selectedProject.value === project) run.value = response
    } finally {
      if (runPendingKey === requestKey) runPendingKey = null
    }
  }

  async function pollEvents(): Promise<void> {
    const key = selectedKey.value
    const project = selectedProject.value
    if (!key || !project) return
    const requestKey = `${project}\0${key}`
    if (eventPendingKey === requestKey) return
    eventPendingKey = requestKey
    try {
      const response = await request<EventsResponse>(
        `/api/events?project=${encodeURIComponent(project)}&key=${encodeURIComponent(key)}&since=${since.value}&revision=${eventRevision.value}`,
      )
      if (!response || selectedKey.value !== key || selectedProject.value !== project) return
      since.value = response.next
      eventRevision.value = response.revision
      if (response.reset) events.value = [...response.events]
      else events.value.push(...response.events)
    } finally {
      if (eventPendingKey === requestKey) eventPendingKey = null
    }
  }

  async function pollSessionEvents(): Promise<void> {
    const key = selectedRoot.value?.key || selectedKey.value
    const project = selectedProject.value
    if (!key || !project) return
    const requestKey = `${project}\0${key}`
    if (sessionEventPendingKey === requestKey) return
    sessionEventPendingKey = requestKey
    try {
      const response = await request<SessionEventsResponse>(
        `/api/session-events?project=${encodeURIComponent(project)}&key=${encodeURIComponent(key)}&limit=800`,
      )
      if (!response || (selectedRoot.value?.key || selectedKey.value) !== key || selectedProject.value !== project) return
      sessionEvents.value = response.events
      sessionEventsTruncated.value = response.truncated
    } finally {
      if (sessionEventPendingKey === requestKey) sessionEventPendingKey = null
    }
  }

  async function pollInspectedEvents(): Promise<void> {
    const key = inspectedKey.value
    const project = selectedProject.value
    if (!key || !project) return
    const requestKey = `${project}\0${key}`
    if (inspectedEventPendingKey === requestKey) return
    inspectedEventPendingKey = requestKey
    try {
      const response = await request<EventsResponse>(
        `/api/events?project=${encodeURIComponent(project)}&key=${encodeURIComponent(key)}&since=${inspectedSince.value}&revision=${inspectedEventRevision.value}`,
      )
      if (!response || inspectedKey.value !== key || selectedProject.value !== project) return
      inspectedSince.value = response.next
      inspectedEventRevision.value = response.revision
      if (response.reset) inspectedEvents.value = [...response.events]
      else inspectedEvents.value.push(...response.events)
    } finally {
      if (inspectedEventPendingKey === requestKey) inspectedEventPendingKey = null
      if (inspectedKey.value === key) inspectedEventsLoading.value = false
      else if (inspectedKey.value) void pollInspectedEvents()
    }
  }

  async function inspect(key: string): Promise<void> {
    if (!selectedProject.value) return
    if (inspectedKey.value !== key) {
      inspectedKey.value = key
      inspectedSince.value = 0
      inspectedEventRevision.value = 0
      inspectedEvents.value = []
      inspectedEventsLoading.value = true
    }
    await pollInspectedEvents()
  }

  function clearInspection(): void {
    inspectedKey.value = null
    inspectedSince.value = 0
    inspectedEventRevision.value = 0
    inspectedEvents.value = []
    inspectedEventsLoading.value = false
  }

  async function select(key: string, project = selectedProject.value): Promise<void> {
    if (!project) return
    if (key === selectedKey.value && project === selectedProject.value && run.value) return
    clearInspection()
    selectedProject.value = project
    selectedKey.value = key
    since.value = 0
    eventRevision.value = 0
    events.value = []
    sessionEvents.value = []
    sessionEventsTruncated.value = false
    run.value = null
    await Promise.all([pollEvents(), loadRun(), pollSessionEvents()])
  }

  onMounted(() => {
    void loadTree()
    treeTimer = setInterval(loadTree, 4_000)
    eventTimer = setInterval(() => {
      void pollEvents()
      void pollInspectedEvents()
    }, 2_000)
    runTimer = setInterval(loadRun, 6_000)
    sessionEventTimer = setInterval(pollSessionEvents, 4_000)
  })

  onUnmounted(() => {
    if (treeTimer) clearInterval(treeTimer)
    if (eventTimer) clearInterval(eventTimer)
    if (runTimer) clearInterval(runTimer)
    if (sessionEventTimer) clearInterval(sessionEventTimer)
  })

  return {
    projects,
    sources,
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
    followActive,
    followOutput,
    errorsOnly,
    density,
    select,
    inspect,
    clearInspection,
  }
}
