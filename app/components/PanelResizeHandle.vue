<script setup lang="ts">
const props = defineProps<{
  modelValue: number
  min: number
  max: number
  defaultValue: number
  direction: 'left' | 'right'
  label: string
}>()

const emit = defineEmits<{
  'update:modelValue': [width: number]
}>()

const dragging = ref(false)
let startX = 0
let startWidth = 0

function clamp(width: number): number {
  return Math.round(Math.min(Math.max(width, props.min), props.max))
}

function updateFromPointer(event: PointerEvent): void {
  const multiplier = props.direction === 'right' ? 1 : -1
  emit('update:modelValue', clamp(startWidth + ((event.clientX - startX) * multiplier)))
}

function stopDragging(): void {
  if (!dragging.value) return
  dragging.value = false
  document.documentElement.classList.remove('panel-resizing')
  window.removeEventListener('pointermove', updateFromPointer)
  window.removeEventListener('pointerup', stopDragging)
  window.removeEventListener('pointercancel', stopDragging)
}

function startDragging(event: PointerEvent): void {
  if (event.button !== 0) return
  event.preventDefault()
  startX = event.clientX
  startWidth = props.modelValue
  dragging.value = true
  document.documentElement.classList.add('panel-resizing')
  window.addEventListener('pointermove', updateFromPointer)
  window.addEventListener('pointerup', stopDragging)
  window.addEventListener('pointercancel', stopDragging)
}

function resizeWithKeyboard(event: KeyboardEvent): void {
  const step = event.shiftKey ? 40 : 12
  const multiplier = props.direction === 'right' ? 1 : -1
  let next: number

  if (event.key === 'ArrowLeft') next = props.modelValue - (step * multiplier)
  else if (event.key === 'ArrowRight') next = props.modelValue + (step * multiplier)
  else if (event.key === 'Home') next = props.min
  else if (event.key === 'End') next = props.max
  else return

  event.preventDefault()
  emit('update:modelValue', clamp(next))
}

function resetWidth(): void {
  emit('update:modelValue', clamp(props.defaultValue))
}

onBeforeUnmount(stopDragging)
</script>

<template>
  <UDashboardResizeHandle
    as="button"
    type="button"
    class="panel-resize-handle"
    :class="{ dragging }"
    role="separator"
    aria-orientation="vertical"
    :aria-label="label"
    :aria-valuemin="min"
    :aria-valuemax="max"
    :aria-valuenow="modelValue"
    :aria-valuetext="`${modelValue} pixels`"
    title="Drag to resize. Use arrow keys for precise control. Double-click to reset."
    @pointerdown="startDragging"
    @keydown="resizeWithKeyboard"
    @dblclick="resetWidth"
  />
</template>
