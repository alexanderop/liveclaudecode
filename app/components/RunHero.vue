<script setup lang="ts">
import type { RunNode } from '#shared/types/run'
import { normalizeSessionLabel } from '#shared/utils/session-label'

const props = defineProps<{
  root: RunNode | null
  selected: RunNode | null
  fileCount: number
  transcriptPath: string
  sidebarVisible: boolean
}>()

const followActive = defineModel<boolean>('followActive', { required: true })
const emit = defineEmits<{ showSidebar: [] }>()
const toast = useToast()
const copyState = ref<'idle' | 'copied' | 'failed'>('idle')
let copyResetTimer: ReturnType<typeof setTimeout> | undefined

const copyLabel = computed(() =>
  copyState.value === 'copied' ? 'Copied' : copyState.value === 'failed' ? 'Try again' : 'Copy',
)
const displayLabel = computed(() => normalizeSessionLabel(props.root?.label || '', 'Select a local session'))

async function copyTranscriptPath(): Promise<void> {
  if (!props.transcriptPath) return
  try {
    await navigator.clipboard.writeText(props.transcriptPath)
    copyState.value = 'copied'
    toast.add({ title: 'Transcript path copied', icon: 'i-lucide-check', color: 'success' })
  } catch {
    copyState.value = 'failed'
    toast.add({ title: 'Could not copy transcript path', icon: 'i-lucide-copy-x', color: 'error' })
  }
  if (copyResetTimer) clearTimeout(copyResetTimer)
  copyResetTimer = setTimeout(() => {
    copyState.value = 'idle'
  }, 2_000)
}

function flatten(node: RunNode, output: RunNode[] = []): RunNode[] {
  output.push(node)
  node.children.forEach(child => flatten(child, output))
  return output
}

const busy = computed(() => props.root ? flatten(props.root).filter(node => node.live) : [])
const waiting = computed(() => props.root ? flatten(props.root).filter(node => !node.live && node.spawnState === 'running') : [])
const leads = computed(() => busy.value.filter(node => node.current).slice(-3).reverse())
const sourceLabel = computed(() => {
  const source = props.root?.source
  return source === 'claude' ? 'Claude' : source === 'codex' ? 'Codex' : source === 'copilot' ? 'Copilot' : 'Local'
})
const status = computed(() => {
  const root = props.root
  if (!root) return { label: 'No session selected', class: 'done', icon: 'i-lucide-circle' }
  if (root.subLive) return { label: 'Running', class: 'running', icon: 'i-lucide-loader-circle' }
  if (root.subErrors) {
    if (root.finalText) {
      return {
        label: 'Complete with warnings',
        class: 'warning',
        icon: 'i-lucide-circle-alert',
      }
    }
    return {
      label: 'Needs attention',
      class: 'failed',
      icon: 'i-lucide-circle-alert',
    }
  }
  return { label: 'Complete', class: 'done', icon: 'i-lucide-circle-check' }
})

const kpis = computed(() => {
  const root = props.root
  if (!root) return []
  return [
    { label: 'agents', value: root.subAgents + 1 },
    { label: 'tools run', value: root.subTools },
    { label: 'files changed', value: props.fileCount, class: 'warning' },
    { label: 'tool errors', value: root.subErrors, class: root.subErrors ? 'bad' : '' },
    { label: 'out tokens', value: formatCount(root.tokensOut) },
    { label: 'elapsed', value: formatDuration(root.firstTs, root.subLast) },
  ]
})

watch(() => props.transcriptPath, () => {
  copyState.value = 'idle'
})

onUnmounted(() => {
  if (copyResetTimer) clearTimeout(copyResetTimer)
})
</script>

<template>
  <header class="hero">
    <UDashboardNavbar class="location-bar" :toggle="true" :ui="{ root: '!px-3 !h-[55px]' }">
      <template #leading>
        <UButton
          v-if="!sidebarVisible"
          class="sidebar-toggle header-sidebar-toggle"
          color="neutral"
          variant="ghost"
          icon="i-lucide-panel-left"
          aria-label="Show sidebar"
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
        <div class="breadcrumbs">
        <span class="breadcrumb-root">
          <UIcon name="i-lucide-terminal-square" />
          {{ root ? sourceLabel : 'Local sessions' }}
        </span>
        <UIcon name="i-lucide-chevron-right" />
        <span>Sessions</span>
        <UIcon name="i-lucide-chevron-right" />
        <strong>{{ root?.sid?.slice(0, 8) || 'Select a session' }}</strong>
        </div>
      </template>
      <template #right>
        <div class="header-actions">
        <UDashboardSearchButton label="Jump to session" class="dashboard-search-button" />
        <UColorModeSelect
          class="color-mode-select"
          aria-label="Color mode"
          color="neutral"
          variant="ghost"
          :search-input="false"
        />
        <UButton
          class="quiet-action"
          color="neutral"
          variant="ghost"
          icon="i-lucide-locate-fixed"
          :class="{ active: followActive }"
          :aria-pressed="followActive"
          @click="followActive = !followActive"
        >
          Follow active
        </UButton>
        </div>
      </template>
    </UDashboardNavbar>

    <div class="hero-body">
      <div class="session-heading">
        <div class="session-kicker">
          <UIcon :name="selected?.agentType ? 'i-lucide-bot' : 'i-lucide-message-square-code'" />
          {{ selected?.agentType || `${sourceLabel} session` }}
        </div>
        <h1>{{ displayLabel }}</h1>
        <div class="status-line">
          <template v-if="busy.length">
            <span class="status-dot running" />
            <strong>
              {{ busy.length }} {{ busy.length === 1 ? 'agent' : 'agents' }} active
            </strong>
            <span v-if="waiting.length" class="muted-separator">·</span>
            <span v-if="waiting.length">{{ waiting.length }} waiting</span>
            <template v-if="leads[0]?.current">
              <span class="muted-separator">·</span>
              <span>{{ leads[0].label }}</span>
              <span class="muted">{{ leads[0].current?.tool }} · {{ leads[0].current?.summary.replace(/\s+/g, ' ').slice(0, 76) }}</span>
              <span v-if="leads.length > 1" class="muted">+{{ leads.length - 1 }} more current {{ leads.length === 2 ? 'action' : 'actions' }}</span>
            </template>
            <span v-else class="muted">Thinking…</span>
          </template>
          <template v-else-if="root">
            <span class="status-dot" :class="root.subErrors ? root.finalText ? 'warning' : 'failed' : 'completed'" />
            <span>{{ root.subErrors ? root.finalText ? `Session completed with ${root.subErrors} recovered tool ${root.subErrors === 1 ? 'error' : 'errors'}` : 'Session needs attention' : 'Session completed' }}</span>
            <span v-if="selected?.finalText || root.finalText" class="muted last-message">
              {{ (selected?.finalText || root.finalText || '').split('\n')[0]?.slice(0, 110) }}
            </span>
          </template>
          <template v-else>Select a session from the sidebar to inspect its work.</template>
        </div>
      </div>
      <div class="hero-summary-actions">
        <span class="pill" :class="status.class">
          <UIcon :name="status.icon" />
          {{ status.label }}
        </span>
        <details v-if="root" class="session-info-disclosure">
          <summary>
            <UIcon name="i-lucide-info" />
            Session info
            <UIcon class="disclosure-chevron" name="i-lucide-chevron-down" />
          </summary>
          <div class="session-info-card">
            <div class="session-info-heading">
              <span>Session details</span>
              <strong>{{ root.sid?.slice(0, 8) }}</strong>
            </div>
            <div class="kpis">
              <div v-for="kpi in kpis" :key="kpi.label" class="kpi" :class="kpi.class">
                <span>{{ kpi.label }}</span><b>{{ kpi.value }}</b>
              </div>
            </div>
            <div v-if="transcriptPath" class="transcript-location">
              <UIcon name="i-lucide-file-json" />
              <span>JSONL</span>
              <code :title="transcriptPath">{{ transcriptPath }}</code>
              <UButton
                color="neutral"
                variant="ghost"
                size="xs"
                :icon="copyState === 'copied' ? 'i-lucide-check' : 'i-lucide-copy'"
                :aria-label="copyState === 'copied' ? 'JSONL file path copied' : 'Copy JSONL file path'"
                :title="copyState === 'copied' ? 'JSONL file path copied' : 'Copy JSONL file path'"
                aria-live="polite"
                @click="copyTranscriptPath"
              >
                {{ copyLabel }}
              </UButton>
            </div>
          </div>
        </details>
      </div>
    </div>
  </header>
</template>
