/**
 * Electron entry point for the desktop shell.
 *
 * The shell starts the same bundled Nitro server the CLI runs, inside this
 * process, and points a hardened window at it. No renderer code is trusted
 * with Node: there is no preload bridge, the renderer is sandboxed and context
 * isolated, and navigation away from the dashboard is handed to the operating
 * system browser instead. Testable logic lives in `electron/desktop.js`.
 */

import process from 'node:process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { BrowserWindow, app, dialog, session, shell } from 'electron'
import {
  DEFAULT_WINDOW,
  contentSecurityPolicy,
  inlineScriptHashes,
  isExternalUrl,
  isInternalUrl,
  parseDesktopOptions,
  startDashboard,
  unpackedAppPath,
} from './desktop.js'

/** Permissions the dashboard legitimately asks for; everything else is denied. */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write'])

let mainWindow = null
let dashboardUrl = ''

function openExternal(url) {
  if (isExternalUrl(url)) void shell.openExternal(url)
}

function hardenWebContents(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (dashboardUrl && isInternalUrl(url, dashboardUrl)) return
    event.preventDefault()
    openExternal(url)
  })
  contents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
}

/**
 * Hash the inline scripts Nuxt bootstraps with so the policy can name them.
 * A document we cannot read falls back to the looser inline allowance rather
 * than shipping a window that refuses to hydrate.
 */
async function pinnedScriptHashes(url) {
  try {
    return inlineScriptHashes(await (await fetch(url)).text())
  } catch {
    return []
  }
}

function hardenSession(target, { dev, scriptHashes }) {
  const policy = contentSecurityPolicy({ dev, scriptHashes })
  target.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission))
  })
  target.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission))
  target.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [policy] },
    })
  })
}

function createWindow(url) {
  const window = new BrowserWindow({
    ...DEFAULT_WINDOW,
    show: false,
    title: 'liveclaudecode',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  })
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    mainWindow = null
  })
  void window.loadURL(url)
  return window
}

function fail(error) {
  const message = error instanceof Error ? error.stack || error.message : String(error)
  console.error(message)
  dialog.showErrorBox('liveclaudecode', error instanceof Error ? error.message : String(error))
  app.exit(1)
}

async function bootstrap() {
  const options = parseDesktopOptions(process.env)
  const dev = Boolean(options.devServerUrl)
  const serverEntry = join(unpackedAppPath(app.getAppPath()), '.output', 'server', 'index.mjs')
  if (!dev && !existsSync(serverEntry)) {
    fail(`The dashboard build is missing at ${serverEntry}.\n\nRun "pnpm build" before starting the desktop app.`)
    return
  }

  await app.whenReady()
  app.on('web-contents-created', (_event, contents) => hardenWebContents(contents))

  dashboardUrl = await startDashboard(options, {
    env: process.env,
    createServer,
    fetch: url => fetch(url),
    sleep,
    importServer: () => import(pathToFileURL(serverEntry).href),
  })
  hardenSession(session.defaultSession, {
    dev,
    scriptHashes: dev ? [] : await pinnedScriptHashes(dashboardUrl),
  })
  mainWindow = createWindow(dashboardUrl)
}

if (app.requestSingleInstanceLock()) {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('activate', () => {
    if (dashboardUrl && BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow(dashboardUrl)
    }
  })
  bootstrap().catch(fail)
} else {
  app.quit()
}
