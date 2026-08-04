import { fileURLToPath } from 'node:url'
import { defineVitestProject } from '@nuxt/test-utils/config'
import { defineConfig } from 'vitest/config'

const rootDir = fileURLToPath(new URL('.', import.meta.url))

const alias = {
  '~': `${rootDir}app`,
  '~~': rootDir,
  '#shared': `${rootDir}shared`,
  '#server': `${rootDir}server`,
}

const hygiene = {
  restoreMocks: true,
  unstubGlobals: true,
  unstubEnvs: true,
}

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['test/unit/**/*.{test,spec}.ts'],
          environment: 'node',
          ...hygiene,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.{test,spec}.ts'],
          environment: 'node',
          // Empties the route-coverage ledger the specs record into.
          globalSetup: ['test/fixtures/route-coverage.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          ...hygiene,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'gate',
          include: ['test/gate/**/*.{test,spec}.ts'],
          environment: 'node',
          // A later group than the default 0, so every e2e spec has finished
          // recording into the route-coverage ledger before the gate reads it.
          sequence: { groupOrder: 1 },
          ...hygiene,
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
          ...hygiene,
        },
      }),
    ],
  },
})
