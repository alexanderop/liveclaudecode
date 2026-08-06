import process from 'node:process'

export default defineNuxtConfig({
  compatibilityDate: '2026-07-25',
  // Atom evaluation is unsafe on the server: `@effect/atom-vue`'s
  // `defaultRegistry` is a module singleton whose nodes survive a synchronous
  // render, and `Atom.defaultMemoMap` memoizes service builds process-wide
  // regardless of which registry is used. Two concurrent requests would share
  // both. Nothing is lost — every fetch already deferred to `onMounted`, so the
  // server rendered an empty shell, and Nitro still serves the SPA index under
  // `preset: 'node-server'` for the CLI and the Electron shell.
  ssr: false,
  css: ['~/assets/main.css'],
  devtools: { enabled: true },
  modules: ['@comark/nuxt', '@nuxt/eslint', '@nuxt/ui', '@vueuse/nuxt', '@nuxt/test-utils/module'],
  colorMode: {
    preference: 'system',
    fallback: 'dark',
  },
  ui: {
    theme: {
      defaultVariants: {
        size: 'sm',
      },
    },
  },
  icon: {
    // `@nuxt/icon` defaults `provider` to `server`, but to `iconify` when
    // `ssr: false` — which sends every icon lookup to api.iconify.design. This
    // dashboard must work with no runtime network access, so the provider is
    // pinned to the local Nitro endpoint, the public API fallback is off, and
    // the icons used in source are bundled into the client so the common case
    // needs no request at all.
    provider: 'server',
    fallbackToApi: false,
    clientBundle: {
      scan: true,
    },
  },
  runtimeConfig: {
    lcc: {
      project: process.env.LCC_PROJECT || '',
      hours: Number(process.env.LCC_HOURS || 168),
    },
  },
  devServer: {
    host: process.env.HOST || '127.0.0.1',
  },
  app: {
    head: {
      htmlAttrs: { lang: 'en' },
      title: 'Claude + Codex + Copilot Sessions — Live',
      meta: [
        { name: 'description', content: 'Local live view of Claude Code, Codex, and Copilot sessions' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      ],
    },
  },
  nitro: {
    preset: 'node-server',
    routeRules: {
      '/api/**': { cache: false },
    },
  },
  typescript: {
    strict: true,
    typeCheck: false,
  },
})
