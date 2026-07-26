import type {
  EventsResponse,
  ProjectRuns,
  RunNode,
  RunResponse,
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
  const selectedProject = ref<string | null>(null)
  const selectedKey = ref<string | null>(null)
  const run = ref<RunResponse | null>(null)
  const events = ref<TranscriptEvent[]>([])
  const since = ref(0)
  const offline = ref(false)
  const query = ref('')
  const liveOnly = ref(false)
  const attentionOnly = ref(false)
  const hideIdle = ref(true)
  const followActive = ref(true)
  const followOutput = ref(true)
  const errorsOnly = ref(false)
  const density = ref<FeedDensity>('normal')
  let treeTimer: ReturnType<typeof setInterval> | undefined
  let eventTimer: ReturnType<typeof setInterval> | undefined
  let runTimer: ReturnType<typeof setInterval> | undefined
  let treePending = false
  let eventPending = false
  let runPending = false

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
    const needle = query.value.toLowerCase()
    const filter = (node: RunNode, projectMatches: boolean): RunNode | null => {
      const children = node.children.map(child => filter(child, projectMatches))
        .filter((child): child is RunNode => Boolean(child))
      const self = (!liveOnly.value || node.subLive)
        && (!attentionOnly.value || (node.subErrors > 0 && !node.subLive))
        && (!hideIdle.value || node.tools > 0 || children.length > 0)
        && (!needle || projectMatches
          || node.label.toLowerCase().includes(needle)
          || node.agentType.toLowerCase().includes(needle))
      return self || children.length ? { ...node, children } : null
    }
    return projects.value.map((project) => {
      const projectMatches = project.name.toLowerCase().includes(needle)
      return {
        ...project,
        roots: project.roots.map(root => filter(root, projectMatches))
          .filter((root): root is RunNode => Boolean(root)),
      }
    }).filter(project => !needle || project.name.toLowerCase().includes(needle) || project.roots.length)
  })

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
      if (!response) return
      projects.value = response.projects

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
    if (!key || !project || runPending) return
    runPending = true
    try {
      const response = await request<RunResponse>(`/api/run?project=${encodeURIComponent(project)}&key=${encodeURIComponent(key)}`)
      if (response && selectedKey.value === key && selectedProject.value === project) run.value = response
    } finally {
      runPending = false
    }
  }

  async function pollEvents(): Promise<void> {
    const key = selectedKey.value
    const project = selectedProject.value
    if (!key || !project || eventPending) return
    eventPending = true
    try {
      const response = await request<EventsResponse>(
        `/api/events?project=${encodeURIComponent(project)}&key=${encodeURIComponent(key)}&since=${since.value}`,
      )
      if (!response || selectedKey.value !== key || selectedProject.value !== project) return
      since.value = response.next
      events.value.push(...response.events)
    } finally {
      eventPending = false
    }
  }

  async function select(key: string, project = selectedProject.value): Promise<void> {
    if (!project) return
    if (key === selectedKey.value && project === selectedProject.value && run.value) return
    selectedProject.value = project
    selectedKey.value = key
    since.value = 0
    events.value = []
    run.value = null
    await Promise.all([pollEvents(), loadRun()])
  }

  onMounted(() => {
    void loadTree()
    treeTimer = setInterval(loadTree, 4_000)
    eventTimer = setInterval(pollEvents, 2_000)
    runTimer = setInterval(loadRun, 6_000)
  })

  onUnmounted(() => {
    if (treeTimer) clearInterval(treeTimer)
    if (eventTimer) clearInterval(eventTimer)
    if (runTimer) clearInterval(runTimer)
  })

  return {
    projects,
    visibleProjects,
    selectedProject,
    selectedKey,
    selectedNode,
    selectedRoot,
    run,
    events,
    offline,
    query,
    liveOnly,
    attentionOnly,
    hideIdle,
    followActive,
    followOutput,
    errorsOnly,
    density,
    select,
  }
}
