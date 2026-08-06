<script setup lang="ts">
import type { ParseIssueReason } from '#shared/types/run'
import type {
  ParseIssueWire,
  SessionParseHealthWire,
  SessionSourceWire,
} from '#shared/schemas/api'
import { useAtomSet, useAtomValue } from '@effect/atom-vue'
import { parseHealthAtoms, parseHealthKey } from '~/atoms/parse-health'
import { normalizeHours, RANGE_OPTIONS } from '~/utils/range'

const route = useRoute()
const router = useRouter()
const clipboard = useClipboard({ legacy: true })
const toast = useToast()
useHead({ title: 'Debug — liveclaudecode' })

const hours = ref(normalizeHours(route.query.hours))
const expanded = ref(new Set<string>())
const rangeOptions = RANGE_OPTIONS
const sourceIcon: Record<SessionSourceWire, string> = {
  claude: 'i-lucide-sparkles',
  codex: 'i-lucide-square-terminal',
  copilot: 'i-lucide-github',
}

/**
 * What each cause means and who can act on it. An unreadable line is the
 * user's file; a shape we cannot model is our schema.
 */
const reasonMeta: Record<ParseIssueReason, {
  label: string
  icon: string
  tone: 'data' | 'schema'
  explanation: string
}> = {
  'invalid-json': {
    label: 'Not valid JSON',
    icon: 'i-lucide-file-x',
    tone: 'data',
    explanation: 'The line was truncated or corrupt. A session still being written usually resolves itself on the next refresh; anything older points at a damaged transcript file.',
  },
  'schema-mismatch': {
    label: 'Unexpected shape',
    icon: 'i-lucide-file-question',
    tone: 'schema',
    explanation: 'The record is valid JSON of a kind liveclaudecode knows, but a field was missing or had the wrong type. This normally means the provider changed its format and liveclaudecode has not caught up — worth reporting.',
  },
  'unsupported-shape': {
    label: 'Cannot be applied',
    icon: 'i-lucide-file-warning',
    tone: 'schema',
    explanation: 'The record itself decoded, but part of it — a tool call\'s arguments or output, say — was in a form liveclaudecode could not apply. Counts for the session may be low.',
  },
}

// The thunk depends on `hours`, so changing the range swaps which atom this
// page is subscribed to. Both bindings must run during setup() —
// `injectRegistry` falls back to a module singleton rather than throwing.
const result = useAtomValue(() => parseHealthAtoms.parseHealth(parseHealthKey(hours.value)))
const pulse = useAtomSet(() => parseHealthAtoms.refresh)

// One string discriminant for the template: `result` is stream-backed, so it is
// permanently `waiting` and neither `matchWithWaiting` nor `result.waiting`
// can decide anything.
const view = computed(() => toFeedView(result.value))
const data = computed(() =>
  view.value.tag === 'ready' || view.value.tag === 'stale' ? view.value.value : null,
)
const loading = computed(() => view.value.tag === 'loading')

watch(hours, (value) => {
  void router.replace({ query: { ...route.query, hours: String(value) } })
})

// A stream atom cannot say whether a request is in flight, so the button owns
// that: busy on click, cleared by the next value the feed publishes.
const refreshing = ref(false)
watch(result, () => {
  refreshing.value = false
})
function refresh(): void {
  refreshing.value = true
  pulse()
}
const sessions = computed(() => data.value?.sessions || [])
const unavailable = computed(() => (data.value?.sources || []).filter(source => source.state === 'unavailable'))
const totals = computed(() => {
  const counts = { invalidJson: 0, schemaMismatch: 0, unsupportedShape: 0 }
  for (const session of sessions.value) {
    counts.invalidJson += session.counts.invalidJson
    counts.schemaMismatch += session.counts.schemaMismatch
    counts.unsupportedShape += session.counts.unsupportedShape
  }
  return counts
})
const schemaTotal = computed(() => totals.value.schemaMismatch + totals.value.unsupportedShape)

/** The reasons actually present, so the legend never explains an absent cause. */
const activeReasons = computed<ParseIssueReason[]>(() => {
  const present = new Set<ParseIssueReason>()
  for (const session of sessions.value) {
    if (session.counts.invalidJson) present.add('invalid-json')
    if (session.counts.schemaMismatch) present.add('schema-mismatch')
    if (session.counts.unsupportedShape) present.add('unsupported-shape')
  }
  return [...present]
})

function sessionId(session: SessionParseHealthWire): string {
  return `${session.projectId}/${session.key}`
}

function isExpanded(session: SessionParseHealthWire): boolean {
  return expanded.value.has(sessionId(session))
}

function toggle(session: SessionParseHealthWire): void {
  const next = new Set(expanded.value)
  const id = sessionId(session)
  if (!next.delete(id)) next.add(id)
  expanded.value = next
}

function breakdown(session: SessionParseHealthWire): Array<{ reason: ParseIssueReason, count: number }> {
  return ([
    { reason: 'invalid-json', count: session.counts.invalidJson },
    { reason: 'schema-mismatch', count: session.counts.schemaMismatch },
    { reason: 'unsupported-shape', count: session.counts.unsupportedShape },
  ] as const).filter(entry => entry.count > 0).map(entry => ({ ...entry }))
}

/** Transcripts are addressed by `file:line`, one-based as an editor shows them. */
function location(session: SessionParseHealthWire, issue: ParseIssueWire): string {
  return `${session.transcriptPath}:${issue.line + 1}`
}

async function copy(text: string, label: string): Promise<void> {
  try {
    await clipboard.copy(text)
    toast.add({ title: `${label} copied`, icon: 'i-lucide-check', color: 'success' })
  } catch {
    toast.add({ title: `Could not copy ${label.toLowerCase()}`, icon: 'i-lucide-copy-x', color: 'error' })
  }
}
</script>

<template>
  <div class="debug-page">
    <header class="debug-appbar">
      <NuxtLink to="/" class="debug-brand"><span><UIcon name="i-lucide-terminal" /></span><strong>liveclaudecode</strong></NuxtLink>
      <nav aria-label="Workspace">
        <NuxtLink to="/">Sessions</NuxtLink>
        <NuxtLink to="/costs">Costs</NuxtLink>
        <NuxtLink to="/debug" class="active">Debug</NuxtLink>
      </nav>
      <div>
        <span class="local-state"><i />Local transcripts</span>
        <UButton color="neutral" variant="ghost" icon="i-lucide-refresh-cw" aria-label="Refresh parse health" :loading="loading || refreshing" @click="refresh()" />
      </div>
    </header>

    <main class="debug-main">
      <section class="debug-intro">
        <div>
          <span class="eyebrow">PARSE HEALTH</span>
          <h1 data-workspace-heading tabindex="-1">What liveclaudecode could not read.</h1>
          <p>Every record skipped while scanning local transcripts, with the file, the line, and the reason.</p>
        </div>
        <USelect v-model="hours" :items="rangeOptions" value-key="value" label-key="label" aria-label="Debug date range" />
      </section>

      <UAlert v-if="view.tag === 'error'" class="state-alert" color="error" variant="soft" icon="i-lucide-cloud-off" title="Could not read parse health" :description="`${view.message}. ${view.remedy}`" />
      <UAlert v-else-if="view.tag === 'stale'" class="state-alert" color="warning" variant="soft" icon="i-lucide-cloud-off" title="Showing the last parse health read" :description="`${view.message}. ${view.remedy}`" />
      <UAlert
        v-for="source in unavailable"
        :key="source.source"
        class="state-alert"
        color="warning"
        variant="soft"
        icon="i-lucide-plug-zap"
        :title="`${sessionSourceLabel(source.source)} storage unavailable`"
        :description="source.message"
      />

      <section v-if="loading && !data" class="summary-grid" aria-label="Loading parse health">
        <USkeleton v-for="index in 3" :key="index" class="h-24 rounded-xl" />
      </section>

      <template v-else-if="data">
        <section class="summary-grid" aria-label="Parse health summary">
          <article class="summary-total">
            <span>Records skipped</span>
            <strong>{{ data.skipped }}</strong>
            <small>Across {{ sessions.length }} session{{ sessions.length === 1 ? '' : 's' }}</small>
          </article>
          <article>
            <span>Unreadable lines</span>
            <strong>{{ totals.invalidJson }}</strong>
            <small>Truncated or corrupt transcript text</small>
          </article>
          <article>
            <span>Shapes we do not model</span>
            <strong>{{ schemaTotal }}</strong>
            <small>Likely a liveclaudecode schema gap</small>
          </article>
        </section>

        <UEmpty
          v-if="!sessions.length"
          class="empty-sessions"
          icon="i-lucide-circle-check"
          title="Every record parsed cleanly"
          description="No session in this range skipped a record. Widen the range to check older sessions."
        />

        <template v-else>
          <ul class="reason-legend">
            <li v-for="reason in activeReasons" :key="reason" :class="reasonMeta[reason].tone">
              <UIcon :name="reasonMeta[reason].icon" />
              <span><strong>{{ reasonMeta[reason].label }}</strong><small>{{ reasonMeta[reason].explanation }}</small></span>
            </li>
          </ul>

          <section class="session-section" aria-labelledby="debug-sessions-heading">
            <header>
              <div><span class="section-kicker">SESSIONS</span><h2 id="debug-sessions-heading">Where the records were skipped</h2></div>
              <small>Showing up to {{ data.sampleLimit }} examples per session</small>
            </header>

            <ul class="session-list">
              <li v-for="session in sessions" :key="sessionId(session)" class="session-card">
                <button type="button" class="session-head" :aria-expanded="isExpanded(session)" @click="toggle(session)">
                  <i class="session-source"><UIcon :name="sourceIcon[session.source]" /></i>
                  <span class="session-name">
                    <strong>{{ session.label || session.key }}</strong>
                    <small>{{ session.sourceDetail || sessionSourceLabel(session.source) }} · {{ session.projectName }}</small>
                  </span>
                  <span class="session-tags">
                    <b v-for="entry in breakdown(session)" :key="entry.reason" :class="reasonMeta[entry.reason].tone">
                      {{ entry.count }} {{ reasonMeta[entry.reason].label.toLowerCase() }}
                    </b>
                  </span>
                  <strong class="session-count">{{ session.skipped }}</strong>
                  <UIcon class="session-chevron" :name="isExpanded(session) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" />
                </button>

                <div v-if="isExpanded(session)" class="session-body">
                  <p class="transcript-path">
                    <UIcon name="i-lucide-file-code" />
                    <code>{{ session.transcriptPath }}</code>
                    <UButton color="neutral" variant="ghost" size="xs" icon="i-lucide-copy" aria-label="Copy transcript path" @click="copy(session.transcriptPath, 'Transcript path')" />
                  </p>

                  <ol class="issue-list">
                    <li v-for="(issue, index) in session.samples" :key="`${issue.line}-${index}`" :class="reasonMeta[issue.reason].tone">
                      <span class="issue-head">
                        <UIcon :name="reasonMeta[issue.reason].icon" />
                        <b>{{ reasonMeta[issue.reason].label }}</b>
                        <em v-if="issue.recordType">{{ issue.recordType }}</em>
                        <button type="button" class="issue-location" @click="copy(location(session, issue), 'Location')">
                          line {{ issue.line + 1 }}<UIcon name="i-lucide-copy" />
                        </button>
                      </span>
                      <p class="issue-detail">{{ issue.detail }}</p>
                      <CodeBlock class="issue-excerpt" :code="issue.excerpt" language="json" />
                    </li>
                  </ol>

                  <p v-if="session.skipped > session.samples.length" class="issue-more">
                    {{ session.skipped - session.samples.length }} further skipped record{{ session.skipped - session.samples.length === 1 ? '' : 's' }} not sampled.
                  </p>
                </div>
              </li>
            </ul>
          </section>
        </template>
      </template>
    </main>
  </div>
</template>

<style scoped>
.debug-page { height: 100%; overflow: auto; background: light-dark(#f6f7f9, #0d0f12); color: var(--text-primary); }
.debug-appbar { position: sticky; z-index: 5; top: 0; display: grid; min-height: 58px; grid-template-columns: 1fr auto 1fr; align-items: center; padding: 0 28px; border-bottom: 1px solid var(--line-soft); background: color-mix(in srgb, var(--surface) 94%, transparent); backdrop-filter: blur(16px); }
.debug-brand { display: flex; align-items: center; gap: 9px; color: var(--text-primary); text-decoration: none; }.debug-brand > span { display: grid; width: 28px; height: 28px; place-items: center; border-radius: 8px; background: var(--accent); color: white; }.debug-brand svg { width: 13px; }.debug-brand strong { font-size: 12px; }
.debug-appbar nav { display: flex; height: 58px; align-items: stretch; gap: 24px; }.debug-appbar nav a { position: relative; display: flex; align-items: center; color: var(--text-tertiary); font-size: 11px; text-decoration: none; }.debug-appbar nav a.active { color: var(--text-primary); }.debug-appbar nav a.active::after { position: absolute; right: 0; bottom: 0; left: 0; height: 2px; background: var(--accent); content: ''; }.debug-appbar > div { display: flex; align-items: center; justify-content: flex-end; gap: 10px; }.local-state { display: inline-flex; align-items: center; gap: 6px; color: var(--text-tertiary); font-size: 9px; }.local-state i { width: 6px; height: 6px; border-radius: 50%; background: var(--live); box-shadow: 0 0 0 3px var(--live-soft); }
.debug-main { width: min(1180px, 100%); margin: auto; padding: 34px clamp(18px, 4vw, 54px) 88px; }
.debug-intro { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; margin-bottom: 22px; }.eyebrow,.section-kicker { color: var(--accent); font: 700 8.5px var(--mono); letter-spacing: .14em; }.debug-intro h1 { margin: 7px 0 4px; font-size: clamp(25px, 3vw, 37px); letter-spacing: -.05em; line-height: 1.05; }.debug-intro p { margin: 0; color: var(--text-tertiary); font-size: 11px; }.debug-intro :deep(.relative) { min-width: 142px; }
.state-alert { margin-bottom: 14px; }.state-alert :deep([data-slot="title"]) { color: var(--text-secondary); }
.summary-grid { display: grid; grid-template-columns: 1.1fr 1fr 1fr; gap: 8px; margin-bottom: 20px; }.summary-grid article { min-width: 0; padding: 13px 14px; border: 1px solid var(--line-soft); border-radius: 11px; background: var(--surface); }.summary-grid article > span { color: var(--text-tertiary); font-size: 8.5px; }.summary-grid article > strong { display: block; margin: 6px 0 2px; font: 650 22px var(--mono); letter-spacing: -.04em; }.summary-grid article > small { color: var(--text-tertiary); font-size: 8px; }
.empty-sessions { border: 1px solid var(--line-soft); border-radius: 12px; background: var(--surface); }
.reason-legend { display: grid; margin: 0 0 22px; padding: 0; gap: 6px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); list-style: none; }.reason-legend li { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 9px; padding: 11px 12px; border: 1px solid var(--line-soft); border-left: 3px solid var(--line); border-radius: 10px; background: var(--surface); }.reason-legend li.data { border-left-color: var(--warning); }.reason-legend li.schema { border-left-color: var(--accent); }.reason-legend svg { width: 14px; color: var(--text-tertiary); }.reason-legend span { display: flex; min-width: 0; flex-direction: column; }.reason-legend strong { font-size: 9.5px; }.reason-legend small { margin-top: 3px; color: var(--text-tertiary); font-size: 8.5px; line-height: 1.5; }
.session-section > header { display: flex; align-items: flex-end; justify-content: space-between; gap: 18px; margin-bottom: 10px; }.session-section h2 { margin: 3px 0 0; font-size: 15px; }.session-section > header small { color: var(--text-tertiary); font-size: 8px; }
.session-list { display: grid; margin: 0; padding: 0; gap: 6px; list-style: none; }.session-card { overflow: hidden; border: 1px solid var(--line-soft); border-radius: 12px; background: var(--surface); }
.session-head { display: grid; width: 100%; min-height: 56px; grid-template-columns: 30px minmax(0, 1.4fr) minmax(0, 1fr) auto 14px; align-items: center; gap: 10px; padding: 9px 13px; border: 0; background: transparent; color: var(--text-primary); cursor: pointer; text-align: left; }.session-head:hover { background: var(--surface-hover); }
.session-source { display: grid; width: 29px; height: 29px; place-items: center; border-radius: 9px; background: var(--surface-raised); color: var(--text-secondary); }.session-source svg { width: 13px; }
.session-name { display: flex; min-width: 0; flex-direction: column; }.session-name strong { overflow: hidden; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }.session-name small { margin-top: 2px; overflow: hidden; color: var(--text-tertiary); font-size: 7.5px; text-overflow: ellipsis; white-space: nowrap; }
.session-tags { display: flex; min-width: 0; flex-wrap: wrap; gap: 4px; }.session-tags b { padding: 3px 7px; border-radius: 999px; background: var(--surface-raised); color: var(--text-secondary); font: 600 7px var(--mono); white-space: nowrap; }.session-tags b.data { background: color-mix(in srgb, var(--warning) 14%, transparent); }.session-tags b.schema { background: color-mix(in srgb, var(--accent) 14%, transparent); }
.session-count { font: 650 15px var(--mono); }.session-chevron { width: 13px; color: var(--text-tertiary); }
.session-body { padding: 0 13px 13px; border-top: 1px solid var(--line-soft); }
.transcript-path { display: flex; align-items: center; gap: 7px; margin: 11px 0; color: var(--text-tertiary); }.transcript-path svg { width: 12px; flex: none; }.transcript-path code { overflow-x: auto; font: 8.5px var(--mono); white-space: nowrap; }
.issue-list { display: grid; margin: 0; padding: 0; gap: 6px; list-style: none; }.issue-list li { padding: 10px 11px; border: 1px solid var(--line-soft); border-left: 3px solid var(--line); border-radius: 9px; background: var(--surface-raised); }.issue-list li.data { border-left-color: var(--warning); }.issue-list li.schema { border-left-color: var(--accent); }
.issue-head { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }.issue-head svg { width: 12px; color: var(--text-tertiary); }.issue-head b { font-size: 8.5px; }.issue-head em { padding: 2px 6px; border-radius: 999px; background: var(--surface-hover); color: var(--text-secondary); font: 7px var(--mono); font-style: normal; }
.issue-location { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; padding: 2px 6px; border: 1px solid var(--line-soft); border-radius: 6px; background: transparent; color: var(--text-tertiary); font: 7.5px var(--mono); cursor: pointer; }.issue-location:hover { color: var(--text-secondary); }.issue-location svg { width: 9px; }
.issue-detail { margin: 7px 0 0; color: var(--text-secondary); font-size: 9px; line-height: 1.5; }
.issue-excerpt { margin: 7px 0 0; }
.issue-excerpt :deep(pre.shiki), .issue-excerpt :deep(.code-block-plain) { max-height: 180px; font-size: 9px; line-height: 1.55; }
.issue-more { margin: 9px 0 0; color: var(--text-tertiary); font-size: 8px; }
@media (max-width: 900px) { .summary-grid { grid-template-columns: 1fr; }.session-head { grid-template-columns: 30px minmax(0, 1fr) auto 14px; }.session-tags { display: none; } }
@media (max-width: 760px) { .debug-appbar { grid-template-columns: 1fr auto; padding: 0 13px; }.debug-appbar nav,.local-state { display: none; }.debug-main { padding: 24px 12px 82px; }.debug-intro { align-items: flex-start; flex-direction: column; }.debug-intro :deep(.relative) { width: 100%; } }
</style>
