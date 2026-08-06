<script setup lang="ts">
import type { RunNodeWire } from '#shared/schemas/api'
import { normalizeSessionLabel } from '#shared/utils/session-label'
import { sessionSourceLabel } from '~/utils/format'
import { sessionDisplayState, type SessionDisplayKind } from '~/utils/session-state'
import type { PrimaryWorkspaceKind } from '~/utils/workspace-state'

const props = withDefaults(defineProps<{
  root: RunNodeWire | null
  sidebarVisible: boolean
  workspace?: PrimaryWorkspaceKind
}>(), {
  workspace: 'overview',
})

const followActive = defineModel<boolean>('followActive', { required: true })
const emit = defineEmits<{ showSidebar: [], focus: [] }>()

const sourceLabel = computed(() => sessionSourceLabel(props.root?.source))
const title = computed(() => normalizeSessionLabel(props.root?.label || '', 'Local sessions'))
const showFollow = computed(() => ['overview', 'map', 'activity'].includes(props.workspace))
const statusPresentation: Record<SessionDisplayKind, { label: string, class: string }> = {
  inactive: { label: 'No session', class: 'inactive' },
  running: { label: 'Running', class: 'running' },
  stopped: { label: 'Stopped', class: 'warning' },
  failed: { label: 'Failed', class: 'failed' },
  warning: { label: 'Warnings', class: 'warning' },
  completed: { label: 'Complete', class: 'completed' },
}
const status = computed(() => {
  const state = sessionDisplayState(props.root, { emptyKind: 'completed' })
  return { ...statusPresentation[state.kind], icon: state.icon }
})
</script>

<template>
  <header class="hero compact-hero">
    <UDashboardNavbar class="location-bar" :toggle="true" :ui="{ root: '!px-3 !h-[55px]' }">
      <template #leading>
        <UButton
          v-if="!sidebarVisible"
          class="sidebar-toggle header-sidebar-toggle"
          color="neutral"
          variant="ghost"
          icon="i-lucide-panel-left"
          aria-label="Show session browser"
          aria-keyshortcuts="Meta+B Control+B"
          @click="emit('showSidebar')"
        />
        <UDashboardSidebarCollapse
          v-else
          class="header-sidebar-collapse"
          aria-keyshortcuts="Meta+B Control+B"
        />
      </template>
      <template #title>
        <div class="breadcrumbs" :title="`${sourceLabel} > ${title}`">
          <span class="breadcrumb-root"><UIcon name="i-lucide-terminal-square" />{{ sourceLabel }}</span>
          <UIcon name="i-lucide-chevron-right" />
          <strong>{{ title }}</strong>
        </div>
      </template>
      <template #right>
        <div class="header-actions">
          <span class="header-session-status" :class="status.class">
            <UIcon :name="status.icon" />{{ status.label }}
          </span>
          <UDashboardSearchButton label="Search" class="dashboard-search-button" />
          <UButton
            v-if="showFollow && root"
            class="quiet-action follow-active"
            color="neutral"
            variant="ghost"
            icon="i-lucide-locate-fixed"
            :class="{ active: followActive }"
            :aria-pressed="followActive"
            @click="followActive = !followActive"
          >Follow active</UButton>
          <UButton
            v-if="root"
            class="quiet-action focus-view-action"
            color="neutral"
            variant="ghost"
            icon="i-lucide-maximize-2"
            aria-label="Enter focus view"
            aria-keyshortcuts="F"
            @click="emit('focus')"
          >Focus</UButton>
          <UColorModeSelect
            class="color-mode-select"
            aria-label="Color mode"
            color="neutral"
            variant="ghost"
            :search-input="false"
          />
        </div>
      </template>
    </UDashboardNavbar>
  </header>
</template>
