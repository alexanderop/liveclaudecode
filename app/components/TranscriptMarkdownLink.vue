<script setup lang="ts">
const props = defineProps<{
  href?: string
}>()

const safeHref = computed(() => {
  const href = props.href?.trim()
  if (!href) return null
  if (href.startsWith('#')) return href

  try {
    const url = new URL(href)
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? href : null
  } catch {
    return null
  }
})

const opensNewWindow = computed(() =>
  safeHref.value !== null && !safeHref.value.startsWith('#') && !safeHref.value.startsWith('mailto:'))
</script>

<template>
  <a
    v-if="safeHref"
    :href="safeHref"
    :target="opensNewWindow ? '_blank' : undefined"
    :rel="opensNewWindow ? 'noopener noreferrer' : undefined"
  ><slot /></a>
  <span v-else class="markdown-inert-link"><slot /></span>
</template>
