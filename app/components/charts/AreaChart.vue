<script setup lang="ts" generic="T extends Record<string, string | number | undefined>">
import type { CSSProperties } from 'vue'
import type { AreaChartProps, ChartCategory } from './chart'

const props = withDefaults(defineProps<AreaChartProps<T>>(), {
  height: 240,
  xKey: undefined,
  xTicks: 6,
  yTicks: 4,
  yDomain: () => [0, undefined],
  padding: () => ({ top: 12, right: 14, bottom: 28, left: 44 }),
  lineWidth: 2.5,
  hideArea: false,
  hideLegend: false,
  hideTooltip: false,
  compact: false,
  ariaLabel: 'Data chart',
  xFormatter: undefined,
  yFormatter: (value: number) => String(value),
  tooltipTitleFormatter: undefined,
})

const emit = defineEmits<{
  click: [value: T, index: number]
}>()

const slots = defineSlots<{
  tooltip?: (props: { values: T, index: number }) => unknown
}>()

const VIEW_WIDTH = 800
const VIEW_HEIGHT = 240
const hoveredIndex = ref<number | null>(null)
const chartId = `chart-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
const seriesKeys = computed(() => Object.keys(props.categories))
const effectivePadding = computed(() => props.compact
  ? { top: 2, right: 2, bottom: 2, left: 2 }
  : props.padding)
const plotWidth = computed(() => VIEW_WIDTH - effectivePadding.value.left - effectivePadding.value.right)
const plotHeight = computed(() => VIEW_HEIGHT - effectivePadding.value.top - effectivePadding.value.bottom)

const domain = computed<[number, number]>(() => {
  const values = props.data.flatMap(row => seriesKeys.value.map(key => Number(row[key]) || 0))
  const automaticMin = Math.min(0, ...values)
  const automaticMax = Math.max(1, ...values)
  const min = props.yDomain[0] ?? automaticMin
  const max = props.yDomain[1] ?? automaticMax
  return max === min ? [min, max + 1] : [min, max]
})

const xTickIndexes = computed(() => {
  if (props.data.length <= 1) return props.data.length ? [0] : []
  const count = Math.min(props.xTicks, props.data.length)
  return Array.from(new Set(Array.from({ length: count }, (_, index) =>
    Math.round(index * (props.data.length - 1) / Math.max(1, count - 1)))))
})

const yTickValues = computed(() => Array.from({ length: props.yTicks + 1 }, (_, index) =>
  domain.value[0] + index * ((domain.value[1] - domain.value[0]) / props.yTicks)))

function xFor(index: number): number {
  if (props.data.length <= 1) return effectivePadding.value.left + plotWidth.value / 2
  return effectivePadding.value.left + index * (plotWidth.value / (props.data.length - 1))
}

function yFor(value: number): number {
  const [min, max] = domain.value
  return effectivePadding.value.top + (max - value) / (max - min) * plotHeight.value
}

function xPercent(index: number): string {
  return `${xFor(index) / VIEW_WIDTH * 100}%`
}

function yPercent(value: number): string {
  return `${yFor(value) / VIEW_HEIGHT * 100}%`
}

function pointsFor(key: string): Array<{ x: number, y: number }> {
  return props.data.map((row, index) => ({ x: xFor(index), y: yFor(Number(row[key]) || 0) }))
}

function smoothPath(key: string): string {
  const points = pointsFor(key)
  if (!points.length) return ''
  if (points.length === 1) return `M ${points[0]!.x} ${points[0]!.y}`

  let path = `M ${points[0]!.x.toFixed(2)} ${points[0]!.y.toFixed(2)}`
  for (let index = 0; index < points.length - 1; index += 1) {
    const before = points[index - 1] ?? points[index]!
    const current = points[index]!
    const next = points[index + 1]!
    const after = points[index + 2] ?? next
    const controlOneX = current.x + (next.x - before.x) / 6
    const controlOneY = current.y + (next.y - before.y) / 6
    const controlTwoX = next.x - (after.x - current.x) / 6
    const controlTwoY = next.y - (after.y - current.y) / 6
    path += ` C ${controlOneX.toFixed(2)} ${controlOneY.toFixed(2)}, ${controlTwoX.toFixed(2)} ${controlTwoY.toFixed(2)}, ${next.x.toFixed(2)} ${next.y.toFixed(2)}`
  }
  return path
}

function areaPath(key: string): string {
  if (!props.data.length) return ''
  const baseline = yFor(domain.value[0])
  return `${smoothPath(key)} L ${xFor(props.data.length - 1).toFixed(2)} ${baseline.toFixed(2)} L ${xFor(0).toFixed(2)} ${baseline.toFixed(2)} Z`
}

function categoryFor(key: string): ChartCategory {
  return props.categories[key] ?? { name: key, color: '#8b8b94' }
}

function labelFor(index: number): string {
  const row = props.data[index]
  if (!row) return ''
  if (props.xFormatter) return props.xFormatter(row, index)
  if (props.xKey) return String(row[props.xKey] ?? '')
  return String(index + 1)
}

function tooltipTitle(index: number): string {
  const row = props.data[index]
  if (!row) return ''
  return props.tooltipTitleFormatter?.(row, index) ?? labelFor(index)
}

function onPointerMove(event: PointerEvent): void {
  if (!props.data.length) return
  const svg = event.currentTarget as SVGSVGElement
  const bounds = svg.getBoundingClientRect()
  const viewX = (event.clientX - bounds.left) / bounds.width * VIEW_WIDTH
  const ratio = (viewX - effectivePadding.value.left) / plotWidth.value
  hoveredIndex.value = Math.max(0, Math.min(props.data.length - 1, Math.round(ratio * (props.data.length - 1))))
}

function onClick(): void {
  if (hoveredIndex.value === null) return
  const value = props.data[hoveredIndex.value]
  if (value) emit('click', value, hoveredIndex.value)
}

const hoverStyle = computed<CSSProperties>(() => {
  if (hoveredIndex.value === null) return {}
  const percent = xFor(hoveredIndex.value) / VIEW_WIDTH * 100
  return {
    left: `${percent}%`,
    transform: percent > 72 ? 'translateX(-100%)' : percent < 28 ? 'translateX(0)' : 'translateX(-50%)',
  }
})
</script>

<template>
  <div class="chart-root" :class="{ compact }">
    <div v-if="!hideLegend" class="chart-legend" aria-label="Chart legend">
      <span v-for="key in seriesKeys" :key="key">
        <i :style="{ background: categoryFor(key).color }" />
        {{ categoryFor(key).name }}
      </span>
    </div>

    <div class="chart-stage" :style="{ height: `${height}px` }">
      <svg
        viewBox="0 0 800 240"
        preserveAspectRatio="none"
        role="img"
        :aria-label="ariaLabel"
        @pointermove="onPointerMove"
        @pointerleave="hoveredIndex = null"
        @click="onClick"
      >
        <defs>
          <linearGradient v-for="key in seriesKeys" :id="`${chartId}-${key}`" :key="key" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" :stop-color="categoryFor(key).color" stop-opacity=".22" />
            <stop offset="1" :stop-color="categoryFor(key).color" stop-opacity="0" />
          </linearGradient>
        </defs>

        <g v-if="!compact" class="chart-grid">
          <path v-for="value in yTickValues" :key="value" :d="`M ${effectivePadding.left} ${yFor(value)} L ${VIEW_WIDTH - effectivePadding.right} ${yFor(value)}`" />
        </g>

        <path
          v-for="key in hideArea ? [] : seriesKeys"
          :key="`${key}-area`"
          :d="areaPath(key)"
          :fill="`url(#${chartId}-${key})`"
        />
        <path
          v-for="key in seriesKeys"
          :key="`${key}-line`"
          :d="smoothPath(key)"
          fill="none"
          :stroke="categoryFor(key).color"
          :stroke-width="lineWidth"
          vector-effect="non-scaling-stroke"
          stroke-linecap="round"
          stroke-linejoin="round"
        />

        <g v-if="hoveredIndex !== null && !hideTooltip" class="chart-crosshair">
          <path :d="`M ${xFor(hoveredIndex)} ${effectivePadding.top} L ${xFor(hoveredIndex)} ${VIEW_HEIGHT - effectivePadding.bottom}`" />
          <path
            v-for="key in seriesKeys"
            :key="key"
            :d="`M ${xFor(hoveredIndex)} ${yFor(Number(data[hoveredIndex]?.[key]) || 0)} m -4 0 a 4 4 0 1 0 8 0 a 4 4 0 1 0 -8 0`"
            :fill="categoryFor(key).color"
            class="chart-point"
          />
        </g>
      </svg>

      <div v-if="!compact" class="chart-y-labels" aria-hidden="true">
        <span v-for="value in yTickValues" :key="value" :style="{ top: yPercent(value) }">{{ yFormatter(value) }}</span>
      </div>
      <div v-if="!compact" class="chart-x-labels" aria-hidden="true">
        <span v-for="index in xTickIndexes" :key="index" :style="{ left: xPercent(index) }">{{ labelFor(index) }}</span>
      </div>

      <div v-if="hoveredIndex !== null && !hideTooltip && data[hoveredIndex]" class="chart-tooltip" :style="hoverStyle">
        <slot v-if="slots.tooltip" name="tooltip" :values="data[hoveredIndex]!" :index="hoveredIndex" />
        <template v-else>
          <strong>{{ tooltipTitle(hoveredIndex) }}</strong>
          <span v-for="key in seriesKeys" :key="key">
            <i :style="{ background: categoryFor(key).color }" />
            <small>{{ categoryFor(key).name }}</small>
            <b>{{ yFormatter(Number(data[hoveredIndex]?.[key]) || 0) }}</b>
          </span>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chart-root { --chart-muted: var(--text-disabled); width: 100%; min-width: 0; }
.chart-legend { display: flex; min-height: 34px; flex-wrap: wrap; align-items: center; gap: 7px 14px; padding: 7px 13px; border-bottom: 1px solid var(--line-soft); }
.chart-legend span { display: inline-flex; align-items: center; gap: 5px; color: var(--text-secondary); font-size: 7.5px; }
.chart-legend i { width: 6px; height: 6px; border-radius: 50%; }
.chart-stage { position: relative; width: 100%; min-width: 0; }
.chart-stage svg { display: block; width: 100%; height: 100%; overflow: visible; touch-action: pan-y; }
.chart-grid path { fill: none; stroke: var(--line-soft); stroke-width: 1; stroke-dasharray: 3 5; vector-effect: non-scaling-stroke; }
.chart-y-labels,.chart-x-labels { position: absolute; inset: 0; pointer-events: none; }
.chart-y-labels span,.chart-x-labels span { position: absolute; color: var(--chart-muted); font: 7px var(--mono); }
.chart-y-labels span { left: 0; width: 36px; transform: translateY(-50%); text-align: right; }
.chart-x-labels span { bottom: 4px; transform: translateX(-50%); white-space: nowrap; }
.chart-crosshair > path:first-child { fill: none; stroke: color-mix(in srgb, var(--text-tertiary) 55%, transparent); stroke-width: 1; stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; }
.chart-point { stroke: var(--surface); stroke-width: 2.5; vector-effect: non-scaling-stroke; }
.chart-tooltip { position: absolute; z-index: 4; top: 8px; display: grid; min-width: 150px; gap: 6px; padding: 9px 10px; border: 1px solid var(--line); border-radius: 9px; background: color-mix(in srgb, var(--surface-raised) 96%, transparent); box-shadow: 0 12px 28px rgb(0 0 0 / 25%); pointer-events: none; backdrop-filter: blur(10px); }
.chart-tooltip > strong { padding-bottom: 5px; border-bottom: 1px solid var(--line-soft); font-size: 9px; }
.chart-tooltip > span { display: grid; grid-template-columns: 6px minmax(80px, 1fr) auto; align-items: center; gap: 6px; }
.chart-tooltip > span i { width: 6px; height: 6px; border-radius: 50%; }
.chart-tooltip > span small { overflow: hidden; color: var(--text-tertiary); font-size: 8px; text-overflow: ellipsis; white-space: nowrap; }
.chart-tooltip > span b { font: 600 8px var(--mono); }
.chart-root.compact .chart-stage { min-height: 20px; }.chart-root.compact svg { cursor: default; }
</style>
