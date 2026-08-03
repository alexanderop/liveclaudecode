<script setup lang="ts">
import { toolCodePreview } from '~/utils/tool-code'

const props = defineProps<{
  /** Tool name, used to decide whether the payload can be shown as an edit. */
  tool?: string
  /** Pretty-printed JSON payload recorded for the tool call. */
  input?: string
}>()

const open = ref(false)
// A session holds thousands of tool calls, so the payload is only parsed and
// diffed once its disclosure is actually opened.
const preview = computed(() => (open.value ? toolCodePreview(props.tool, props.input || '') : null))
</script>

<template>
  <details class="event-details" @toggle="open = ($event.target as HTMLDetailsElement).open">
    <summary>Show tool input</summary>
    <CodeBlock
      v-if="preview"
      class="tool-input-code"
      :code="preview.code"
      :language="preview.language"
      :path="preview.path"
      :added="preview.added"
      :removed="preview.removed"
    />
  </details>
</template>

<style scoped>
.tool-input-code { margin-top: 7px; }
</style>
