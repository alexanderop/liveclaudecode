<script setup lang="ts">
import type { RunNode, RunResponse } from '#shared/types/run'
import { normalizeSessionLabel } from '#shared/utils/session-label'
import { formatRelativeAge } from '~/utils/format'
import { buildParentIndex, flattenRunTree } from '~/utils/execution-analysis'
import { agentState, lastActivityTime, type AgentDisplayState } from '~/utils/session-state'

const props = defineProps<{
  root: RunNode | null
  run: RunResponse | null
}>()

const emit = defineEmits<{ select: [key: string] }>()
const now = useTimestamp({ interval: 10_000 })

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
  const parentByKey = buildParentIndex(props.root)
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
/**
 * The instruction the session is currently working from. It is only worth
 * showing once it has moved on from the prompt the heading already reports.
 */
const currentInstruction = computed(() => {
  const root = props.root
  if (!root?.lastPrompt || root.lastPrompt === root.label) return ''
  return normalizeSessionLabel(root.lastPrompt, '')
})
</script>

<template>
  <div class="now-view">
    <UEmpty
      v-if="!root"
      icon="i-lucide-gauge"
      title="No session selected"
      description="Choose a session to see what every agent is doing now."
      variant="naked"
    />

    <template v-else>
      <section class="now-intro">
        <span class="section-eyebrow">Session now</span>
        <h2>What is happening now</h2>
        <p>Agents are ordered by attention needed, then by their most recent activity.</p>
      </section>

      <section v-if="currentInstruction" class="now-instruction">
        <UIcon name="i-lucide-quote" />
        <span>
          <small>{{ root.subLive ? 'Working from' : 'Last instruction' }}</small>
          <strong :title="currentInstruction">{{ currentInstruction }}</strong>
        </span>
      </section>

      <section class="now-health" :class="{ warning: issueCount, failed: counts.failed }">
        <span
          class="now-health-icon"
          role="img"
          :aria-label="counts.failed ? 'Session failed' : activeCount ? 'Session active' : issueCount ? 'Session needs attention' : 'Session healthy'"
        >
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
          <time>{{ formatRelativeAge(agent.idleMs) }}</time>
          <span class="now-state" :class="agent.status.state">
            <i />{{ agent.status.label }}
            <b v-if="agent.status.issueCount">{{ agent.status.issueCount }}</b>
          </span>
        </button>
      </section>
    </template>
  </div>
</template>
