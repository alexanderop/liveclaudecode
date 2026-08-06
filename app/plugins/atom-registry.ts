import { registryKey } from '@effect/atom-vue'
import * as AtomRegistry from 'effect/unstable/reactivity/AtomRegistry'

/**
 * Provides one atom registry per Nuxt app instance.
 *
 * `@effect/atom-vue` exports no provider component, and `injectRegistry()` falls
 * back to a module-level `defaultRegistry` instead of throwing
 * (`repos/effect/packages/atom/vue/src/index.ts:59,65-67`). Anything that reads
 * an atom without this provide in scope silently shares global state, so the
 * provide is a plugin and not a component wrapper.
 *
 * `defaultRegistry` is built with no options, which tears an atom down the
 * instant its last subscriber unmounts. The React binding's default registry
 * passes `defaultIdleTTL: 400`
 * (`repos/effect/packages/atom/react/src/RegistryContext.ts:44-47`); this
 * matches it. Node removal is scheduled as a macrotask, so a synchronous remount
 * keeps the node while an async route transition would not — the TTL is what
 * makes navigating away and back free.
 */
export default defineNuxtPlugin({
  name: 'atom-registry',
  enforce: 'pre',
  setup(nuxtApp) {
    nuxtApp.vueApp.provide(registryKey, AtomRegistry.make({ defaultIdleTTL: 400 }))
  },
})
