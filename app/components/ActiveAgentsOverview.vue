<script setup lang="ts">
import type { ProjectRuns, RunNode } from '#shared/types/run'
import { normalizeSessionLabel } from '#shared/utils/session-label'
import { flattenRunTree } from '~/utils/execution-analysis'
import {
  agentState,
  lastActivityTime,
  type AgentDisplayState,
} from '~/utils/session-state'

const props = defineProps<{
  projects: ProjectRuns[]
}>()

const emit = defineEmits<{
  select: [project: string, key: string]
}>()

const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined

const stateOrder: Partial<Record<AgentDisplayState, number>> = {
  running: 0,
  thinking: 1,
  waiting: 2,
}

const activeAgents = computed(() => props.projects.flatMap(project => project.roots.flatMap(root => {
  const nodes = flattenRunTree(root)
  const parentByKey = new Map<string, RunNode>()
  nodes.forEach(node => node.children.forEach(child => parentByKey.set(child.key, node)))

  return nodes.flatMap((node) => {
    const state = agentState(node)
    if (!node.live && node.spawnState !== 'running') return []
    const timestamp = lastActivityTime(node)
    return [{
      node,
      root,
      project,
      parent: parentByKey.get(node.key) || null,
      state,
      timestamp,
      idleMs: timestamp === null ? null : Math.max(0, now.value - timestamp),
    }]
  })
})).sort((left, right) => (stateOrder[left.state.state] ?? 9) - (stateOrder[right.state.state] ?? 9)
  || (right.timestamp || 0) - (left.timestamp || 0)
  || left.node.label.localeCompare(right.node.label)))

const activeSessionCount = computed(() => new Set(activeAgents.value.map(agent => `${agent.project.id}\0${agent.root.key}`)).size)
const activeProjectCount = computed(() => new Set(activeAgents.value.map(agent => agent.project.id)).size)

function providerLabel(node: RunNode): string {
  if (node.source === 'claude') return 'Claude'
  if (node.source === 'codex') return 'Codex'
  return 'Copilot'
}

function stateIcon(state: AgentDisplayState): string {
  if (state === 'running') return 'i-lucide-hammer'
  if (state === 'thinking') return 'i-lucide-brain'
  return 'i-lucide-clock-3'
}

function relativeAge(milliseconds: number | null): string {
  if (milliseconds === null) return 'No recent event'
  const seconds = Math.floor(milliseconds / 1_000)
  if (seconds < 5) return 'Updated now'
  if (seconds < 60) return `Updated ${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `Updated ${minutes}m ago`
  return `Updated ${Math.floor(minutes / 60)}h ago`
}

onMounted(() => { timer = setInterval(() => { now.value = Date.now() }, 10_000) })
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <section class="active-agents-overview" aria-labelledby="active-agents-heading">
    <header class="active-agents-header">
      <div>
        <span class="section-eyebrow">Across your workspace</span>
        <h2 id="active-agents-heading">
          Active agents
          <span v-if="activeAgents.length" class="active-agents-total">{{ activeAgents.length }}</span>
        </h2>
        <p v-if="activeAgents.length">
          {{ activeSessionCount }} active {{ activeSessionCount === 1 ? 'session' : 'sessions' }}
          across {{ activeProjectCount }} {{ activeProjectCount === 1 ? 'project' : 'projects' }}
        </p>
        <p v-else>No agents are running right now.</p>
      </div>
      <span v-if="activeAgents.length" class="active-agents-live"><i />Live</span>
    </header>

    <div v-if="activeAgents.length" class="active-agent-grid">
      <button
        v-for="agent in activeAgents"
        :key="`${agent.project.id}/${agent.node.key}`"
        type="button"
        class="active-agent-card"
        :class="agent.state.state"
        :aria-label="`Open ${normalizeSessionLabel(agent.node.label, agent.node.key)} in ${agent.project.name}`"
        @click="emit('select', agent.project.id, agent.node.key)"
      >
        <span class="active-agent-card-topline">
          <span class="active-agent-project" :title="agent.project.name">
            <UIcon name="i-lucide-folder" />{{ agent.project.name }}
          </span>
          <span class="active-agent-provider" :class="agent.node.source">{{ providerLabel(agent.node) }}</span>
        </span>

        <span class="active-agent-identity">
          <span class="active-agent-avatar" :class="agent.state.state"><UIcon :name="stateIcon(agent.state.state)" /></span>
          <span>
            <strong :title="agent.node.label">{{ normalizeSessionLabel(agent.node.label, agent.node.key) }}</strong>
            <small>
              {{ agent.node.kind === 'session' ? 'Main session' : agent.node.agentType || 'Subagent' }}
              <template v-if="agent.parent"> · under {{ normalizeSessionLabel(agent.parent.label, agent.parent.key) }}</template>
            </small>
          </span>
          <span class="active-agent-state" :class="agent.state.state"><i />{{ agent.state.label }}</span>
        </span>

        <span class="active-agent-current">
          <span class="active-agent-tool">
            <UIcon name="i-lucide-terminal-square" />
            {{ agent.node.current?.tool || (agent.state.state === 'thinking' ? 'Thinking' : 'Waiting') }}
          </span>
          <strong>{{ agent.node.current?.summary || agent.state.detail }}</strong>
        </span>

        <span class="active-agent-card-footer">
          <span>{{ normalizeSessionLabel(agent.root.label, agent.root.key) }}</span>
          <time>{{ relativeAge(agent.idleMs) }}</time>
          <UIcon name="i-lucide-arrow-up-right" />
        </span>
      </button>
    </div>

    <div v-else class="active-agents-empty">
      <span><UIcon name="i-lucide-circle-check" /></span>
      <div><strong>Everything is quiet</strong><small>New active work will appear here automatically.</small></div>
    </div>
  </section>
</template>
