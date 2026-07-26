<script setup lang="ts">
import type { ProjectRuns } from '#shared/types/run'

const props = defineProps<{
  projects: ProjectRuns[]
  allProjects: ProjectRuns[]
  selectedProject: string | null
  selectedKey: string | null
}>()

const query = defineModel<string>('query', { required: true })
const liveOnly = defineModel<boolean>('liveOnly', { required: true })
const attentionOnly = defineModel<boolean>('attentionOnly', { required: true })
const hideIdle = defineModel<boolean>('hideIdle', { required: true })
const emit = defineEmits<{
  select: [project: string, key: string]
  collapse: []
}>()
const organization = ref<'project' | 'list'>('project')
const collapsedProjects = ref(new Set<string>())
const organizeMenu = useTemplateRef('organizeMenu')

const allRoots = computed(() => props.allProjects.flatMap(project => project.roots))
const liveCount = computed(() => allRoots.value.filter(root => root.subLive).length)
const attentionCount = computed(() => allRoots.value.filter(root => root.subErrors && !root.subLive).length)

function isExpanded(project: string): boolean {
  return !collapsedProjects.value.has(project)
}

function toggleProject(project: string): void {
  const next = new Set(collapsedProjects.value)
  if (next.has(project)) next.delete(project)
  else next.add(project)
  collapsedProjects.value = next
}

watch(liveOnly, value => {
  if (value) attentionOnly.value = false
})

watch(attentionOnly, value => {
  if (value) liveOnly.value = false
})

function showAllSessions(): void {
  liveOnly.value = false
  attentionOnly.value = false
}

function showRunning(): void {
  liveOnly.value = true
  attentionOnly.value = false
}

function showAttention(): void {
  liveOnly.value = false
  attentionOnly.value = true
}

function organizeBy(value: 'project' | 'list'): void {
  organization.value = value
  if (organizeMenu.value) organizeMenu.value.open = false
}
</script>

<template>
  <aside class="sidebar">
    <header class="workspace-switcher">
      <div class="brand-mark" aria-hidden="true">
        <UIcon name="i-lucide-terminal" />
      </div>
      <div class="workspace-name">
        <strong>Live Claude</strong>
        <span>Session viewer</span>
      </div>
      <button
        type="button"
        class="sidebar-toggle"
        aria-label="Hide sidebar"
        aria-keyshortcuts="Meta+B Control+B"
        title="Hide sidebar (⌘B)"
        @click="emit('collapse')"
      >
        <UIcon name="i-lucide-panel-left" />
      </button>
    </header>

    <nav class="primary-nav" aria-label="Workspace">
      <button type="button" class="primary-nav-item" :class="{ selected: !liveOnly && !attentionOnly }" @click="showAllSessions">
        <UIcon name="i-lucide-panels-top-left" />
        <span>Sessions</span>
        <kbd>G S</kbd>
      </button>
      <button type="button" class="primary-nav-item" :class="{ selected: liveOnly }" @click="showRunning">
        <UIcon name="i-lucide-radio" />
        <span>Running</span>
        <span class="nav-count">{{ liveCount }}</span>
      </button>
      <button type="button" class="primary-nav-item" :class="{ selected: attentionOnly }" @click="showAttention">
        <UIcon name="i-lucide-circle-alert" />
        <span>Needs attention</span>
        <span class="nav-count" :class="{ warning: attentionCount }">{{ attentionCount }}</span>
      </button>
    </nav>

    <section class="session-browser">
      <div class="sidebar-section-title">
        <span>{{ organization === 'project' ? 'Projects' : 'Recent sessions' }}</span>
        <details ref="organizeMenu" class="organize-menu">
          <summary aria-label="Organize sidebar" title="Organize sidebar">
            <UIcon name="i-lucide-ellipsis" />
          </summary>
          <div class="organize-popover">
            <span class="organize-title">Organize sidebar</span>
            <button
              type="button"
              :class="{ selected: organization === 'project' }"
              :aria-pressed="organization === 'project'"
              @click="organizeBy('project')"
            >
              <UIcon name="i-lucide-check" />
              By project
            </button>
            <button
              type="button"
              :class="{ selected: organization === 'list' }"
              :aria-pressed="organization === 'list'"
              @click="organizeBy('list')"
            >
              <UIcon name="i-lucide-check" />
              In one list
            </button>
            <span class="organize-title secondary">Sort by</span>
            <div class="organize-static"><UIcon name="i-lucide-check" /> Last updated</div>
          </div>
        </details>
      </div>
      <UInput
        v-model="query"
        class="run-filter"
        icon="i-lucide-search"
        placeholder="Filter sessions…"
        aria-label="Filter runs"
      />
      <div class="filters">
        <UCheckbox v-model="liveOnly" class="toggle" label="Live only" />
        <UCheckbox v-model="hideIdle" class="toggle" label="Hide empty" />
      </div>
      <nav class="run-tree" aria-label="Claude Code runs">
        <template v-if="organization === 'project'">
          <div v-for="project in projects" :key="project.id" class="project-group">
            <button
              type="button"
              class="project-row"
              :aria-expanded="isExpanded(project.id)"
              @click="toggleProject(project.id)"
            >
              <UIcon :name="isExpanded(project.id) ? 'i-lucide-folder-open' : 'i-lucide-folder'" />
              <span :title="project.name">{{ project.name }}</span>
              <span v-if="project.roots.some(root => root.subLive)" class="project-live" aria-label="Project has a running session" />
              <UIcon class="project-chevron" :class="{ expanded: isExpanded(project.id) }" name="i-lucide-chevron-right" />
            </button>
            <div v-show="isExpanded(project.id)" class="project-runs">
              <RunTreeNode
                v-for="root in project.roots"
                :key="root.key"
                :node="root"
                :depth="0"
                :selected-key="selectedProject === project.id ? selectedKey : null"
                @select="emit('select', project.id, $event)"
              />
              <p v-if="!project.roots.length" class="muted empty-sidebar">No recent sessions.</p>
            </div>
          </div>
        </template>
        <template v-else>
          <template v-for="project in projects" :key="project.id">
            <RunTreeNode
              v-for="root in project.roots"
              :key="`${project.id}/${root.key}`"
              :node="root"
              :depth="0"
              :selected-key="selectedProject === project.id ? selectedKey : null"
              @select="emit('select', project.id, $event)"
            />
          </template>
          <p v-if="!projects.some(project => project.roots.length)" class="muted empty-sidebar">No matching sessions.</p>
        </template>
      </nav>
    </section>

    <footer class="sidebar-footer">
      <span class="connection-dot" />
      <span>Watching local sessions</span>
      <UIcon name="i-lucide-hard-drive" />
    </footer>
  </aside>
</template>
