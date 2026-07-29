<script setup lang="ts">
import type { RunNode } from '#shared/types/run'

const props = defineProps<{
  root: RunNode | null
  selected: RunNode | null
  fileCount: number
  transcriptPath: string
  sidebarVisible: boolean
}>()

const followActive = defineModel<boolean>('followActive', { required: true })
const emit = defineEmits<{ showSidebar: [] }>()
const copyState = ref<'idle' | 'copied' | 'failed'>('idle')
let copyResetTimer: ReturnType<typeof setTimeout> | undefined

const copyLabel = computed(() =>
  copyState.value === 'copied' ? 'Copied' : copyState.value === 'failed' ? 'Try again' : 'Copy',
)

async function copyTranscriptPath(): Promise<void> {
  if (!props.transcriptPath) return
  try {
    await navigator.clipboard.writeText(props.transcriptPath)
    copyState.value = 'copied'
  } catch {
    copyState.value = 'failed'
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
const lead = computed(() => busy.value.filter(node => node.current).at(-1) || null)
const sourceLabel = computed(() => {
  const source = props.root?.source
  return source === 'claude' ? 'Claude' : source === 'codex' ? 'Codex' : source === 'copilot' ? 'Copilot' : 'Local'
})
const status = computed(() => {
  const root = props.root
  if (!root) return { label: 'No session selected', class: 'done', icon: 'i-lucide-circle' }
  if (root.subLive) return { label: 'Running', class: 'running', icon: 'i-lucide-loader-circle' }
  if (root.subErrors) {
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
    { label: 'errors', value: root.subErrors, class: root.subErrors ? 'bad' : '' },
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
    <div class="location-bar">
      <div class="breadcrumbs">
        <button
          v-if="!sidebarVisible"
          type="button"
          class="sidebar-toggle header-sidebar-toggle"
          aria-label="Show sidebar"
          aria-keyshortcuts="Meta+B Control+B"
          title="Show sidebar (⌘B)"
          @click="emit('showSidebar')"
        >
          <UIcon name="i-lucide-panel-left" />
        </button>
        <span class="breadcrumb-root">
          <UIcon name="i-lucide-terminal-square" />
          {{ root ? sourceLabel : 'Local sessions' }}
        </span>
        <UIcon name="i-lucide-chevron-right" />
        <span>Sessions</span>
        <UIcon name="i-lucide-chevron-right" />
        <strong>{{ root?.sid?.slice(0, 8) || 'Select a session' }}</strong>
      </div>
      <div class="header-actions">
        <button
          type="button"
          class="quiet-action"
          :class="{ active: followActive }"
          :aria-pressed="followActive"
          @click="followActive = !followActive"
        >
          <UIcon name="i-lucide-locate-fixed" />
          Follow active
        </button>
      </div>
    </div>

    <div class="hero-body">
      <div class="session-heading">
        <div class="session-kicker">
          <UIcon :name="selected?.agentType ? 'i-lucide-bot' : 'i-lucide-message-square-code'" />
          {{ selected?.agentType || `${sourceLabel} session` }}
        </div>
        <h1>{{ root?.label || 'Select a local session' }}</h1>
        <div v-if="transcriptPath" class="transcript-location">
          <UIcon name="i-lucide-file-json" />
          <span>JSONL</span>
          <code :title="transcriptPath">{{ transcriptPath }}</code>
          <button
            type="button"
            :aria-label="copyState === 'copied' ? 'JSONL file path copied' : 'Copy JSONL file path'"
            :title="copyState === 'copied' ? 'JSONL file path copied' : 'Copy JSONL file path'"
            aria-live="polite"
            @click="copyTranscriptPath"
          >
            <UIcon :name="copyState === 'copied' ? 'i-lucide-check' : 'i-lucide-copy'" />
            {{ copyLabel }}
          </button>
        </div>
        <div class="status-line">
          <template v-if="busy.length">
            <span class="status-dot running" />
            <strong>
              {{ busy.length === 1
                ? (busy[0]?.agentType ? busy[0].label : 'Main session')
                : `${busy.length} agents working` }}
            </strong>
            <template v-if="lead?.current">
              <span class="muted-separator">·</span>
              <span>{{ lead.current.tool }}</span>
              <span class="muted">{{ lead.current.summary.replace(/\s+/g, ' ').slice(0, 96) }}</span>
            </template>
            <span v-else class="muted">Thinking…</span>
          </template>
          <template v-else-if="root">
            <span class="status-dot" :class="{ failed: root.subErrors }" />
            <span>{{ root.subErrors ? 'Session ended with errors' : 'Session completed' }}</span>
            <span v-if="selected?.finalText || root.finalText" class="muted last-message">
              {{ (selected?.finalText || root.finalText || '').split('\n')[0]?.slice(0, 110) }}
            </span>
          </template>
          <template v-else>Select a session from the sidebar to inspect its work.</template>
        </div>
      </div>
      <span class="pill" :class="status.class">
        <UIcon :name="status.icon" />
        {{ status.label }}
      </span>
    </div>

    <div v-if="root" class="kpis">
      <div v-for="kpi in kpis" :key="kpi.label" class="kpi" :class="kpi.class">
        <span>{{ kpi.label }}</span><b>{{ kpi.value }}</b>
      </div>
    </div>
  </header>
</template>
