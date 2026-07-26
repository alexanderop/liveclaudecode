<script setup lang="ts">
const live = useLiveRuns()
const densities = ['compact', 'normal', 'raw'] as const
const views = [
  { id: 'activity', label: 'Activity', icon: 'i-lucide-activity', shortcut: 'A' },
  { id: 'guide', label: 'Guide', icon: 'i-lucide-map', shortcut: 'G' },
  { id: 'canvas', label: 'Canvas', icon: 'i-lucide-workflow', shortcut: 'C' },
  { id: 'diagnostics', label: 'Diagnostics', icon: 'i-lucide-stethoscope', shortcut: 'I' },
  { id: 'changes', label: 'Changes', icon: 'i-lucide-files', shortcut: 'D' },
] as const
type SessionView = typeof views[number]['id']

const activeView = ref<SessionView>('activity')
const sidebarVisible = ref(true)

function handleShortcut(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b' && !event.altKey) {
    event.preventDefault()
    sidebarVisible.value = !sidebarVisible.value
    return
  }
  if (target?.matches('input, textarea, [contenteditable="true"]') || event.metaKey || event.ctrlKey || event.altKey) return

  const shortcuts: Record<string, SessionView> = {
    a: 'activity',
    g: 'guide',
    c: 'canvas',
    i: 'diagnostics',
    d: 'changes',
  }
  const view = shortcuts[event.key.toLowerCase()]
  if (!view) return
  activeView.value = view
}

onMounted(() => window.addEventListener('keydown', handleShortcut))
onUnmounted(() => window.removeEventListener('keydown', handleShortcut))
</script>

<template>
  <div class="shell">
    <UBadge
      v-if="live.offline.value"
      class="offline-badge"
      color="error"
      variant="soft"
      icon="i-lucide-wifi-off"
      label="Viewer offline — retrying"
    />
    <RunSidebar
      :class="{ 'sidebar-collapsed': !sidebarVisible }"
      v-model:query="live.query.value"
      v-model:live-only="live.liveOnly.value"
      v-model:attention-only="live.attentionOnly.value"
      v-model:hide-idle="live.hideIdle.value"
      :projects="live.visibleProjects.value"
      :all-projects="live.projects.value"
      :selected-project="live.selectedProject.value"
      :selected-key="live.selectedKey.value"
      @select="(project, key) => live.select(key, project)"
      @collapse="sidebarVisible = false"
    />
    <main class="main-content">
      <RunHero
        v-model:follow-active="live.followActive.value"
        :sidebar-visible="sidebarVisible"
        :root="live.selectedRoot.value"
        :selected="live.selectedNode.value"
        :file-count="live.run.value?.files.length || 0"
        @show-sidebar="sidebarVisible = true"
      />
      <div class="session-workspace">
        <section class="session-primary">
          <div class="view-bar">
            <nav class="view-tabs" aria-label="Session views">
              <button
                v-for="view in views"
                :key="view.id"
                type="button"
                :class="{ selected: activeView === view.id }"
                :aria-current="activeView === view.id ? 'page' : undefined"
                @click="activeView = view.id"
              >
                <UIcon :name="view.icon" />
                {{ view.label }}
                <kbd>{{ view.shortcut }}</kbd>
              </button>
            </nav>

            <template v-if="activeView === 'activity'">
              <div class="segments" aria-label="Event detail">
                <button
                  v-for="option in densities"
                  :key="option"
                  type="button"
                  :class="{ selected: live.density.value === option }"
                  @click="live.density.value = option"
                >{{ option }}</button>
              </div>
              <button
                type="button"
                class="quiet-action"
                :class="{ active: live.errorsOnly.value }"
                :aria-pressed="live.errorsOnly.value"
                title="Show errors only"
                @click="live.errorsOnly.value = !live.errorsOnly.value"
              >
                <UIcon name="i-lucide-circle-alert" />
                Errors
              </button>
              <button
                type="button"
                class="icon-action"
                :class="{ active: live.followOutput.value }"
                :aria-pressed="live.followOutput.value"
                title="Follow new activity"
                @click="live.followOutput.value = !live.followOutput.value"
              >
                <UIcon name="i-lucide-arrow-down-to-line" />
              </button>
            </template>
          </div>

          <EventFeed
            v-if="activeView === 'activity'"
            :events="live.events.value"
            :density="live.density.value"
            :errors-only="live.errorsOnly.value"
            :follow-output="live.followOutput.value"
            @select="live.select"
          />
          <RunOverview
            v-else-if="activeView === 'guide'"
            :run="live.run.value"
            :selected-key="live.selectedKey.value"
            @select="live.select"
          />
          <RunCanvas
            v-else-if="activeView === 'canvas'"
            :run="live.run.value"
            :selected-key="live.selectedKey.value"
            @select="live.select"
          />
          <RunDiagnostics
            v-else-if="activeView === 'diagnostics'"
            :run="live.run.value"
            :selected-key="live.selectedKey.value"
            @select="live.select"
          />
          <RunChanges v-else :run="live.run.value" />
        </section>

        <RunInspector
          :run="live.run.value"
          :root="live.selectedRoot.value"
          :selected="live.selectedNode.value"
          :selected-key="live.selectedKey.value"
          @select="live.select"
        />
      </div>
    </main>
  </div>
</template>
