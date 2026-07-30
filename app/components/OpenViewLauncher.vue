<script setup lang="ts">
import type { PrimaryWorkspaceKind } from '~/utils/workspace-state'

type Destination = {
  id: PrimaryWorkspaceKind
  label: string
  icon: string
  count: number | null
}

const props = defineProps<{
  current: PrimaryWorkspaceKind
  agentCount: number
  activityCount: number
  changeCount: number
  attentionCount: number
  askActive: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{
  select: [destination: PrimaryWorkspaceKind | 'ask']
}>()

const destinations = computed<Destination[]>(() => [
  { id: 'overview', label: 'Overview', icon: 'i-lucide-layout-dashboard', count: null },
  { id: 'map', label: 'Agents', icon: 'i-lucide-workflow', count: props.agentCount },
  { id: 'activity', label: 'Activity', icon: 'i-lucide-activity', count: props.activityCount },
  { id: 'changes', label: 'Changes', icon: 'i-lucide-files', count: props.changeCount },
  { id: 'diagnostics', label: 'Diagnostics', icon: 'i-lucide-stethoscope', count: props.attentionCount },
])
</script>

<template>
  <div class="session-view-navigation">
    <nav class="session-view-tabs" aria-label="Session views">
      <button
        v-for="destination in destinations"
        :key="destination.id"
        type="button"
        :class="{ selected: destination.id === current, attention: destination.id === 'diagnostics' && destination.count }"
        :aria-current="destination.id === current ? 'page' : undefined"
        :disabled="disabled"
        :data-destination="destination.id"
        @click="emit('select', destination.id)"
      >
        <UIcon :name="destination.icon" />
        <span>{{ destination.label }}</span>
        <span v-if="destination.count !== null" class="session-view-count">{{ destination.count }}</span>
      </button>
    </nav>

    <button
      type="button"
      class="session-ask-action"
      :class="{ active: askActive }"
      :aria-pressed="askActive"
      :disabled="disabled"
      @click="emit('select', 'ask')"
    >
      <UIcon name="i-lucide-message-square" />
      <span>Ask</span>
      <span v-if="askActive" class="session-ask-indicator" aria-label="Ask conversation active" />
    </button>
  </div>
</template>
