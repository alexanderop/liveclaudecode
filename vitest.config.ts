import { fileURLToPath } from 'node:url'
import { defineVitestProject } from '@nuxt/test-utils/config'
import { defineConfig } from 'vitest/config'

const rootDir = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '~': `${rootDir}app`,
      '~~': rootDir,
      '#shared': `${rootDir}shared`,
      '#server': `${rootDir}server`,
    },
  },
  test: {
    projects: [
      {
        resolve: {
          alias: {
            '~': `${rootDir}app`,
            '~~': rootDir,
            '#shared': `${rootDir}shared`,
            '#server': `${rootDir}server`,
          },
        },
        test: {
          name: 'unit',
          include: ['test/unit/**/*.{test,spec}.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.{test,spec}.ts'],
          environment: 'node',
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      await defineVitestProject({
        test: {
          name: 'nuxt',
          include: ['test/nuxt/**/*.{test,spec}.ts'],
          environment: 'nuxt',
          environmentOptions: {
            nuxt: { rootDir },
          },
        },
      }),
    ],
  },
})
