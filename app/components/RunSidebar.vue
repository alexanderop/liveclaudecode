<script setup lang="ts">
import type { ProjectRuns, SessionSourceStatus } from '#shared/types/run'

const props = defineProps<{
  projects: ProjectRuns[]
  allProjects: ProjectRuns[]
  sources: SessionSourceStatus[]
  projectOptions: Array<{ id: string, name: string }>
  loading: boolean
  selectedProject: string | null
  selectedKey: string | null
}>()

const query = defineModel<string>('query', { required: true })
const sourceFilter = defineModel<'all' | 'claude' | 'codex' | 'copilot'>('sourceFilter', { required: true })
const projectFilter = defineModel<string>('projectFilter', { required: true })
const liveOnly = defineModel<boolean>('liveOnly', { required: true })
const attentionOnly = defineModel<boolean>('attentionOnly', { required: true })
const hideIdle = defineModel<boolean>('hideIdle', { required: true })
const emit = defineEmits<{
  select: [project: string, key: string]
  collapse: []
}>()
const organization = ref<'project' | 'list'>('project')
const collapsedProjects = ref(new Set<string>())
const filtersOpen = ref(false)

const allRoots = computed(() => props.allProjects.flatMap(project => project.roots))
const liveCount = computed(() => allRoots.value.filter(root => root.subLive).length)
const attentionCount = computed(() => allRoots.value.filter(root => root.subErrors && !root.subLive).length)
const unhealthySources = computed(() => props.sources.filter(source => source.state !== 'ready'))
const activeFilterCount = computed(() => [
  sourceFilter.value !== 'all',
  projectFilter.value !== 'all',
  liveOnly.value,
  hideIdle.value,
].filter(Boolean).length)
const recentRoots = computed(() => props.projects
  .flatMap(project => project.roots.map(root => ({ project: project.id, root })))
  .sort((a, b) => (b.root.subLast || '').localeCompare(a.root.subLast || '')))
const sourceOptions: Array<{ value: 'all' | 'claude' | 'codex' | 'copilot', label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'copilot', label: 'Copilot' },
]

const projectSelectOptions = computed(() => [
  { label: 'All projects', value: 'all' },
  ...props.projectOptions.map(project => ({ label: project.name, value: project.id })),
])
const organizeItems = computed(() => [[
  { label: 'Organize sidebar', type: 'label' as const },
  {
    label: 'By project',
    icon: organization.value === 'project' ? 'i-lucide-check' : undefined,
    onSelect: () => organizeBy('project'),
  },
  {
    label: 'In one list',
    icon: organization.value === 'list' ? 'i-lucide-check' : undefined,
    onSelect: () => organizeBy('list'),
  },
], [
  { label: 'Sort by last updated', icon: 'i-lucide-arrow-down-wide-narrow', disabled: true },
]])

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
}
</script>

<template>
  <aside class="sidebar">
    <header class="workspace-switcher">
      <div class="brand-mark" aria-hidden="true">
        <UIcon name="i-lucide-terminal" />
      </div>
      <div class="workspace-name">
        <strong>Live Sessions</strong>
        <span>Claude + Codex + Copilot</span>
      </div>
      <UTooltip text="Hide sidebar" :kbds="['meta', 'B']">
        <UButton
          class="sidebar-toggle"
          color="neutral"
          variant="ghost"
          icon="i-lucide-panel-left"
          aria-label="Hide sidebar"
          aria-keyshortcuts="Meta+B Control+B"
          @click="emit('collapse')"
        />
      </UTooltip>
    </header>

    <nav class="primary-nav" aria-label="Workspace">
      <UButton
        type="button"
        class="primary-nav-item"
        color="neutral"
        variant="ghost"
        :class="{ selected: !liveOnly && !attentionOnly }"
        :aria-pressed="!liveOnly && !attentionOnly"
        @click="showAllSessions"
      >
        <UIcon name="i-lucide-panels-top-left" />
        <span>Sessions</span>
        <span class="nav-shortcut"><UKbd value="G" /><UKbd value="S" /></span>
      </UButton>
      <UButton
        type="button"
        class="primary-nav-item"
        color="neutral"
        variant="ghost"
        :class="{ selected: liveOnly }"
        :aria-pressed="liveOnly"
        @click="showRunning"
      >
        <UIcon name="i-lucide-radio" />
        <span>Running</span>
        <span class="nav-count">{{ liveCount }}</span>
      </UButton>
      <UButton
        type="button"
        class="primary-nav-item"
        color="neutral"
        variant="ghost"
        :class="{ selected: attentionOnly }"
        :aria-pressed="attentionOnly"
        @click="showAttention"
      >
        <UIcon name="i-lucide-circle-alert" />
        <span>Needs attention</span>
        <span class="nav-count" :class="{ warning: attentionCount }">{{ attentionCount }}</span>
      </UButton>
    </nav>

    <section class="session-browser">
      <div class="sidebar-section-title">
        <span>{{ organization === 'project' ? 'Projects' : 'Recent sessions' }}</span>
        <UDropdownMenu :items="organizeItems" :content="{ align: 'end' }">
          <UButton
            class="organize-trigger"
            color="neutral"
            variant="ghost"
            icon="i-lucide-ellipsis"
            aria-label="Organize sidebar"
          />
        </UDropdownMenu>
      </div>
      <UInput
        v-model="query"
        class="run-filter"
        icon="i-lucide-search"
        placeholder="Filter sessions…"
        aria-label="Filter runs"
      />
      <button
        type="button"
        class="sidebar-filter-toggle"
        :class="{ warning: unhealthySources.length }"
        :aria-expanded="filtersOpen"
        aria-controls="session-filters"
        @click="filtersOpen = !filtersOpen"
      >
        <span><UIcon name="i-lucide-list-filter" />Filters</span>
        <span class="sidebar-filter-summary">
          <b v-if="activeFilterCount">{{ activeFilterCount }} active</b>
          <b v-if="unhealthySources.length" class="warning"><UIcon name="i-lucide-triangle-alert" />{{ unhealthySources.length }}</b>
          <UIcon class="disclosure-chevron" name="i-lucide-chevron-down" />
        </span>
      </button>
      <div v-if="filtersOpen" id="session-filters" class="sidebar-filter-panel">
        <div class="source-filters" aria-label="Session source filter">
          <UButton
            v-for="option in sourceOptions"
            :key="option.value"
            type="button"
            color="neutral"
            variant="ghost"
            :class="{ selected: sourceFilter === option.value }"
            :aria-pressed="sourceFilter === option.value"
            @click="sourceFilter = option.value"
          >{{ option.label }}</UButton>
        </div>
        <label class="project-filter">
          <span>Project</span>
          <USelectMenu
            v-model="projectFilter"
            :items="projectSelectOptions"
            value-key="value"
            label-key="label"
            size="xs"
            aria-label="Filter by project"
            :search-input="{ placeholder: 'Find project…' }"
          />
        </label>
        <div class="filters">
          <UCheckbox v-model="liveOnly" class="toggle" label="Live only" />
          <UCheckbox v-model="hideIdle" class="toggle" label="Hide empty" />
        </div>
        <div v-if="unhealthySources.length" class="source-statuses" aria-live="polite">
          <UAlert
            v-for="source in unhealthySources"
            :key="source.source"
            :class="source.state"
            :color="source.state === 'degraded' ? 'warning' : 'error'"
            variant="soft"
            :title="source.source === 'claude' ? 'Claude' : source.source === 'codex' ? 'Codex' : 'Copilot'"
            :description="source.message"
            icon="i-lucide-triangle-alert"
          />
        </div>
      </div>
      <nav class="run-tree" aria-label="Claude, Codex, and Copilot sessions">
        <div v-if="loading" class="sidebar-skeleton" aria-live="polite" aria-label="Loading local sessions…">
          <span class="sr-only">Loading local sessions…</span>
          <USkeleton v-for="index in 4" :key="index" class="h-12 w-full rounded-md" />
        </div>
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
              <UEmpty v-if="!project.roots.length" class="empty-sidebar" title="No recent sessions" variant="naked" />
            </div>
          </div>
          <UEmpty
            v-if="!loading && !projects.some(project => project.roots.length)"
            class="empty-sidebar"
            icon="i-lucide-search-x"
            title="No matching sessions"
            description="Try clearing one of the session filters."
            variant="naked"
          />
        </template>
        <template v-else>
          <RunTreeNode
            v-for="entry in recentRoots"
            :key="`${entry.project}/${entry.root.key}`"
            :node="entry.root"
            :depth="0"
            :selected-key="selectedProject === entry.project ? selectedKey : null"
            @select="emit('select', entry.project, $event)"
          />
          <UEmpty
            v-if="!loading && !recentRoots.length"
            class="empty-sidebar"
            icon="i-lucide-search-x"
            title="No matching sessions"
            variant="naked"
          />
        </template>
      </nav>
    </section>

    <footer class="sidebar-footer">
      <span class="connection-dot" />
      <span>Watching Claude + Codex + Copilot</span>
      <UIcon name="i-lucide-hard-drive" />
    </footer>
  </aside>
</template>
