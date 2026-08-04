import type { ElectronApplication, Page } from '@playwright/test'
import process from 'node:process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, test } from '@playwright/test'

const rootDirectory = fileURLToPath(new URL('../..', import.meta.url))
const fixturesDirectory = join(rootDirectory, 'test', 'fixtures', 'browser')

const hydrationPatterns = [
  'Hydration completed but contains mismatches',
  'Hydration text content mismatch',
  'Hydration node mismatch',
]

/** Scratch space the main process records `shell.openExternal` calls in. */
type MainGlobals = typeof globalThis & { openedExternally?: string[] }

/** `getLastWebPreferences` is documented but missing from Electron's typings. */
interface InspectableWebContents {
  getLastWebPreferences: () => Record<string, unknown> | null
}

test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
let userDataDirectory: string
const consoleErrors: string[] = []

test.beforeAll(async () => {
  // A throwaway profile keeps the single-instance lock from colliding with a
  // real liveclaudecode window the developer may already have open.
  userDataDirectory = await mkdtemp(join(tmpdir(), 'lcc-desktop-'))
  app = await electron.launch({
    args: [rootDirectory, `--user-data-dir=${userDataDirectory}`],
    env: {
      ...process.env,
      LCC_PROJECT: fixturesDirectory,
      LCC_HOURS: '99999',
      LCC_CODEX_SESSIONS: join(fixturesDirectory, 'missing-codex'),
      LCC_VSCODE_USER_DATA: join(fixturesDirectory, 'missing-vscode'),
      LCC_DEV_SERVER_URL: '',
      LCC_PORT: '',
    },
  })

  page = await app.firstWindow()
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  await page.reload({ waitUntil: 'networkidle' })

  // Record what the shell would have handed to the operating system browser.
  await app.evaluate(({ shell }) => {
    const globals = globalThis as MainGlobals
    globals.openedExternally = []
    shell.openExternal = (url: string) => {
      globals.openedExternally?.push(url)
      return Promise.resolve()
    }
  })
})

test.afterAll(async () => {
  await app?.close()
  if (userDataDirectory) await rm(userDataDirectory, { recursive: true, force: true })
})

test('serves the dashboard from the Nitro server inside the main process', async () => {
  await expect(page.getByRole('heading', { name: 'Verify the browser dashboard', exact: true })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Session views' })).toBeVisible()

  const url = new URL(page.url())
  expect(url.protocol).toBe('http:')
  expect(url.hostname).toBe('127.0.0.1')

  const tree = await page.evaluate(async () => {
    const response = await fetch('/api/tree')
    const body = (await response.json()) as { projects?: { roots?: unknown[] }[] }
    return { status: response.status, roots: body.projects?.flatMap(project => project.roots ?? []).length ?? 0 }
  })
  expect(tree.status).toBe(200)
  expect(tree.roots).toBeGreaterThan(0)
})

test('runs the window sandboxed, context isolated, and without Node', async () => {
  const preferences = await app.evaluate(({ BrowserWindow }) => {
    const [window] = BrowserWindow.getAllWindows()
    const contents = window?.webContents as unknown as InspectableWebContents | undefined
    return contents?.getLastWebPreferences() ?? null
  })

  expect(preferences).toMatchObject({
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webviewTag: false,
  })

  const renderer = await page.evaluate(() => ({
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    module: typeof (window as unknown as { module?: unknown }).module,
  }))
  expect(renderer).toEqual({ require: 'undefined', process: 'undefined', module: 'undefined' })
})

test('applies a content security policy the dashboard does not violate', async () => {
  const policy = await page.evaluate(async () => {
    const response = await fetch(window.location.href)
    return response.headers.get('content-security-policy') ?? ''
  })
  const directives = new Map(
    policy.split(';').map(directive => directive.trim()).filter(Boolean)
      .map(directive => [directive.split(/\s+/)[0]!, directive] as const),
  )

  expect(directives.get('default-src')).toBe("default-src 'none'")
  expect(directives.get('connect-src')).toBe("connect-src 'self'")
  expect(directives.get('frame-ancestors')).toBe("frame-ancestors 'none'")
  // Nuxt's inline bootstrap is named by hash rather than blanket-allowed.
  expect(directives.get('script-src')).toMatch(/^script-src 'self' 'sha256-/)
  expect(directives.get('script-src')).not.toContain('unsafe')

  expect(consoleErrors.filter(error => error.includes('Content Security Policy'))).toEqual([])
  expect(consoleErrors.filter(error => hydrationPatterns.some(pattern => error.includes(pattern)))).toEqual([])
})

test('denies popups and off-origin navigation, handing them to the system browser', async () => {
  await page.evaluate(() => {
    window.open('https://example.com/popup', '_blank')
  })
  await expect.poll(() => app.evaluate(() => (globalThis as MainGlobals).openedExternally ?? []))
    .toContain('https://example.com/popup')
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)

  const before = page.url()
  await page.evaluate(() => {
    window.location.href = 'https://example.com/navigate'
  })
  await expect.poll(() => app.evaluate(() => (globalThis as MainGlobals).openedExternally ?? []))
    .toContain('https://example.com/navigate')
  expect(page.url()).toBe(before)

  // Non-web schemes never reach the operating system.
  await page.evaluate(() => {
    window.open('file:///etc/passwd', '_blank')
  })
  const opened = await app.evaluate(() => (globalThis as MainGlobals).openedExternally ?? [])
  expect(opened.some(url => url.startsWith('file:'))).toBe(false)

  // The renderer is healthy after a cancelled navigation, but Playwright keeps
  // waiting on the navigation it saw start. Reloading resets its bookkeeping.
  await page.reload({ waitUntil: 'networkidle' })
})

test('keeps in-app navigation inside the window', async () => {
  await page.getByRole('navigation', { name: 'Session views' }).getByRole('button', { name: /Activity/ }).click()
  await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible()
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
})

test('denies permission requests the dashboard never needs', async () => {
  const camera = await page.evaluate(async () => {
    try {
      await navigator.mediaDevices.getUserMedia({ video: true })
      return 'granted'
    } catch (error) {
      return error instanceof Error ? error.name : 'denied'
    }
  })
  expect(camera).not.toBe('granted')

  const geolocation = await page.evaluate(() =>
    new Promise<string>((resolve) => {
      navigator.geolocation.getCurrentPosition(() => resolve('granted'), () => resolve('denied'))
    }),
  )
  expect(geolocation).toBe('denied')
})
