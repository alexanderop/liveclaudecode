/**
 * Host-agnostic logic for the desktop shell.
 *
 * Everything here is free of Electron imports so it can be unit tested in a
 * plain Node environment; `electron/main.js` supplies the real Electron and
 * Node dependencies. Keep `electron/desktop.d.ts` in sync with this file.
 */

import { createHash } from 'node:crypto'

export const DEFAULT_HOURS = 168
export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_WINDOW = { width: 1440, height: 900, minWidth: 960, minHeight: 600 }

const READY_ATTEMPTS = 150
const READY_INTERVAL_MS = 100

function readNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function readPort(value) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) return 0
  return parsed
}

/**
 * Read desktop options from the environment. Unknown arguments are ignored
 * rather than rejected: Chromium and Electron add their own switches to
 * `process.argv`, so the desktop shell is configured through the same
 * `LCC_*` variables the CLI already exports.
 */
export function parseDesktopOptions(env = {}) {
  return {
    project: env.LCC_PROJECT || env.NUXT_LCC_PROJECT || '',
    hours: readNumber(env.LCC_HOURS ?? env.NUXT_LCC_HOURS, DEFAULT_HOURS),
    host: env.LCC_HOST || DEFAULT_HOST,
    port: readPort(env.LCC_PORT),
    devServerUrl: env.LCC_DEV_SERVER_URL || '',
  }
}

/**
 * Locate the application files outside an asar archive.
 *
 * Electron patches `fs` to read through `app.asar`, but Node's ESM resolver
 * looks up the `package.json` of a bare import without that patch, so a server
 * bundle imported from inside the archive cannot resolve its dependencies. The
 * packaged build keeps `.output` unpacked next to the archive for that reason.
 */
export function unpackedAppPath(appPath) {
  return appPath.endsWith('.asar') ? `${appPath}.unpacked` : appPath
}

/** Whether `url` stays inside the dashboard the window was opened on. */
export function isInternalUrl(url, origin) {
  try {
    return new URL(url).origin === new URL(origin).origin
  } catch {
    return false
  }
}

/** Whether `url` is safe to hand to the operating system's browser. */
export function isExternalUrl(url) {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

/** Script types the browser actually executes; anything else is inert data. */
const EXECUTABLE_SCRIPT_TYPES = new Set([
  '',
  'module',
  'text/javascript',
  'application/javascript',
  'text/ecmascript',
  'application/ecmascript',
])

const INLINE_SCRIPT = /<script(?![^>]*\ssrc=)([^>]*)>([\s\S]*?)<\/script>/gi
const SCRIPT_TYPE = /\stype\s*=\s*["']?([^"'\s>]+)/i

/**
 * Hash the executable inline scripts in a server-rendered document so the
 * policy can name them instead of allowing every inline script.
 *
 * Nuxt inlines two of them — the colour-mode bootstrap and the app config —
 * and both are constant for a build, so hashing the entry document covers
 * every route. Payloads ride in `application/json` blocks, which never run.
 */
export function inlineScriptHashes(html) {
  const hashes = new Set()
  for (const [, attributes, body] of html.matchAll(INLINE_SCRIPT)) {
    const type = (SCRIPT_TYPE.exec(attributes)?.[1] ?? '').toLowerCase()
    if (!EXECUTABLE_SCRIPT_TYPES.has(type)) continue
    if (!body.trim()) continue
    hashes.add(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`)
  }
  return [...hashes]
}

/**
 * Content-Security-Policy for the dashboard window.
 *
 * Scripts are pinned to the app's own origin plus the hashes of Nuxt's inline
 * bootstrap; `'unsafe-inline'` is only the fallback for when no hash could be
 * derived. Server-rendered styles are inlined by Nuxt and cannot be pinned the
 * same way, so `style-src` keeps `'unsafe-inline'`. The Vite dev server needs
 * eval and a websocket on top of that.
 */
export function contentSecurityPolicy({ dev = false, scriptHashes = [] } = {}) {
  const pinned = scriptHashes.length ? scriptHashes.join(' ') : "'unsafe-inline'"
  const script = dev ? "'self' 'unsafe-inline' 'unsafe-eval'" : `'self' ${pinned}`
  const connect = dev ? "'self' ws: wss:" : "'self'"
  return [
    "default-src 'none'",
    `script-src ${script}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connect}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}

/** Ask the operating system for a port nobody is listening on. */
export function findFreePort({ createServer, host = DEFAULT_HOST }) {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen({ port: 0, host }, () => {
      const address = server.address()
      const port = address && typeof address === 'object' ? address.port : 0
      server.close(() => {
        if (port) resolve(port)
        else reject(new Error('Could not reserve a port for the dashboard server'))
      })
    })
  })
}

/**
 * Export the options the Nitro server reads on startup into `env`. Nitro reads
 * these once the server module is imported, so this must run first.
 */
export function applyServerEnvironment(options, port, env) {
  env.HOST = options.host
  env.PORT = String(port)
  env.NITRO_HOST = options.host
  env.NITRO_PORT = String(port)
  env.LCC_PROJECT = options.project
  env.NUXT_LCC_PROJECT = options.project
  env.LCC_HOURS = String(options.hours)
  env.NUXT_LCC_HOURS = String(options.hours)
}

/** Poll `url` until it answers, so the window never loads a dead port. */
export async function waitForServer(url, { fetch, sleep, attempts = READY_ATTEMPTS, intervalMs = READY_INTERVAL_MS }) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fetch(url)
      return
    } catch (error) {
      lastError = error
    }
    await sleep(intervalMs)
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`Dashboard server did not start at ${url}: ${reason}`)
}

/**
 * Bring up the dashboard the window should load and return its base URL.
 *
 * With `devServerUrl` set the shell attaches to an already running `nuxt dev`;
 * otherwise it starts the bundled Nitro server inside this process, which
 * keeps the desktop app to a single process and needs no Node on `PATH`.
 */
export async function startDashboard(options, deps) {
  if (options.devServerUrl) {
    await waitForServer(options.devServerUrl, deps)
    return options.devServerUrl
  }
  const port = options.port || await findFreePort({ createServer: deps.createServer, host: options.host })
  applyServerEnvironment(options, port, deps.env)
  const url = `http://${options.host}:${port}`
  await deps.importServer()
  await waitForServer(url, deps)
  return url
}
