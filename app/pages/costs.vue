<script setup lang="ts">
import { useAtomSet, useAtomValue } from '@effect/atom-vue'
import type { CostOverviewGroupWire, SessionSourceWire } from '#shared/schemas/api'
import { costsAtoms, costsKey } from '~/atoms/costs'
import ChartLine from '~/components/charts/LineChart.vue'
import ChartSparkline from '~/components/charts/Sparkline.vue'
import type { ChartCategory, ChartDatum } from '~/components/charts/chart'

type HarnessFilter = 'all' | SessionSourceWire

const route = useRoute()
const router = useRouter()
useHead({ title: 'Costs — liveclaudecode' })
const selectedHarness = ref<HarnessFilter>('all')
const hours = ref(normalizeHours(route.query.hours))
const rangeOptions = [
  { label: 'Last 24 hours', value: 24 },
  { label: 'Last 7 days', value: 168 },
  { label: 'Last 30 days', value: 720 },
  { label: 'All time', value: 0 },
]
const sourceMeta: Record<SessionSourceWire, { icon: string, color: string }> = {
  claude: { icon: 'i-lucide-sparkles', color: '#d9915b' },
  codex: { icon: 'i-lucide-square-terminal', color: '#65b89a' },
  copilot: { icon: 'i-lucide-github', color: '#6f9de8' },
}

// The thunk depends on `hours`, so changing the range swaps which atom this page
// is subscribed to; the family memoises structurally, so the same range always
// resolves to the same atom. Both bindings must run during setup() —
// `injectRegistry` falls back to a module singleton rather than throwing.
const result = useAtomValue(() => costsAtoms.costs(costsKey(hours.value)))
// A pulse into the running feed, not `registry.refresh`: refreshing a stream
// atom rebuilds it, which would throw away the data already on screen.
const pulse = useAtomSet(() => costsAtoms.refresh)

// One string discriminant for the template. `result` is stream-backed, so it is
// permanently `waiting` and neither `matchWithWaiting` nor `result.waiting` can
// be used to decide anything.
const view = computed(() => toFeedView(result.value))
const data = computed(() =>
  view.value.tag === 'ready' || view.value.tag === 'stale' ? view.value.value : null,
)

watch(hours, (value) => {
  void router.replace({ query: { ...route.query, hours: String(value) } })
})

// A stream atom's `waiting` flag is set on every chunk and never cleared, so the
// atom cannot say whether a request is in flight. The button owns that: it goes
// busy on click and clears on the next value the feed publishes, whether that
// value is fresh data or a failure.
const refreshing = ref(false)
watch(result, () => {
  refreshing.value = false
})
function refresh(): void {
  refreshing.value = true
  pulse()
}

// "Nothing on screen yet", which is what drives the skeletons — distinct from
// `refreshing`, which is a request over data that is already rendered.
const loading = computed(() => view.value.tag === 'loading')
const harnesses = computed(() => data.value?.harnesses || [])
const visibleModels = computed(() => (data.value?.models || []).filter(model =>
  selectedHarness.value === 'all' || model.source === selectedHarness.value,
))
const selectedLabel = computed(() => selectedHarness.value === 'all'
  ? 'All harnesses'
  : harnesses.value.find(item => item.source === selectedHarness.value)?.label || '',
)
const totalTokens = computed(() => usageTotal(data.value?.usage))
const cacheRate = computed(() => {
  const usage = data.value?.usage
  if (!usage) return 0
  const context = usage.in + usage.cr
  return context ? usage.cr / context * 100 : 0
})
const chartUsesCost = computed(() => visibleModels.value.some(model => model.pricedRequests > 0))
const chartModels = computed(() => chartUsesCost.value
  ? visibleModels.value.filter(model => model.pricedRequests > 0)
  : visibleModels.value,
)
const chartDates = computed(() => [...new Set(chartModels.value.flatMap(model => model.days.map(day => day.date)))].sort())
const chartCategories = computed<Record<string, ChartCategory>>(() => Object.fromEntries(
  chartModels.value.map((model, index) => [seriesKey(model), {
    name: `${model.label} · ${sessionSourceLabel(model.source)}`,
    color: modelColor(model, visibleModels.value, index),
  }]),
))
const chartData = computed<ChartDatum[]>(() => {
  const cumulative = new Map<string, number>()
  return chartDates.value.map((date) => ({
    label: formatDay(date),
    ...Object.fromEntries(chartModels.value.map((model) => {
      const day = model.days.find(item => item.date === date)
      const value = chartUsesCost.value
        ? day?.estimatedUsd || 0
        : usageTotal(day?.usage)
      const next = (cumulative.get(seriesKey(model)) || 0) + value
      cumulative.set(seriesKey(model), next)
      return [seriesKey(model), next]
    })),
  }))
})
const largestMetric = computed(() => Math.max(
  1,
  ...visibleModels.value.map(model => modelMetric(model, chartUsesCost.value)),
))
const degradedSources = computed(() => data.value?.sources.filter(source => source.state !== 'ready') || [])

function normalizeHours(value: unknown): number {
  const parsed = Number(Array.isArray(value) ? value[0] : value)
  return [0, 24, 168, 720].includes(parsed) ? parsed : 720
}

function formatDay(date: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${date}T00:00:00Z`))
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

function spendLabel(group: CostOverviewGroupWire): string {
  return group.estimatedUsd === null ? 'Rate unavailable' : formatUsd(group.estimatedUsd)
}

function selectHarness(source: HarnessFilter): void {
  selectedHarness.value = selectedHarness.value === source ? 'all' : source
}

function exportCsv(): void {
  if (!data.value || !import.meta.client) return
  const csv = serializeCostCsv(data.value.models)
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `liveclaudecode-costs-${hours.value || 'all'}.csv`
  link.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div class="cost-page">
    <header class="cost-appbar">
      <NuxtLink to="/" class="cost-brand"><span><UIcon name="i-lucide-terminal" /></span><strong>liveclaudecode</strong></NuxtLink>
      <nav aria-label="Workspace"><NuxtLink to="/">Sessions</NuxtLink><NuxtLink to="/costs" class="active">Costs</NuxtLink><NuxtLink to="/debug">Debug</NuxtLink></nav>
      <div><span class="local-state"><i />Local transcripts</span><UButton color="neutral" variant="ghost" icon="i-lucide-refresh-cw" aria-label="Refresh costs" :loading="loading || refreshing" @click="refresh()" /></div>
    </header>

    <main class="cost-main">
      <section class="cost-intro">
        <div><span class="eyebrow">COST OVERVIEW</span><h1>Spend, from harness to model.</h1><p>Estimated token cost and recorded usage from local coding-session transcripts.</p></div>
        <div class="cost-actions">
          <UButton color="neutral" variant="outline" icon="i-lucide-download" :disabled="!data?.models.length" @click="exportCsv">Export CSV</UButton>
          <USelect v-model="hours" :items="rangeOptions" value-key="value" label-key="label" aria-label="Cost date range" />
        </div>
      </section>

      <UAlert v-if="view.tag === 'error'" class="state-alert" color="error" variant="soft" icon="i-lucide-cloud-off" title="Could not read cost data" :description="`${view.message}. ${view.remedy}`" />
      <UAlert v-else-if="view.tag === 'stale'" class="state-alert" color="warning" variant="soft" icon="i-lucide-cloud-off" title="Showing the last cost data read" :description="`${view.message}. ${view.remedy}`" />
      <!-- Independent of the two above: partly-readable transcripts describe the
           data on screen, so a failed poll must not silently retract the notice. -->
      <UAlert v-if="degradedSources.length" class="state-alert" color="warning" variant="soft" icon="i-lucide-triangle-alert" title="Some transcript data was skipped" :description="degradedSources.map(source => `${sessionSourceLabel(source.source)}: ${source.message}`).join(' · ')" />

      <section v-if="loading" class="summary-grid" aria-label="Loading cost overview">
        <USkeleton v-for="index in 4" :key="index" class="h-24 rounded-xl" />
      </section>
      <template v-else-if="data">
        <section class="summary-grid" aria-label="Cost summary">
          <article class="summary-total"><span>Estimated token cost</span><strong>{{ formatUsd(data.estimatedUsd) }}</strong><small>{{ data.pricedRequests }} priced usage record{{ data.pricedRequests === 1 ? '' : 's' }}</small></article>
          <article><span>Sessions</span><strong>{{ data.sessions }}</strong><small>Across {{ data.harnesses.filter(item => item.sessions).length }} detected harnesses</small></article>
          <article><span>Recorded tokens</span><strong>{{ formatTokens(totalTokens) }}</strong><small>Input, output, and prompt caching</small></article>
          <article><span>Cache read share</span><strong>{{ cacheRate.toFixed(1) }}%</strong><small>{{ formatTokens(data.usage.cr) }} cache-read tokens</small></article>
        </section>

        <section class="harness-section">
          <header><div><span class="section-kicker">01 · HARNESS VIEW</span><h2>Where is usage happening?</h2></div><button v-if="selectedHarness !== 'all'" type="button" @click="selectHarness('all')">Reset to all</button></header>
          <div class="harness-grid">
            <button
              v-for="harness in harnesses"
              :key="harness.source"
              class="harness-card"
              :class="{ active: selectedHarness === harness.source, muted: selectedHarness !== 'all' && selectedHarness !== harness.source }"
              :style="{ '--harness': sourceMeta[harness.source].color }"
              :aria-pressed="selectedHarness === harness.source"
              @click="selectHarness(harness.source)"
            >
              <span class="harness-top"><i><UIcon :name="sourceMeta[harness.source].icon" /></i><span><strong>{{ harness.label }}</strong><small>{{ harness.sessions }} sessions · {{ formatTokens(usageTotal(harness.usage)) }} tokens</small></span><b>{{ harness.estimatedUsd === null ? 'UNPRICED' : 'ESTIMATE' }}</b></span>
              <span class="harness-body"><span><small>Estimated token cost</small><strong>{{ spendLabel(harness) }}</strong><em>{{ pricingLabel(harness) }} · {{ harness.pricedRequests }} priced<span v-if="harness.unpricedRequests"> · {{ harness.unpricedRequests }} unpriced</span></em></span><ChartSparkline :data="sparkline(harness)" :color="sourceMeta[harness.source].color" :label="`${harness.label} activity trend`" /></span>
              <span class="harness-foot"><i :style="{ width: `${Math.min(100, usageTotal(harness.usage) / Math.max(1, totalTokens) * 100)}%` }" /><small>Click to inspect models</small><UIcon name="i-lucide-arrow-right" /></span>
            </button>
          </div>
          <p class="pricing-note"><UIcon name="i-lucide-info" />Claude uses public API rates, Codex uses OpenAI API-equivalent rates, and Copilot uses GitHub AI-credit rates. Included plan allowances can reduce the billed amount.</p>
        </section>

        <section class="model-section">
          <header><div><span class="section-kicker">02 · MODEL VIEW</span><h2>What is driving it?</h2></div><span class="filter-state"><i :style="{ background: selectedHarness === 'all' ? 'var(--accent)' : sourceMeta[selectedHarness].color }" />{{ selectedLabel }}<small>{{ visibleModels.length }} models</small></span></header>
          <UEmpty v-if="!visibleModels.length" class="empty-models" icon="i-lucide-chart-no-axes-combined" title="No model usage in this range" description="Try a longer date range or confirm the harness writes usage records to its local transcripts." />
          <div v-else class="model-grid">
            <article class="chart-card">
              <header><div><strong>{{ chartUsesCost ? 'Cost velocity' : 'Token velocity' }}</strong><small>Cumulative {{ chartUsesCost ? 'estimated spend' : 'recorded usage' }} by model</small></div><span>{{ chartUsesCost ? 'USD' : 'TOKENS' }}</span></header>
              <ChartLine
                v-if="chartData.length"
                :data="chartData"
                :categories="chartCategories"
                :height="245"
                :aria-label="`Cumulative ${chartUsesCost ? 'cost' : 'token usage'} by model for ${selectedLabel}`"
                x-key="label"
                :y-ticks="4"
                :y-formatter="chartUsesCost ? value => formatUsd(value) : value => formatTokens(value)"
              />
              <UEmpty v-else variant="naked" title="No dated usage samples" />
            </article>

            <article class="contributors">
              <header><div><strong>{{ chartUsesCost ? 'Cost contribution' : 'Usage contribution' }}</strong><small>Within {{ selectedLabel.toLowerCase() }}</small></div><UIcon name="i-lucide-chart-no-axes-column-increasing" /></header>
              <ol>
                <li v-for="(model, index) in visibleModels" :key="`${model.source}-${model.label}`">
                  <span class="rank">{{ String(index + 1).padStart(2, '0') }}</span>
                  <span class="model-name"><strong>{{ model.label }}</strong><small><i :style="{ background: modelColor(model, visibleModels, index) }" />{{ sessionSourceLabel(model.source) }}</small></span>
                  <span class="bar"><i :style="{ width: `${modelMetric(model, chartUsesCost) / largestMetric * 100}%`, background: modelColor(model, visibleModels, index) }" /></span>
                  <strong class="model-cost">{{ chartUsesCost && model.pricedRequests ? formatUsd(model.estimatedUsd || 0) : formatTokens(usageTotal(model.usage)) }}<small>{{ model.sessions }} session{{ model.sessions === 1 ? '' : 's' }}</small></strong>
                </li>
              </ol>
            </article>
          </div>
        </section>

        <section class="efficiency-section">
          <header><div><span class="section-kicker">03 · USAGE DETAIL</span><h2>Model efficiency</h2></div><span>{{ data.models.length }} recorded models</span></header>
          <div class="table-scroll">
            <table>
              <thead><tr><th>Model / harness</th><th>Spend</th><th>Pricing</th><th>Sessions</th><th>Total tokens</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th></tr></thead>
              <tbody>
                <tr v-for="(model, index) in visibleModels" :key="`${model.source}-${model.label}`">
                  <td><i :style="{ background: modelColor(model, visibleModels, index) }" /><span><strong>{{ model.label }}</strong><small>{{ sessionSourceLabel(model.source) }}</small></span></td>
                  <td><strong>{{ spendLabel(model) }}</strong></td><td>{{ pricingLabel(model) }}</td><td>{{ model.sessions }}</td><td>{{ formatTokens(usageTotal(model.usage)) }}</td><td>{{ formatTokens(model.usage.in) }}</td><td>{{ formatTokens(model.usage.out) }}</td><td>{{ formatTokens(model.usage.cr) }}</td><td>{{ formatTokens(model.usage.cw) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </template>
    </main>
  </div>
</template>

<style scoped>
.cost-page { height: 100%; overflow: auto; background: light-dark(#f6f7f9, #0d0f12); color: var(--text-primary); }
.cost-appbar { position: sticky; z-index: 5; top: 0; display: grid; min-height: 58px; grid-template-columns: 1fr auto 1fr; align-items: center; padding: 0 28px; border-bottom: 1px solid var(--line-soft); background: color-mix(in srgb, var(--surface) 94%, transparent); backdrop-filter: blur(16px); }
.cost-brand { display: flex; align-items: center; gap: 9px; color: var(--text-primary); text-decoration: none; }.cost-brand > span { display: grid; width: 28px; height: 28px; place-items: center; border-radius: 8px; background: var(--accent); color: white; }.cost-brand svg { width: 13px; }.cost-brand strong { font-size: 12px; }
.cost-appbar nav { display: flex; height: 58px; align-items: stretch; gap: 24px; }.cost-appbar nav a { position: relative; display: flex; align-items: center; color: var(--text-tertiary); font-size: 11px; text-decoration: none; }.cost-appbar nav a.active { color: var(--text-primary); }.cost-appbar nav a.active::after { position: absolute; right: 0; bottom: 0; left: 0; height: 2px; background: var(--accent); content: ''; }.cost-appbar > div { display: flex; align-items: center; justify-content: flex-end; gap: 10px; }.local-state { display: inline-flex; align-items: center; gap: 6px; color: var(--text-tertiary); font-size: 9px; }.local-state i { width: 6px; height: 6px; border-radius: 50%; background: var(--live); box-shadow: 0 0 0 3px var(--live-soft); }
.cost-main { width: min(1400px, 100%); margin: auto; padding: 34px clamp(18px, 4vw, 54px) 88px; }.cost-intro { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; margin-bottom: 22px; }.eyebrow,.section-kicker { color: var(--accent); font: 700 8.5px var(--mono); letter-spacing: .14em; }.cost-intro h1 { margin: 7px 0 4px; font-size: clamp(27px, 3.3vw, 41px); letter-spacing: -.05em; line-height: 1.05; }.cost-intro p { margin: 0; color: var(--text-tertiary); font-size: 11px; }.cost-actions { display: flex; gap: 7px; }.cost-actions :deep(button) { font-size: 9px; }.cost-actions :deep(.relative) { min-width: 142px; }.state-alert { margin-bottom: 14px; }.state-alert :deep([data-slot="title"]) { color: var(--text-secondary); }
.summary-grid { display: grid; grid-template-columns: 1.2fr .8fr 1fr 1fr; gap: 8px; margin-bottom: 24px; }.summary-grid article { min-width: 0; padding: 13px 14px; border: 1px solid var(--line-soft); border-radius: 11px; background: var(--surface); }.summary-grid article > span { color: var(--text-tertiary); font-size: 8.5px; }.summary-grid article > strong { display: block; margin: 6px 0 2px; font: 650 20px var(--mono); letter-spacing: -.04em; }.summary-grid article > small { color: var(--text-tertiary); font-size: 8px; }.summary-grid .summary-total > strong { font-size: 24px; }
.harness-section > header,.model-section > header,.efficiency-section > header { display: flex; align-items: flex-end; justify-content: space-between; gap: 18px; margin-bottom: 10px; }.harness-section h2,.model-section h2,.efficiency-section h2 { margin: 3px 0 0; font-size: 15px; }.harness-section > header button { padding: 4px 8px; border: 0; background: transparent; color: var(--text-tertiary); font-size: 8.5px; cursor: pointer; }
.harness-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }.harness-card { min-width: 0; padding: 0; overflow: hidden; border: 1px solid var(--line-soft); border-top: 3px solid var(--harness); border-radius: 12px; background: var(--surface); color: var(--text-primary); cursor: pointer; text-align: left; transition: opacity .15s, border-color .15s, transform .15s; }.harness-card:hover,.harness-card.active { border-color: var(--harness); transform: translateY(-2px); }.harness-card.muted { border-top-color: var(--line); }.harness-top { display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; align-items: center; gap: 9px; padding: 11px 12px; border-bottom: 1px solid var(--line-soft); }.harness-top > i { display: grid; width: 31px; height: 31px; place-items: center; border-radius: 9px; background: color-mix(in srgb, var(--harness) 14%, transparent); color: var(--harness); }.harness-top svg { width: 14px; }.harness-top > span,.harness-body > span { display: flex; min-width: 0; flex-direction: column; }.harness-top strong { font-size: 10.5px; }.harness-top small { margin-top: 2px; color: var(--text-tertiary); font-size: 7.5px; }.harness-top > b { padding: 3px 6px; border-radius: 999px; background: color-mix(in srgb, var(--harness) 12%, transparent); color: var(--text-secondary); font: 700 7px var(--mono); }.harness-body { display: flex; min-height: 84px; align-items: center; justify-content: space-between; gap: 12px; padding: 12px; }.harness-body small { color: var(--text-tertiary); font-size: 8px; }.harness-body strong { margin: 3px 0 1px; font: 650 20px var(--mono); }.harness-body em { color: var(--text-tertiary); font-size: 7.5px; font-style: normal; }.harness-body :deep(.chart-root) { width: 128px; flex: 0 0 128px; }.harness-foot { display: grid; grid-template-columns: minmax(0, 1fr) auto 12px; align-items: center; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--line-soft); background: var(--surface-raised); }.harness-foot > i { display: block; height: 3px; border-radius: 3px; background: var(--harness); }.harness-foot small { color: var(--text-tertiary); font-size: 7.5px; }.harness-foot svg { width: 10px; color: var(--harness); }.pricing-note { display: flex; align-items: center; gap: 6px; margin: 9px 2px 0; color: var(--text-tertiary); font-size: 8px; }.pricing-note svg { width: 11px; }
.model-section { margin-top: 27px; }.filter-state { display: inline-flex; align-items: center; gap: 6px; padding: 5px 8px; border: 1px solid var(--line-soft); border-radius: 999px; background: var(--surface); color: var(--text-secondary); font-size: 8.5px; }.filter-state > i { width: 6px; height: 6px; border-radius: 50%; }.filter-state small { padding-left: 6px; border-left: 1px solid var(--line-soft); color: var(--text-tertiary); }.empty-models { border: 1px solid var(--line-soft); border-radius: 12px; background: var(--surface); }.model-grid { display: grid; grid-template-columns: minmax(0, 1.8fr) minmax(310px, .8fr); gap: 8px; }.chart-card,.contributors { min-width: 0; overflow: hidden; border: 1px solid var(--line-soft); border-radius: 12px; background: var(--surface); }.chart-card > header,.contributors > header { display: flex; min-height: 54px; align-items: center; justify-content: space-between; padding: 10px 13px; border-bottom: 1px solid var(--line-soft); }.chart-card header > div,.contributors header > div { display: flex; flex-direction: column; }.chart-card header strong,.contributors header strong { font-size: 10.5px; }.chart-card header small,.contributors header small { margin-top: 2px; color: var(--text-tertiary); font-size: 7.5px; }.chart-card header > span { color: var(--text-tertiary); font: 8px var(--mono); }.chart-card :deep(.chart-legend) { min-height: 39px; }.contributors header > svg { width: 15px; color: var(--accent); }.contributors ol { display: grid; margin: 0; padding: 0; list-style: none; }.contributors li { display: grid; min-height: 45px; grid-template-columns: 21px 105px minmax(55px, 1fr) 66px; align-items: center; gap: 7px; padding: 0 12px; border-bottom: 1px solid var(--line-soft); }.contributors li:last-child { border-bottom: 0; }.rank { color: var(--text-tertiary); font: 7.5px var(--mono); }.model-name { display: flex; min-width: 0; flex-direction: column; }.model-name strong { overflow: hidden; font-size: 8.5px; text-overflow: ellipsis; white-space: nowrap; }.model-name small { display: flex; align-items: center; gap: 4px; margin-top: 2px; color: var(--text-tertiary); font-size: 7px; }.model-name i { width: 5px; height: 5px; border-radius: 50%; }.bar { height: 4px; overflow: hidden; border-radius: 4px; background: var(--surface-hover); }.bar i { display: block; height: 100%; border-radius: inherit; }.model-cost { display: flex; flex-direction: column; text-align: right; font: 600 8.5px var(--mono); }.model-cost small { color: var(--text-tertiary); font-size: 7px; font-weight: 450; }
.efficiency-section { margin-top: 27px; }.efficiency-section > header > span { color: var(--text-tertiary); font-size: 8px; }.table-scroll { overflow-x: auto; border: 1px solid var(--line-soft); border-radius: 12px; background: var(--surface); }.efficiency-section table { width: 100%; min-width: 980px; border-collapse: collapse; }.efficiency-section th { height: 34px; padding: 0 12px; border-bottom: 1px solid var(--line-soft); background: var(--surface-raised); color: var(--text-tertiary); font-size: 7.5px; text-align: right; text-transform: uppercase; letter-spacing: .05em; }.efficiency-section th:first-child { text-align: left; }.efficiency-section td { height: 48px; padding: 0 12px; border-bottom: 1px solid var(--line-soft); color: var(--text-secondary); font: 8.5px var(--mono); text-align: right; }.efficiency-section tr:last-child td { border-bottom: 0; }.efficiency-section tbody tr:hover { background: var(--surface-hover); }.efficiency-section td:first-child { display: flex; align-items: center; gap: 8px; text-align: left; }.efficiency-section td:first-child > i { width: 7px; height: 29px; border-radius: 5px; }.efficiency-section td:first-child > span { display: flex; flex-direction: column; }.efficiency-section td:first-child strong { color: var(--text-primary); font: 600 9px ui-sans-serif, sans-serif; }.efficiency-section td:first-child small { margin-top: 2px; color: var(--text-tertiary); font: 7px ui-sans-serif, sans-serif; }.efficiency-section td:nth-child(2) strong { color: var(--text-primary); }
@media (max-width: 1050px) { .summary-grid { grid-template-columns: 1fr 1fr; }.harness-body :deep(.chart-root) { width: 92px; flex-basis: 92px; }.model-grid { grid-template-columns: 1fr; }.contributors li { grid-template-columns: 25px 160px minmax(80px, 1fr) 70px; } }
@media (max-width: 760px) { .cost-appbar { grid-template-columns: 1fr auto; padding: 0 13px; }.cost-appbar nav,.local-state { display: none; }.cost-main { padding: 24px 12px 82px; }.cost-intro { align-items: flex-start; flex-direction: column; }.cost-actions { width: 100%; }.cost-actions :deep(.relative) { flex: 1; }.summary-grid { grid-template-columns: 1fr 1fr; }.harness-grid { grid-template-columns: 1fr; }.harness-card.muted { display: none; }.harness-body :deep(.chart-root) { width: 128px; flex-basis: 128px; }.contributors li { grid-template-columns: 22px 110px minmax(60px, 1fr) 64px; } }
</style>
