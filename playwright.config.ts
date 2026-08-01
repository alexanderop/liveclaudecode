import process from 'node:process'
import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

const baseURL = 'http://127.0.0.1:5678'
const fixturesDirectory = join(import.meta.dirname, 'test/fixtures/browser')

export default defineConfig({
  testDir: './test/browser',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  timeout: 30_000,
  webServer: {
    command: 'pnpm preview --port 5678',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      ...process.env,
      LCC_PROJECT: fixturesDirectory,
      NUXT_LCC_PROJECT: fixturesDirectory,
      LCC_CODEX_SESSIONS: join(fixturesDirectory, 'missing-codex'),
      LCC_VSCODE_USER_DATA: join(fixturesDirectory, 'missing-vscode'),
      LCC_HOURS: '99999',
      NUXT_LCC_HOURS: '99999',
    },
  },
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [{
    name: 'chromium',
    use: { ...devices['Desktop Chrome'] },
  }],
})
