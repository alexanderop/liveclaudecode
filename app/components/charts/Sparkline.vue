<script setup lang="ts">
import LineChart from './LineChart.vue'

const props = withDefaults(defineProps<{
  data: number[]
  color: string
  height?: number
  label?: string
}>(), {
  height: 38,
  label: 'Trend',
})

const rows = computed(() => props.data.map((value, index) => ({ index, value })))
const categories = computed(() => ({ value: { name: props.label, color: props.color } }))
</script>

<template>
  <LineChart
    :data="rows"
    :categories="categories"
    :height="height"
    :aria-label="label"
    :line-width="2.2"
    compact
    hide-legend
    hide-tooltip
  />
</template>
