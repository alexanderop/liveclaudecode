<script setup lang="ts" generic="T extends Record<string, string | number | undefined>">
import AreaChart from './AreaChart.vue'
import type { AreaChartProps } from './chart'

const props = defineProps<Omit<AreaChartProps<T>, 'hideArea'>>()

const slots = defineSlots<{
  tooltip?: (props: { values: T, index: number }) => unknown
}>()
</script>

<template>
  <AreaChart v-bind="props" hide-area>
    <template v-if="slots.tooltip" #tooltip="scope">
      <slot name="tooltip" v-bind="scope" />
    </template>
  </AreaChart>
</template>
