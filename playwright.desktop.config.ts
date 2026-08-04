import process from 'node:process'
import { defineConfig } from '@playwright/test'

/**
 * The desktop shell starts its own Nitro server inside the Electron main
 * process, so this suite has no `webServer`. It runs serially: one Electron
 * instance at a time keeps the single-instance lock meaningful.
 */
export default defineConfig({
  testDir: './test/desktop',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  timeout: 60_000,
})
