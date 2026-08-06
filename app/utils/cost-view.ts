import type {
  CostOverviewGroupWire,
  SessionSourceWire,
  UsageWire,
} from '#shared/schemas/api'
import { sessionSourceLabel } from './format'

// Everything here takes the decoded, readonly wire shapes rather than the
// mutable interfaces the server builds with. A mutable value is assignable to a
// readonly one, so the server types and the test fixtures still flow in here
// unchanged; the reverse is not true, which is why the signatures had to move
// rather than the caller.

/** Per-source series colors for the cost charts, strongest shade first. */
export const MODEL_PALETTE: Readonly<Record<SessionSourceWire, readonly string[]>> = {
  claude: ['#d9915b', '#efb27e', '#f1c79f', '#ba7044'],
  codex: ['#65b89a', '#96d5bd', '#45977b', '#bce9d8'],
  copilot: ['#6f9de8', '#9abcf2', '#477fcf', '#bed2f7'],
}

/** Total recorded tokens across input, output, and prompt caching. */
export function usageTotal(usage?: UsageWire): number {
  return usage ? usage.in + usage.out + usage.cr + usage.cw : 0
}

/** Stable chart series key for a model group. */
export function seriesKey(model: CostOverviewGroupWire): string {
  return `${model.source}-${model.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
}

/**
 * Series color for a model: shades rotate within its source's palette by the
 * model's position among the visible models of the same source.
 */
export function modelColor(
  model: CostOverviewGroupWire,
  visibleModels: readonly CostOverviewGroupWire[],
  index = 0,
): string {
  const sameSource = visibleModels.filter(item => item.source === model.source)
  const sourceIndex = sameSource.findIndex(item => item.label === model.label)
  const colors = MODEL_PALETTE[model.source]
  return colors[(sourceIndex < 0 ? index : sourceIndex) % colors.length]!
}

/** Comparable magnitude of a model group: estimated USD or token volume. */
export function modelMetric(model: CostOverviewGroupWire, useCost: boolean): number {
  return useCost && model.pricedRequests
    ? model.estimatedUsd || 0
    : usageTotal(model.usage)
}

/** How a group's estimate was priced, or that no rate was available. */
export function pricingLabel(group: CostOverviewGroupWire): string {
  if (group.estimatedUsd === null) return 'Rate unavailable'
  if (group.source === 'codex') return 'OpenAI API equivalent'
  if (group.source === 'copilot') return 'GitHub AI Credits'
  return 'Claude API estimate'
}

/** Daily activity trend: estimated USD, or token totals when unpriced. */
export function sparkline(group: CostOverviewGroupWire): number[] {
  return group.days.map(day => group.estimatedUsd === null ? usageTotal(day.usage) : day.estimatedUsd)
}

function csvValue(value: string | number): string {
  return `"${String(value).replaceAll('"', '""')}"`
}

/** RFC-4180 style CSV of the model cost table, one row per model group. */
export function serializeCostCsv(models: readonly CostOverviewGroupWire[]): string {
  const rows: Array<Array<string | number>> = [
    ['Harness', 'Model', 'Estimated USD', 'Pricing', 'Sessions', 'Input', 'Output', 'Cache read', 'Cache write'],
    ...models.map((model): Array<string | number> => [
      sessionSourceLabel(model.source), model.label, model.estimatedUsd ?? '',
      pricingLabel(model),
      model.sessions, model.usage.in, model.usage.out, model.usage.cr, model.usage.cw,
    ]),
  ]
  return rows.map(row => row.map(csvValue).join(',')).join('\n')
}
