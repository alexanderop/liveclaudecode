<script setup lang="ts">
import { comarkCodeText } from '~/utils/comark-node'

const props = defineProps<{
  /**
   * Comark fence node, supplied automatically when this component is registered
   * as the `pre` override of a `<Comark>` renderer. The renderer looks for this
   * exact prop name to decide whether to pass the node, so it cannot be
   * camelCased.
   */
  // eslint-disable-next-line vue/prop-name-casing
  __node?: unknown
  /** Code to highlight, for standalone use outside a markdown fence. */
  code?: string
  /** Fence info string, file extension, or Shiki language id. */
  language?: string
  /** Fence `[filename]`, shown as a header. */
  filename?: string
  /** Edited file path, shown as a header when there is no `filename`. */
  path?: string
  /** 1-based line numbers from a fence's `{1,3-5}` meta. */
  highlights?: number[]
  /** 1-based line numbers to mark as added. */
  added?: number[]
  /** 1-based line numbers to mark as removed. */
  removed?: number[]
  /**
   * Holds off highlighting, e.g. while the block is collapsed. Phrased as an
   * opt-out because Vue casts an absent boolean prop to `false`, so an
   * `enabled` flag would leave every block unhighlighted by default.
   */
  defer?: boolean
}>()

const code = computed(() => (props.__node === undefined ? props.code || '' : comarkCodeText(props.__node)))
const label = computed(() => props.filename || props.path || '')
const isDiff = computed(() => Boolean(props.added?.length || props.removed?.length))

const { html, failed } = useCodeHighlight(code, {
  language: () => props.language,
  added: () => props.added,
  removed: () => props.removed,
  highlights: () => props.highlights,
  enabled: () => !props.defer,
})
</script>

<template>
  <div class="code-block" :class="{ 'is-diff': isDiff }">
    <header v-if="label" class="code-block-label">
      <UIcon name="i-lucide-file-code-2" />
      <span class="code-block-name" :title="label">{{ label }}</span>
    </header>
    <!--
      Shiki escapes the source it is given and emits only `pre`/`code`/`span`
      with style attributes, so the markup is safe to inject.
    -->
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div v-if="html && !failed" class="code-block-body" v-html="html" />
    <pre v-else class="code-block-plain"><code>{{ code }}</code></pre>
  </div>
</template>

<style scoped>
.code-block { min-width: 0; }
.code-block-label { display: flex; align-items: center; gap: 5px; margin-bottom: 4px; color: light-dark(#65656c, #6b6b72); font: 10.5px var(--mono); }
.code-block-label svg { width: 11px; height: 11px; }
.code-block-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.code-block-body :deep(pre.shiki) { max-height: 360px; margin: 0; padding: 10px 0; overflow: auto; border: 1px solid light-dark(#d1d1d5, #26262a); border-radius: 7px; background: light-dark(#f7f7f8, #111113); font: 12.5px/1.6 var(--mono); white-space: pre; }
.code-block-body :deep(code) { display: block; width: fit-content; min-width: 100%; padding: 0; border: 0; background: transparent; font: inherit; }
.code-block-body :deep(.line) { display: inline-block; width: 100%; padding: 0 12px; }

/* Diff and fence-highlight markers are drawn as full-bleed line backgrounds. */
.code-block-body :deep(.line-add) { background: light-dark(#e2f2e5, #16251b); box-shadow: inset 2px 0 light-dark(#4a9e63, #4f9e6a); }
.code-block-body :deep(.line-remove) { background: light-dark(#fbe9e9, #2a1618); box-shadow: inset 2px 0 light-dark(#c0554f, #a8574f); }
.code-block-body :deep(.line-highlight) { background: light-dark(#f0eefb, #1b1a26); box-shadow: inset 2px 0 var(--accent); }

.code-block-plain { max-height: 360px; margin: 0; padding: 10px 12px; overflow: auto; border: 1px solid light-dark(#d1d1d5, #26262a); border-radius: 7px; background: light-dark(#f7f7f8, #111113); color: light-dark(#3a3a3e, #b8b8bd); font: 12.5px/1.6 var(--mono); white-space: pre-wrap; word-break: break-word; }
.code-block-plain code { padding: 0; border: 0; background: transparent; color: inherit; font: inherit; }
</style>
