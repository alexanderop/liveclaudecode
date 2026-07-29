<script setup lang="ts">
import type { DiagnosticIncident, RunResponse, TurnTiming } from '#shared/types/run'

const props = defineProps<{
  run: RunResponse | null
  selectedKey: string | null
}>()

const emit = defineEmits<{ select: [key: string] }>()

const incidents = computed(() => [...(props.run?.diagnostics.incidents || [])].reverse())
const errorCount = computed(() => incidents.value.filter(incident => incident.severity === 'error').length)
const warningCount = computed(() => incidents.value.filter(incident => incident.severity === 'warning').length)
const totalTurnMs = computed(() => props.run?.diagnostics.turns.reduce((sum, turn) => sum + turn.durationMs, 0) || 0)
const slowTurns = computed(() => [...(props.run?.diagnostics.turns || [])]
  .sort((a, b) => b.durationMs - a.durationMs)
  .slice(0, 10))
const longestTurn = computed(() => slowTurns.value[0]?.durationMs || 1)
const health = computed(() => {
  if (errorCount.value) {
    return props.run?.root?.finalText
      ? { class: 'warning', label: `${errorCount.value} recovered ${errorCount.value === 1 ? 'error' : 'errors'}` }
      : { class: 'failed', label: `${errorCount.value} ${errorCount.value === 1 ? 'error' : 'errors'}` }
  }
  if (warningCount.value) return { class: 'warning', label: `${warningCount.value} ${warningCount.value === 1 ? 'warning' : 'warnings'}` }
  return { class: 'healthy', label: 'No incidents' }
})

function incidentIcon(incident: DiagnosticIncident): string {
  if (incident.category === 'permission') return 'i-lucide-shield-alert'
  if (incident.category === 'timeout') return 'i-lucide-timer-off'
  if (incident.category === 'hook') return 'i-lucide-unplug'
  if (incident.category === 'interruption') return 'i-lucide-circle-stop'
  if (incident.category === 'truncation') return 'i-lucide-file-warning'
  if (incident.category === 'agent') return 'i-lucide-bot-off'
  return incident.severity === 'error' ? 'i-lucide-circle-x' : 'i-lucide-triangle-alert'
}

function turnWidth(turn: TurnTiming): string {
  return `${Math.max((turn.durationMs / longestTurn.value) * 100, 2)}%`
}
</script>

<template>
  <div class="diagnostics-view">
    <div v-if="!run" class="empty-state">
      <span class="empty-state-icon"><UIcon name="i-lucide-stethoscope" /></span>
      <h2>No diagnostics to show</h2>
      <p>Select a session to inspect failures, timing, context pressure, and causality.</p>
    </div>

    <template v-else>
      <section class="diagnostics-intro">
        <div>
          <span class="section-eyebrow">Session diagnostics</span>
          <h2>Why the session behaved this way</h2>
          <p>Native provider events, timing, context usage, and causal signals across the full agent tree.</p>
        </div>
        <span class="diagnostic-health" :class="health.class">
          <UIcon :name="errorCount ? 'i-lucide-circle-alert' : warningCount ? 'i-lucide-triangle-alert' : 'i-lucide-circle-check'" />
          {{ health.label }}
        </span>
      </section>

      <section class="diagnostic-totals">
        <div class="diagnostic-total" :class="{ danger: errorCount }">
          <UIcon name="i-lucide-circle-alert" />
          <span><strong>{{ errorCount }}</strong><small>Errors</small></span>
        </div>
        <div class="diagnostic-total" :class="{ warning: warningCount }">
          <UIcon name="i-lucide-triangle-alert" />
          <span><strong>{{ warningCount }}</strong><small>Warnings</small></span>
        </div>
        <div class="diagnostic-total">
          <UIcon name="i-lucide-timer" />
          <span><strong>{{ formatMilliseconds(totalTurnMs) }}</strong><small>Measured turn time</small></span>
        </div>
        <div class="diagnostic-total">
          <UIcon name="i-lucide-brain-circuit" />
          <span><strong>{{ formatCount(run.diagnostics.usage.cr) }}</strong><small>Cache tokens read</small></span>
        </div>
        <div class="diagnostic-total">
          <UIcon name="i-lucide-shrink" />
          <span><strong>{{ run.diagnostics.compactions.length }}</strong><small>Compactions</small></span>
        </div>
      </section>

      <div class="diagnostic-columns">
        <section class="content-section incident-section">
          <div class="section-heading">
            <div>
              <h3>Incidents</h3>
              <p>Provider and parser incident signals across the whole session</p>
            </div>
            <span class="section-count">{{ incidents.length }}</span>
          </div>
          <div v-if="incidents.length" class="incident-list">
            <button
              v-for="incident in incidents"
              :key="incident.id"
              type="button"
              class="incident-row"
              :class="[incident.severity, { selected: incident.key === selectedKey }]"
              :disabled="!incident.key"
              :aria-current="incident.key && incident.key === selectedKey ? 'true' : undefined"
              @click="incident.key && emit('select', incident.key)"
            >
              <span class="incident-icon"><UIcon :name="incidentIcon(incident)" /></span>
              <span class="incident-copy">
                <strong>{{ incident.title }}</strong>
                <small>{{ incident.detail || incident.category }}</small>
                <span>{{ incident.who }}<template v-if="incident.tool"> · {{ incident.tool }}</template></span>
              </span>
              <time>{{ formatTime(incident.ts, false) }}</time>
            </button>
          </div>
          <p v-else class="empty-note success-note"><UIcon name="i-lucide-circle-check" /> No explicit incidents were recorded.</p>
        </section>

        <section class="content-section timing-section">
          <div class="section-heading">
            <div>
              <h3>Slowest turns</h3>
              <p>Native turn-duration measurements when recorded by the provider</p>
            </div>
            <span class="section-count">{{ run.diagnostics.turns.length }}</span>
          </div>
          <div v-if="slowTurns.length" class="turn-list">
            <button
              v-for="(turn, index) in slowTurns"
              :key="`${turn.key}-${turn.ts}-${index}`"
              type="button"
              class="turn-row"
              :class="{ selected: turn.key === selectedKey }"
              :aria-current="turn.key && turn.key === selectedKey ? 'true' : undefined"
              @click="turn.key && emit('select', turn.key)"
            >
              <span class="turn-copy">
                <strong>{{ turn.who }}</strong>
                <small>{{ turn.messageCount }} messages<template v-if="turn.pendingAgents"> · {{ turn.pendingAgents }} pending agents</template></small>
              </span>
              <span class="turn-track"><span :style="{ width: turnWidth(turn) }" /></span>
              <strong class="turn-duration">{{ formatMilliseconds(turn.durationMs) }}</strong>
            </button>
          </div>
          <p v-else class="empty-note">This session did not emit turn timing records.</p>
        </section>
      </div>

      <section class="content-section context-section">
        <div class="section-heading">
          <div>
            <h3>Context and causal load</h3>
            <p>Token traffic, models, compactions, and sidechain activity by agent</p>
          </div>
          <div class="context-totals">
            <span>{{ formatCount(run.diagnostics.usage.in) }} input</span>
            <span>{{ formatCount(run.diagnostics.usage.out) }} output</span>
            <span>{{ formatCount(run.diagnostics.usage.cw) }} cache written</span>
          </div>
        </div>
        <div class="context-table">
          <button
            v-for="agent in run.diagnostics.agents"
            :key="agent.key"
            type="button"
            class="context-row"
            :class="{ selected: agent.key === selectedKey }"
            :aria-current="agent.key === selectedKey ? 'true' : undefined"
            @click="emit('select', agent.key)"
          >
            <span class="context-agent">
              <strong>{{ agent.label }}</strong>
              <small>{{ agent.models.join(', ') || agent.agentType }}<template v-if="agent.efforts.length"> · {{ agent.efforts.join(', ') }} effort</template></small>
            </span>
            <span><strong>{{ formatCount(agent.usage.out) }}</strong><small>output</small></span>
            <span><strong>{{ formatCount(agent.usage.cr) }}</strong><small>cache read</small></span>
            <span><strong>{{ formatMilliseconds(agent.turnDurationMs) }}</strong><small>turn time</small></span>
            <span><strong>{{ agent.branchPoints }}</strong><small>branches</small></span>
            <span><strong>{{ formatCount(agent.sidechainRecords) }}</strong><small>sidechain</small></span>
          </button>
        </div>
      </section>

      <div class="diagnostic-columns lower">
        <section class="content-section receipt-section">
          <div class="section-heading">
            <div><h3>Agent receipts</h3><p>Native model, duration, token, and tool totals</p></div>
            <span class="section-count">{{ run.diagnostics.outcomes.length }}</span>
          </div>
          <div v-if="run.diagnostics.outcomes.length" class="receipt-list">
            <button
              v-for="outcome in [...run.diagnostics.outcomes].reverse()"
              :key="`${outcome.toolUseId}-${outcome.ts}`"
              type="button"
              class="receipt-row"
              :disabled="!outcome.childKey"
              @click="outcome.childKey && emit('select', outcome.childKey)"
            >
              <span class="agent-avatar"><UIcon name="i-lucide-bot" /></span>
              <span><strong>{{ outcome.label || 'Delegated agent' }}</strong><small>{{ outcome.model || outcome.status }}</small></span>
              <span><strong>{{ outcome.durationMs ? formatMilliseconds(outcome.durationMs) : outcome.status.replace(/_/g, ' ') }}</strong><small>{{ outcome.durationMs ? 'duration' : 'state' }}</small></span>
              <span><strong>{{ outcome.totalTokens ? formatCount(outcome.totalTokens) : '—' }}</strong><small>tokens</small></span>
              <span><strong>{{ outcome.totalToolUseCount || '—' }}</strong><small>tools</small></span>
            </button>
          </div>
          <p v-else class="empty-note">No completed agent receipts were recorded.</p>
        </section>

        <section class="content-section environment-section">
          <div class="section-heading"><div><h3>Reproduction context</h3><p>Environment recorded by the session provider</p></div></div>
          <div class="environment-list">
            <div><span>Version</span><strong>{{ run.diagnostics.environment.version || 'Unknown' }}</strong></div>
            <div><span>Entrypoint</span><strong>{{ run.diagnostics.environment.entrypoint || 'Unknown' }}</strong></div>
            <div><span>Permission mode</span><strong>{{ run.diagnostics.environment.permissionMode || 'Unknown' }}</strong></div>
            <div><span>Git branch</span><strong :title="run.diagnostics.environment.gitBranch">{{ run.diagnostics.environment.gitBranch || 'Unknown' }}</strong></div>
            <div><span>Working directory</span><strong :title="run.diagnostics.environment.cwd">{{ run.diagnostics.environment.cwd || 'Unknown' }}</strong></div>
            <div><span>UUID coverage</span><strong>{{ formatCount(run.diagnostics.causal.recordsWithUuid) }} / {{ formatCount(run.diagnostics.causal.records) }}</strong></div>
          </div>
        </section>
      </div>

      <section v-if="run.diagnostics.compactions.length" class="content-section compaction-section">
        <div class="section-heading"><div><h3>Compaction boundaries</h3><p>Context reduction events that can change later model behavior</p></div></div>
        <div class="compaction-list">
          <button
            v-for="(event, index) in run.diagnostics.compactions"
            :key="`${event.key}-${event.ts}-${index}`"
            type="button"
            @click="event.key && emit('select', event.key)"
          >
            <UIcon name="i-lucide-shrink" />
            <span><strong>{{ event.who }}</strong><small>{{ event.trigger || 'automatic' }} · {{ formatTime(event.ts) }}</small></span>
            <span><strong>{{ formatCount(event.preTokens) }} → {{ formatCount(event.postTokens) }}</strong><small>{{ formatCount(event.droppedTokens) }} cumulatively dropped</small></span>
            <span><strong>{{ event.preservedMessages }}</strong><small>messages preserved</small></span>
            <span><strong>{{ formatMilliseconds(event.durationMs) }}</strong><small>duration</small></span>
          </button>
        </div>
      </section>
    </template>
  </div>
</template>
