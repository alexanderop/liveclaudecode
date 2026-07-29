<script setup lang="ts">
import type { RunNode, RunResponse } from '#shared/types/run'
import { normalizeSessionLabel } from '#shared/utils/session-label'
import { flattenRunTree } from '~/utils/execution-analysis'
import { agentState, lastActivityTime, type AgentDisplayState } from '~/utils/session-state'

const props = defineProps<{
  root: RunNode | null
  run: RunResponse | null
}>()

const emit = defineEmits<{ select: [key: string] }>()
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined

const stateOrder: Record<AgentDisplayState, number> = {
  failed: 0,
  warning: 1,
  running: 2,
  thinking: 3,
  waiting: 4,
  completed: 5,
  inactive: 6,
}

const agents = computed(() => {
  const nodes = flattenRunTree(props.root)
  const parentByKey = new Map<string, RunNode>()
  nodes.forEach(node => node.children.forEach(child => parentByKey.set(child.key, node)))
  return nodes.map((node, index) => {
    const status = agentState(node, props.run?.diagnostics.incidents)
    const timestamp = lastActivityTime(node)
    return {
      node,
      status,
      index,
      parent: parentByKey.get(node.key) || null,
      timestamp,
      idleMs: timestamp === null ? null : Math.max(0, now.value - timestamp),
    }
  }).sort((left, right) => stateOrder[left.status.state] - stateOrder[right.status.state]
    || (right.timestamp || 0) - (left.timestamp || 0)
    || left.index - right.index)
})

const counts = computed(() => agents.value.reduce<Record<AgentDisplayState, number>>((output, agent) => {
  output[agent.status.state] += 1
  return output
}, { running: 0, thinking: 0, waiting: 0, completed: 0, warning: 0, failed: 0, inactive: 0 }))

const activeCount = computed(() => counts.value.running + counts.value.thinking)
const completedCount = computed(() => counts.value.completed + counts.value.warning)
const issueCount = computed(() => agents.value.reduce((total, agent) => total + agent.status.issueCount, 0))

function relativeAge(milliseconds: number | null): string {
  if (milliseconds === null) return 'No event'
  const seconds = Math.floor(milliseconds / 1_000)
  if (seconds < 5) return 'Now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.floor(minutes / 60)}h ago`
}

onMounted(() => { timer = setInterval(() => { now.value = Date.now() }, 10_000) })
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div class="now-view">
    <div v-if="!root" class="empty-state">
      <span class="empty-state-icon"><UIcon name="i-lucide-gauge" /></span>
      <h2>No session selected</h2>
      <p>Choose a session to see what every agent is doing now.</p>
    </div>

    <template v-else>
      <section class="now-intro">
        <span class="section-eyebrow">Session now</span>
        <h2>What is happening now</h2>
        <p>Agents are ordered by attention needed, then by their most recent activity.</p>
      </section>

      <section class="now-health" :class="{ warning: issueCount, failed: counts.failed }">
        <span class="now-health-icon">
          <UIcon :name="counts.failed ? 'i-lucide-circle-x' : activeCount ? 'i-lucide-radio' : issueCount ? 'i-lucide-circle-alert' : 'i-lucide-circle-check'" />
        </span>
        <span>
          <strong v-if="activeCount">{{ activeCount }} active · {{ counts.waiting }} waiting · {{ completedCount }} returned</strong>
          <strong v-else-if="counts.failed">Completed with {{ counts.failed }} failed {{ counts.failed === 1 ? 'agent' : 'agents' }}</strong>
          <strong v-else-if="issueCount">All {{ completedCount }} agents returned · {{ issueCount }} recovered {{ issueCount === 1 ? 'issue' : 'issues' }}</strong>
          <strong v-else>All {{ completedCount }} agents returned successfully</strong>
          <small>{{ agents.length }} total agents · {{ formatCount(root.subTools) }} tool calls</small>
        </span>
      </section>

      <div class="now-counts" aria-label="Agent state totals">
        <span v-if="counts.failed" class="failed"><b>{{ counts.failed }}</b> failed</span>
        <span v-if="counts.warning" class="warning"><b>{{ counts.warning }}</b> {{ counts.warning === 1 ? 'warning' : 'warnings' }}</span>
        <span v-if="counts.running"><b>{{ counts.running }}</b> running</span>
        <span v-if="counts.thinking"><b>{{ counts.thinking }}</b> thinking</span>
        <span v-if="counts.waiting"><b>{{ counts.waiting }}</b> waiting</span>
        <span><b>{{ completedCount }}</b> completed</span>
      </div>

      <section class="now-board" aria-label="Agent status board">
        <div class="now-board-head" aria-hidden="true">
          <span>Agent</span><span>Current action</span><span>Last event</span><span>State</span>
        </div>
        <button
          v-for="agent in agents"
          :key="agent.node.key"
          type="button"
          class="now-agent"
          :class="agent.status.state"
          @click="emit('select', agent.node.key)"
        >
          <span class="now-agent-identity">
            <span class="now-agent-icon"><UIcon :name="agent.node.kind === 'session' ? 'i-lucide-message-square-code' : 'i-lucide-bot'" /></span>
            <span>
              <strong :title="agent.node.label">{{ normalizeSessionLabel(agent.node.label, agent.node.key) }}</strong>
              <small>{{ agent.node.agentType || 'Main session' }}<template v-if="agent.parent"> · under {{ normalizeSessionLabel(agent.parent.label, agent.parent.key) }}</template></small>
            </span>
          </span>
          <span class="now-agent-action">
            <strong>{{ agent.node.current?.tool || (agent.node.finalText ? 'Result returned' : agent.status.label) }}</strong>
            <small>{{ agent.node.current?.summary || agent.status.detail }}</small>
          </span>
          <time>{{ relativeAge(agent.idleMs) }}</time>
          <span class="now-state" :class="agent.status.state">
            <i />{{ agent.status.label }}
            <b v-if="agent.status.issueCount">{{ agent.status.issueCount }}</b>
          </span>
        </button>
      </section>
    </template>
  </div>
</template>
