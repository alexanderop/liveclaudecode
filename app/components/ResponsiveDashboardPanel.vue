<script setup lang="ts">
defineProps<{
  mobile: boolean
  title: string
}>()

const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <UDashboardPanel
    v-if="!mobile"
    class="supporting-dashboard-panel"
    :ui="{ root: '!min-h-0', body: '!p-0 !gap-0 !overflow-hidden' }"
  >
    <slot />
  </UDashboardPanel>
  <USlideover
    v-else
    :open="true"
    :title="title"
    side="right"
    inset
    :ui="{ content: '!p-0 !max-w-[min(92vw,42rem)] supporting-slideover' }"
    @update:open="value => { if (!value) emit('close') }"
  >
    <template #content>
      <div class="mobile-supporting-panel">
        <slot />
      </div>
    </template>
  </USlideover>
</template>
