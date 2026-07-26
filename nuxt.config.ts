import process from 'node:process'

export default defineNuxtConfig({
  compatibilityDate: '2026-07-25',
  css: ['~/assets/main.css'],
  devtools: { enabled: true },
  modules: ['@comark/nuxt', '@nuxt/ui', '@nuxt/test-utils/module'],
  colorMode: {
    preference: 'dark',
    fallback: 'dark',
  },
  ui: {
    theme: {
      defaultVariants: {
        size: 'sm',
      },
    },
  },
  runtimeConfig: {
    lcc: {
      project: process.env.LCC_PROJECT || '',
      hours: Number(process.env.LCC_HOURS || 24),
    },
  },
  devServer: {
    host: process.env.HOST || '127.0.0.1',
  },
  app: {
    head: {
      htmlAttrs: { lang: 'en' },
      title: 'Claude + Codex Sessions — Live',
      meta: [
        { name: 'description', content: 'Local live view of Claude Code and Codex sessions' },
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
    typeCheck: true,
  },
})
