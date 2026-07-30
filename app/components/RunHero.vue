<script setup lang="ts">
import type { RunNode } from '#shared/types/run'
import { normalizeSessionLabel } from '#shared/utils/session-label'
import type { PrimaryWorkspaceKind } from '~/utils/workspace-state'

const props = withDefaults(defineProps<{
  root: RunNode | null
  sidebarVisible: boolean
  workspace?: PrimaryWorkspaceKind
}>(), {
  workspace: 'overview',
})

const followActive = defineModel<boolean>('followActive', { required: true })
const emit = defineEmits<{ showSidebar: [] }>()

const sourceLabel = computed(() => {
  const source = props.root?.source
  return source === 'claude' ? 'Claude' : source === 'codex' ? 'Codex' : source === 'copilot' ? 'Copilot' : 'Local'
})
const title = computed(() => normalizeSessionLabel(props.root?.label || '', 'Local sessions'))
const showFollow = computed(() => ['overview', 'map', 'activity'].includes(props.workspace))
const status = computed(() => {
  const root = props.root
  if (!root) return { label: 'No session', class: 'inactive', icon: 'i-lucide-circle' }
  if (root.subLive) return { label: 'Running', class: 'running', icon: 'i-lucide-radio' }
  if (root.stoppedByUser) return { label: 'Stopped', class: 'warning', icon: 'i-lucide-circle-stop' }
  if (root.subErrors && !root.finalText) return { label: 'Failed', class: 'failed', icon: 'i-lucide-circle-x' }
  if (root.subErrors) return { label: 'Warnings', class: 'warning', icon: 'i-lucide-triangle-alert' }
  return { label: 'Complete', class: 'completed', icon: 'i-lucide-circle-check' }
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
