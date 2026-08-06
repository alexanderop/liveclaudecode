<script setup lang="ts">
import type { ProjectRunsWire } from '#shared/schemas/api'
import { normalizeSessionLabel } from '#shared/utils/session-label'
import { formatRelativeAge, sessionSourceLabel } from '~/utils/format'
import { buildParentIndex, flattenRunTree } from '~/utils/execution-analysis'
import {
  agentState,
  agentStateIcon,
  lastActivityTime,
  type AgentDisplayState,
} from '~/utils/session-state'
import { structuralComputed, structurallyEqual } from '~/utils/structural-computed'

const props = defineProps<{
  projects: ReadonlyArray<ProjectRunsWire>
}>()

const emit = defineEmits<{
  select: [project: string, key: string]
}>()

const now = useTimestamp({ interval: 10_000 })

const stateOrder: Partial<Record<AgentDisplayState, number>> = {
  running: 0,
  thinking: 1,
  waiting: 2,
}

// The clock-dependent idle age is derived per card in the template so the
// 10s tick does not rebuild (or structurally change) this list.
const activeAgents = structuralComputed(() => props.projects.flatMap(project => project.roots.flatMap(root => {
  const parentByKey = buildParentIndex(root)

  return flattenRunTree(root).flatMap((node) => {
    const state = agentState(node)
    if (!node.live && node.spawnState !== 'running') return []
    return [{
      node,
      root,
      project,
      parent: parentByKey.get(node.key) || null,
      state,
      timestamp: lastActivityTime(node),
    }]
  })
})).sort((left, right) => (stateOrder[left.state.state] ?? 9) - (stateOrder[right.state.state] ?? 9)
  || (right.timestamp || 0) - (left.timestamp || 0)
  || left.node.label.localeCompare(right.node.label)), structurallyEqual)

const activeSessionCount = computed(() => new Set(activeAgents.value.map(agent => `${agent.project.id}\0${agent.root.key}`)).size)
const activeProjectCount = computed(() => new Set(activeAgents.value.map(agent => agent.project.id)).size)

function updatedAge(timestamp: number | null): string {
  return formatRelativeAge(
    timestamp === null ? null : Math.max(0, now.value - timestamp),
    { prefix: 'Updated', noneLabel: 'No recent event' },
  )
}

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
          <span class="active-agent-provider" :class="agent.node.source">{{ sessionSourceLabel(agent.node.source) }}</span>
        </span>

        <span class="active-agent-identity">
          <span class="active-agent-avatar" :class="agent.state.state"><UIcon :name="agentStateIcon(agent.state.state)" /></span>
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
          <time>{{ updatedAge(agent.timestamp) }}</time>
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
