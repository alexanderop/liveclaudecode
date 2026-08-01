<script setup lang="ts">
import type { CostSummary, ProjectRuns, SessionSourceStatus } from '#shared/types/run'
import type { SessionSourceFilter } from '~/composables/useSessionFilters'
import { sessionSourceLabel } from '~/utils/format'
import { compareRoots, type SessionSort } from '~/utils/session-filter'

const props = defineProps<{
  projects: ProjectRuns[]
  allProjects: ProjectRuns[]
  sources: SessionSourceStatus[]
  costs?: CostSummary | null
  projectOptions: Array<{ id: string, name: string }>
  loading: boolean
  selectedProject: string | null
  selectedKey: string | null
}>()

const query = defineModel<string>('query', { required: true })
const sourceFilter = defineModel<SessionSourceFilter>('sourceFilter', { required: true })
const projectFilter = defineModel<string>('projectFilter', { required: true })
const liveOnly = defineModel<boolean>('liveOnly', { required: true })
const attentionOnly = defineModel<boolean>('attentionOnly', { required: true })
const hideIdle = defineModel<boolean>('hideIdle', { required: true })
const minimumSubagents = defineModel<number>('minimumSubagents', { required: true })
const sessionSort = defineModel<SessionSort>('sessionSort', { required: true })
const hours = defineModel<number>('hours', { required: true })
const emit = defineEmits<{
  select: [project: string, key: string]
  collapse: []
}>()
const organization = ref<'project' | 'list'>('project')
const collapsedProjects = shallowRef(new Set<string>())
const filtersOpen = ref(false)

const allRoots = computed(() => props.allProjects.flatMap(project => project.roots))
const liveCount = computed(() => allRoots.value.filter(root => root.subLive).length)
const attentionCount = computed(() => allRoots.value.filter(root => root.subErrors && !root.subLive).length)
const unhealthySources = computed(() => props.sources.filter(source => source.state !== 'ready'))
const activeFilterCount = computed(() => [
  sourceFilter.value !== 'all',
  projectFilter.value !== 'all',
  liveOnly.value,
  attentionOnly.value,
  hideIdle.value,
  minimumSubagents.value > 0,
  sessionSort.value !== 'updated',
  hours.value !== 168,
].filter(Boolean).length)
const recentRoots = computed(() => props.projects
  .flatMap(project => project.roots.map(root => ({ project: project.id, root })))
  .sort((a, b) => compareRoots(a.root, b.root, sessionSort.value)))
const sourceOptions: Array<{ value: SessionSourceFilter, label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'copilot', label: 'Copilot' },
]
const presetRangeOptions: Array<{ value: number, label: string }> = [
  { value: 24, label: 'Last 24 hours' },
  { value: 168, label: 'Last 7 days' },
  { value: 720, label: 'Last 30 days' },
  { value: 0, label: 'All time' },
]
const rangeOptions = computed(() => presetRangeOptions.some(option => option.value === hours.value)
  ? presetRangeOptions
  : [{ value: hours.value, label: `Last ${hours.value} hours` }, ...presetRangeOptions])
const selectedRangeLabel = computed(() => rangeOptions.value.find(option => option.value === hours.value)?.label || 'selected range')
const hasSessionsInRange = computed(() => props.allProjects.some(project => project.roots.length))
const emptyDescription = computed(() => {
  const range = selectedRangeLabel.value.toLowerCase()
  if (sourceFilter.value === 'copilot') {
    return hasSessionsInRange.value
      ? `No Copilot chats match the current filters for ${range}.`
      : `No Copilot chats were found for ${range}. Try a longer date range or confirm Copilot Chat has local history.`
  }
  return hasSessionsInRange.value
    ? 'Try clearing one of the session filters.'
    : `No local chats were found for ${range}. Try a longer date range.`
})

const projectSelectOptions = computed(() => [
  { label: 'All projects', value: 'all' },
  ...props.projectOptions.map(project => ({ label: project.name, value: project.id })),
])
const subagentOptions = [
  { label: 'Any number', value: 0 },
  { label: '1 or more', value: 1 },
  { label: '3 or more', value: 3 },
  { label: '5 or more', value: 5 },
  { label: '10 or more', value: 10 },
]
const sortOptions: Array<{ label: string, value: SessionSort }> = [
  { label: 'Last updated', value: 'updated' },
  { label: 'Most subagents', value: 'subagents' },
]
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

// Tri-state view over the composable's two exclusive filter refs: writing a
// scope updates both refs consistently, replacing the pair of mutually
// re-triggering watchers this component used to need.
const sessionScope = computed<'all' | 'live' | 'attention'>({
  get: () => liveOnly.value ? 'live' : attentionOnly.value ? 'attention' : 'all',
  set: (scope) => {
    liveOnly.value = scope === 'live'
    attentionOnly.value = scope === 'attention'
  },
})
const liveOnlyToggle = computed({
  get: () => sessionScope.value === 'live',
  set: (enabled: boolean) => { sessionScope.value = enabled ? 'live' : 'all' },
})

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
        :class="{ selected: sessionScope === 'all' }"
        :aria-pressed="sessionScope === 'all'"
        @click="sessionScope = 'all'"
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
        :class="{ selected: sessionScope === 'live' }"
        :aria-pressed="sessionScope === 'live'"
        @click="sessionScope = 'live'"
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
        :class="{ selected: sessionScope === 'attention' }"
        :aria-pressed="sessionScope === 'attention'"
        @click="sessionScope = 'attention'"
      >
        <UIcon name="i-lucide-circle-alert" />
        <span>Needs attention</span>
        <span class="nav-count" :class="{ warning: attentionCount }">{{ attentionCount }}</span>
      </UButton>
      <UButton
        to="/costs"
        class="primary-nav-item"
        color="neutral"
        variant="ghost"
      >
        <UIcon name="i-lucide-chart-no-axes-combined" />
        <span>Costs</span>
      </UButton>
    </nav>

    <section
      v-if="costs && (costs.pricedRequests || costs.unpricedRequests)"
      class="sidebar-cost-summary"
      aria-label="Estimated Claude API cost"
    >
      <header>
        <span><UIcon name="i-lucide-circle-dollar-sign" />Estimated cost</span>
        <small>Claude API rates</small>
      </header>
      <dl>
        <div>
          <dt>Today</dt>
          <dd>{{ formatUsd(costs.todayUsd) }}</dd>
        </div>
        <div>
          <dt>Last 7 days</dt>
          <dd>{{ costs.last7DaysUsd === null ? '—' : formatUsd(costs.last7DaysUsd) }}</dd>
        </div>
      </dl>
      <p v-if="costs.last7DaysUsd === null">Choose a 7-day range to calculate the weekly total.</p>
      <p v-else-if="costs.unpricedRequests">{{ costs.unpricedRequests }} request{{ costs.unpricedRequests === 1 ? '' : 's' }} could not be priced.</p>
      <p>Transcript-only estimate; excludes hidden helper calls and plan billing.</p>
      <NuxtLink to="/costs">Open cost overview <UIcon name="i-lucide-arrow-right" /></NuxtLink>
    </section>

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
        <label class="project-filter range-filter">
          <span>Date range</span>
          <USelectMenu
            v-model="hours"
            :items="rangeOptions"
            value-key="value"
            label-key="label"
            size="xs"
            aria-label="Filter by date range"
            :search-input="false"
          />
        </label>
        <label class="project-filter range-filter">
          <span>Subagents</span>
          <USelectMenu
            v-model="minimumSubagents"
            :items="subagentOptions"
            value-key="value"
            label-key="label"
            size="xs"
            aria-label="Filter by minimum subagents"
            :search-input="false"
          />
        </label>
        <label class="project-filter range-filter">
          <span>Sort by</span>
          <USelectMenu
            v-model="sessionSort"
            :items="sortOptions"
            value-key="value"
            label-key="label"
            size="xs"
            aria-label="Sort sessions"
            :search-input="false"
          />
        </label>
        <div class="filters">
          <UCheckbox v-model="liveOnlyToggle" class="toggle" label="Live only" />
          <UCheckbox v-model="hideIdle" class="toggle" label="Hide empty" />
        </div>
        <div v-if="unhealthySources.length" class="source-statuses" aria-live="polite">
          <UAlert
            v-for="source in unhealthySources"
            :key="source.source"
            :class="source.state"
            :color="source.state === 'degraded' ? 'warning' : 'error'"
            variant="soft"
            :title="sessionSourceLabel(source.source)"
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
            :description="emptyDescription"
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
            :description="emptyDescription"
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
