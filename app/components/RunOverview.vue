<script setup lang="ts">
import type { RunResponse, TimelineLane } from '#shared/types/run'

const props = defineProps<{
  run: RunResponse | null
  selectedKey: string | null
}>()

const emit = defineEmits<{ select: [key: string] }>()

const timeline = computed(() => {
  const lanes = props.run?.lanes || []
  const values = lanes.flatMap(lane => [
    lane.firstTs ? new Date(lane.firstTs).getTime() : 0,
    lane.lastTs ? new Date(lane.lastTs).getTime() : 0,
  ]).filter(Boolean)
  const start = values.length ? Math.min(...values) : 0
  const end = values.length ? Math.max(...values) : 0
  return { lanes, start, end, span: Math.max(end - start, 1_000) }
})

function laneStyle(lane: TimelineLane): { left: string, width: string } {
  const start = lane.firstTs ? new Date(lane.firstTs).getTime() : timeline.value.start
  const end = lane.lastTs ? new Date(lane.lastTs).getTime() : start
  return {
    left: `${((start - timeline.value.start) / timeline.value.span) * 100}%`,
    width: `${Math.max(((end - start) / timeline.value.span) * 100, 0.8)}%`,
  }
}

const completedTodos = computed(() =>
  props.run?.node.todos?.filter(todo => todo.status === 'completed').length || 0,
)

const currentPhase = computed(() => props.run?.phases.at(-1) || null)
</script>

<template>
  <div class="guide-view">
    <div v-if="!run" class="empty-state">
      <span class="empty-state-icon"><UIcon name="i-lucide-map" /></span>
      <h2>No session selected</h2>
      <p>Choose a session to see its execution map and plan.</p>
    </div>

    <template v-else>
      <section class="guide-intro">
        <span class="section-eyebrow">Session guide</span>
        <h2>How the work unfolded</h2>
        <p>
          A structured view of the agents, phases, and plan behind this session.
          Select an agent to inspect its individual activity.
        </p>
      </section>

      <section class="content-section execution-section">
        <div class="section-heading">
          <div>
            <h3>Execution map</h3>
            <p>{{ run.lanes.length }} {{ run.lanes.length === 1 ? 'agent' : 'agents' }} across {{ formatDuration(
              timeline.start ? new Date(timeline.start).toISOString() : null,
              timeline.end ? new Date(timeline.end).toISOString() : null,
            ) }}</p>
          </div>
          <span v-if="run.root.subLive" class="inline-status"><span class="status-dot running" /> Live</span>
        </div>

        <div class="timeline-ruler" aria-hidden="true">
          <span>Start</span><span>Session timeline</span><span>Now</span>
        </div>
        <div class="timeline-list">
          <button
            v-for="lane in timeline.lanes"
            :key="lane.key"
            class="lane"
            :class="{ selected: lane.key === selectedKey }"
            type="button"
            @click="emit('select', lane.key)"
          >
            <span class="lane-identity" :style="{ paddingLeft: `${lane.depth * 18}px` }">
              <span class="lane-icon" :class="{ live: lane.live, error: lane.errors }">
                <UIcon :name="lane.depth ? 'i-lucide-bot' : 'i-lucide-message-square-code'" />
              </span>
              <span class="lane-copy">
                <strong :title="lane.label">{{ lane.label.slice(0, 48) }}</strong>
                <small>{{ lane.agentType || 'Main session' }} · {{ lane.tools }} tools</small>
              </span>
            </span>
            <span class="lane-track">
              <span
                class="lane-bar"
                :class="{ live: lane.live, error: lane.errors, root: lane.depth === 0 && !lane.live && !lane.errors }"
                :style="laneStyle(lane)"
              />
            </span>
            <span class="lane-duration">{{ formatDuration(lane.firstTs, lane.lastTs) }}</span>
          </button>
        </div>
      </section>

      <div class="guide-columns">
        <section class="content-section plan-card">
          <div class="section-heading">
            <div>
              <h3>Plan</h3>
              <p v-if="run.node.todos?.length">{{ completedTodos }} of {{ run.node.todos.length }} complete</p>
              <p v-else>No structured plan detected</p>
            </div>
            <span v-if="run.node.todos?.length" class="plan-count">{{ completedTodos }}/{{ run.node.todos.length }}</span>
          </div>
          <div v-if="run.node.todos?.length" class="todo-list">
            <div v-for="(todo, index) in run.node.todos" :key="index" class="todo" :class="todo.status">
              <span class="todo-state">
                <UIcon :name="todo.status === 'completed' ? 'i-lucide-check' : todo.status === 'in_progress' ? 'i-lucide-loader-circle' : 'i-lucide-circle'" />
              </span>
              <span>{{ todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content }}</span>
            </div>
          </div>
          <p v-else class="empty-note">The provider has not emitted a todo list for this session.</p>
        </section>

        <section class="content-section phase-card">
          <div class="section-heading">
            <div>
              <h3>Phases</h3>
              <p>{{ currentPhase ? `Current: ${currentPhase.title}` : 'No phase announcements' }}</p>
            </div>
          </div>
          <div v-if="run.phases.length" class="phase-list">
            <div
              v-for="(phase, index) in run.phases"
              :key="`${phase.ts}-${phase.title}`"
              class="phase-row"
              :class="{ current: index === run.phases.length - 1 }"
            >
              <span class="phase-marker" />
              <div>
                <strong>{{ phase.title }}</strong>
                <small>{{ phase.who || 'main' }} · {{ formatTime(phase.ts, false) }}</small>
              </div>
            </div>
          </div>
          <p v-else class="empty-note">Phases will appear when the assistant announces meaningful work stages.</p>
        </section>
      </div>

      <section v-if="run.node.finalText" class="content-section outcome-section">
        <div class="section-heading">
          <div>
            <h3>Latest outcome</h3>
            <p>The selected agent’s most recent conclusion</p>
          </div>
          <UIcon name="i-lucide-sparkles" />
        </div>
        <p class="outcome-copy">{{ run.node.finalText }}</p>
      </section>
    </template>
  </div>
</template>
