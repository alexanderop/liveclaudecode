<script setup lang="ts">
import security from '@comark/nuxt/plugins/security'
import CodeBlock from '~/components/CodeBlock.vue'
import TranscriptMarkdownLink from '~/components/TranscriptMarkdownLink.vue'

/**
 * Transcript prose is untrusted: it is whatever a model wrote or a user pasted,
 * so embedded HTML and non-web protocols are stripped before rendering.
 */
const plugins = [
  security({
    blockedTags: ['script', 'iframe', 'object', 'embed', 'link', 'style', 'base', 'meta'],
    allowedProtocols: ['http', 'https', 'mailto'],
  }),
]
/** Fences render through Shiki, and links are filtered down to safe targets. */
const components = { a: TranscriptMarkdownLink, pre: CodeBlock }

defineProps<{
  /** Raw markdown recorded in a transcript. */
  markdown?: string
}>()
</script>

<template>
  <Comark
    class="markdown-body"
    :markdown="markdown || ''"
    :plugins="plugins"
    :components="components"
  />
</template>
