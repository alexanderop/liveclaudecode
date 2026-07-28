<script setup lang="ts">
import type { RunNode } from '#shared/types/run'

const live = useLiveRuns()
const densities = ['compact', 'normal', 'raw'] as const
const views = [
  { id: 'activity', label: 'Activity', icon: 'i-lucide-activity', shortcut: 'A' },
  { id: 'guide', label: 'Guide', icon: 'i-lucide-map', shortcut: 'G' },
  { id: 'diagnostics', label: 'Diagnostics', icon: 'i-lucide-stethoscope', shortcut: 'I' },
  { id: 'changes', label: 'Changes', icon: 'i-lucide-files', shortcut: 'D' },
] as const
type SessionPanel = typeof views[number]['id']

const activePanel = ref<SessionPanel | 'inspector' | null>(null)
const inspectedKey = ref<string | null>(null)
const sidebarVisible = ref(true)

const inspectedNode = computed(() => {
  if (!inspectedKey.value || !live.selectedRoot.value) return null
  const visit = (node: RunNode): RunNode | null => {
    if (node.key === inspectedKey.value) return node
    for (const child of node.children) {
      const found = visit(child)
      if (found) return found
    }
    return null
  }
  return visit(live.selectedRoot.value)
})

function closePanel(): void {
  activePanel.value = null
  inspectedKey.value = null
}

function inspectCanvasNode(key: string): void {
  inspectedKey.value = key
  activePanel.value = 'inspector'
}

function openSessionPanel(panel: SessionPanel): void {
  if (activePanel.value === panel) {
    closePanel()
    return
  }
  inspectedKey.value = null
  activePanel.value = panel
}

async function selectSession(project: string, key: string): Promise<void> {
  closePanel()
  await live.select(key, project)
}

function handleShortcut(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b' && !event.altKey) {
    event.preventDefault()
    sidebarVisible.value = !sidebarVisible.value
    return
  }
  if (target?.matches('input, textarea, [contenteditable="true"]') || event.metaKey || event.ctrlKey || event.altKey) return
  if (event.key === 'Escape') {
    closePanel()
    return
  }
  if (event.key.toLowerCase() === 'c') {
    closePanel()
    return
  }

  const shortcuts: Record<string, SessionPanel> = {
    a: 'activity',
    g: 'guide',
    i: 'diagnostics',
    d: 'changes',
  }
  const panel = shortcuts[event.key.toLowerCase()]
  if (!panel) return
  openSessionPanel(panel)
}

watch(
  () => `${live.selectedProject.value || ''}\0${live.selectedKey.value || ''}`,
  () => closePanel(),
)

watch(inspectedNode, node => {
  if (inspectedKey.value && !node) closePanel()
})

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
      v-model:source-filter="live.sourceFilter.value"
      v-model:project-filter="live.projectFilter.value"
      v-model:live-only="live.liveOnly.value"
      v-model:attention-only="live.attentionOnly.value"
      v-model:hide-idle="live.hideIdle.value"
      :projects="live.visibleProjects.value"
      :all-projects="live.projects.value"
      :sources="live.sources.value"
      :project-options="live.projectOptions.value"
      :loading="live.loading.value"
      :selected-project="live.selectedProject.value"
      :selected-key="live.selectedKey.value"
      @select="selectSession"
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
      <div class="session-workspace" :class="{ 'panel-open': activePanel }">
        <section class="session-primary">
          <div class="view-bar canvas-view-bar">
            <div class="canvas-view-identity">
              <UIcon name="i-lucide-workflow" />
              <span>
                <strong>Session canvas</strong>
                <small>Pan, zoom, and select a node to inspect it</small>
              </span>
            </div>
            <nav class="view-tabs" aria-label="Supporting session views">
              <button
                v-for="view in views"
                :key="view.id"
                type="button"
                :class="{ selected: activePanel === view.id }"
                :aria-pressed="activePanel === view.id"
                @click="openSessionPanel(view.id)"
              >
                <UIcon :name="view.icon" />
                {{ view.label }}
                <kbd>{{ view.shortcut }}</kbd>
              </button>
            </nav>
          </div>

          <RunCanvas
            :run="live.run.value"
            :selected-key="inspectedKey"
            @select="inspectCanvasNode"
            @deselect="closePanel"
          />
        </section>

        <RunInspector
          v-if="activePanel === 'inspector'"
          :run="live.run.value"
          :root="live.selectedRoot.value"
          :selected="inspectedNode"
          :selected-key="inspectedKey"
          @select="inspectCanvasNode"
          @close="closePanel"
        />

        <aside v-else-if="activePanel" class="session-panel" :aria-label="`${views.find(view => view.id === activePanel)?.label} panel`">
          <header class="session-panel-title">
            <span>
              <UIcon :name="views.find(view => view.id === activePanel)?.icon" />
              {{ views.find(view => view.id === activePanel)?.label }}
            </span>
            <button type="button" aria-label="Close panel" @click="closePanel">
              <UIcon name="i-lucide-x" />
            </button>
          </header>
          <div v-if="activePanel === 'activity'" class="session-panel-controls">
            <div class="segments" role="group" aria-label="Event detail">
              <button
                v-for="option in densities"
                :key="option"
                type="button"
                :class="{ selected: live.density.value === option }"
                :aria-pressed="live.density.value === option"
                @click="live.density.value = option"
              >{{ option }}</button>
            </div>
            <button
              type="button"
              class="quiet-action"
              :class="{ active: live.errorsOnly.value }"
              :aria-pressed="live.errorsOnly.value"
              @click="live.errorsOnly.value = !live.errorsOnly.value"
            >
              <UIcon name="i-lucide-circle-alert" />Errors
            </button>
          </div>
          <EventFeed
            v-if="activePanel === 'activity'"
            :events="live.events.value"
            :density="live.density.value"
            :errors-only="live.errorsOnly.value"
            :follow-output="live.followOutput.value"
            @select="inspectCanvasNode"
          />
          <RunOverview
            v-else-if="activePanel === 'guide'"
            :run="live.run.value"
            :selected-key="inspectedKey"
            @select="inspectCanvasNode"
          />
          <RunDiagnostics
            v-else-if="activePanel === 'diagnostics'"
            :run="live.run.value"
            :selected-key="inspectedKey"
            @select="inspectCanvasNode"
          />
          <RunChanges v-else-if="activePanel === 'changes'" :run="live.run.value" />
        </aside>
      </div>
    </main>
  </div>
</template>
