import type { Server } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import {
  applyServerEnvironment,
  contentSecurityPolicy,
  findFreePort,
  inlineScriptHashes,
  isExternalUrl,
  isInternalUrl,
  parseDesktopOptions,
  startDashboard,
  unpackedAppPath,
  waitForServer,
} from '../../electron/desktop'

/**
 * Minimal stand-in for `net.createServer()`; `findFreePort` only listens on an
 * ephemeral port, reads the address, and closes again.
 */
function portProbe(result: { port?: number, error?: Error }): () => Server {
  return () =>
    ({
      on(event: string, handler: (error: Error) => void) {
        if (event === 'error' && result.error) queueMicrotask(() => handler(result.error!))
      },
      listen(_options: unknown, ready: () => void) {
        if (!result.error) ready()
      },
      address() {
        return result.port === undefined ? null : { address: '127.0.0.1', family: 'IPv4', port: result.port }
      },
      close(done: () => void) {
        done()
      },
    }) as unknown as Server
}

const noSleep = () => Promise.resolve()

describe('desktop options', () => {
  it('watches every local session for the last seven days by default', () => {
    expect(parseDesktopOptions({})).toEqual({
      project: '',
      hours: 168,
      host: '127.0.0.1',
      port: 0,
      devServerUrl: '',
    })
  })

  it('reads the same variables the CLI exports', () => {
    expect(parseDesktopOptions({ LCC_PROJECT: '/repo', LCC_HOURS: '3', LCC_HOST: '0.0.0.0', LCC_PORT: '9000' }))
      .toMatchObject({ project: '/repo', hours: 3, host: '0.0.0.0', port: 9000 })
  })

  it('falls back to the Nuxt-prefixed variables', () => {
    expect(parseDesktopOptions({ NUXT_LCC_PROJECT: '/repo', NUXT_LCC_HOURS: '12' }))
      .toMatchObject({ project: '/repo', hours: 12 })
  })

  it('ignores unusable hours and ports instead of failing to launch', () => {
    expect(parseDesktopOptions({ LCC_HOURS: 'soon', LCC_PORT: '70000' })).toMatchObject({ hours: 168, port: 0 })
    expect(parseDesktopOptions({ LCC_HOURS: '-1', LCC_PORT: '0' })).toMatchObject({ hours: 168, port: 0 })
    expect(parseDesktopOptions({ LCC_HOURS: '', LCC_PORT: '' })).toMatchObject({ hours: 168, port: 0 })
  })

  it('attaches to a dev server when one is named', () => {
    expect(parseDesktopOptions({ LCC_DEV_SERVER_URL: 'http://127.0.0.1:3000' }))
      .toMatchObject({ devServerUrl: 'http://127.0.0.1:3000' })
  })
})

describe('application path', () => {
  it('steps outside an asar archive so Node can resolve the server bundle', () => {
    expect(unpackedAppPath('/Applications/liveclaudecode.app/Contents/Resources/app.asar'))
      .toBe('/Applications/liveclaudecode.app/Contents/Resources/app.asar.unpacked')
  })

  it('leaves an unpacked checkout alone', () => {
    expect(unpackedAppPath('/Users/me/liveclaudecode')).toBe('/Users/me/liveclaudecode')
    expect(unpackedAppPath('/Applications/liveclaudecode.app/Contents/Resources/app.asar.unpacked'))
      .toBe('/Applications/liveclaudecode.app/Contents/Resources/app.asar.unpacked')
  })
})

describe('navigation guards', () => {
  it('treats only the dashboard origin as internal', () => {
    expect(isInternalUrl('http://127.0.0.1:8787/runs/abc', 'http://127.0.0.1:8787')).toBe(true)
    expect(isInternalUrl('http://127.0.0.1:9999/runs/abc', 'http://127.0.0.1:8787')).toBe(false)
    expect(isInternalUrl('https://127.0.0.1:8787/', 'http://127.0.0.1:8787')).toBe(false)
    expect(isInternalUrl('https://example.com', 'http://127.0.0.1:8787')).toBe(false)
  })

  it('rejects malformed URLs rather than treating them as internal', () => {
    expect(isInternalUrl('not a url', 'http://127.0.0.1:8787')).toBe(false)
    expect(isInternalUrl('http://127.0.0.1:8787', 'not a url')).toBe(false)
  })

  it('only hands web URLs to the operating system browser', () => {
    expect(isExternalUrl('https://anthropic.com')).toBe(true)
    expect(isExternalUrl('http://example.com')).toBe(true)
    expect(isExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isExternalUrl('smb://share/payload')).toBe(false)
    expect(isExternalUrl('')).toBe(false)
  })
})

describe('inline script hashes', () => {
  it('hashes executable inline scripts and skips loaded or inert ones', () => {
    const hashes = inlineScriptHashes([
      '<script src="/_nuxt/entry.js" type="module"></script>',
      '<script>window.__NUXT__={}</script>',
      '<script type="module">import "./a.js"</script>',
      '<script type="application/json" id="__NUXT_DATA__">[{"a":1}]</script>',
      '<script type="speculationrules">{"prerender":[]}</script>',
      '<script>   </script>',
    ].join('\n'))

    expect(hashes).toHaveLength(2)
    expect(hashes.every(hash => /^'sha256-[\w+/]+={0,2}'$/.test(hash))).toBe(true)
  })

  it('produces the hash the browser computes for the script body', () => {
    // sha256 of `window.__NUXT__={}` — the value Chromium reports in its
    // violation message when the script is not allowed.
    expect(inlineScriptHashes('<script>window.__NUXT__={}</script>'))
      .toEqual(["'sha256-9t9kOTpBXQ6UK6UoTUcY2ezm5KT7oB5pbv8ZFsTUBAU='"])
  })

  it('collapses repeated scripts to one hash', () => {
    expect(inlineScriptHashes('<script>a()</script><script>a()</script>')).toHaveLength(1)
  })

  it('finds nothing in a document without inline scripts', () => {
    expect(inlineScriptHashes('<html><body>no scripts</body></html>')).toEqual([])
  })
})

describe('content security policy', () => {
  it('pins the packaged window to its own origin and known scripts', () => {
    const policy = contentSecurityPolicy({ scriptHashes: ["'sha256-abc='"] })
    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain("script-src 'self' 'sha256-abc='")
    expect(policy).toContain("connect-src 'self'")
    expect(policy).toContain("frame-ancestors 'none'")
    expect(policy).not.toContain('unsafe-eval')
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'")
  })

  it('degrades to inline scripts rather than a window that cannot hydrate', () => {
    expect(contentSecurityPolicy()).toContain("script-src 'self' 'unsafe-inline'")
  })

  it('allows what the Vite dev server needs, and only in dev', () => {
    const policy = contentSecurityPolicy({ dev: true })
    expect(policy).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'")
    expect(policy).toContain('ws:')
    expect(contentSecurityPolicy({ scriptHashes: ["'sha256-abc='"] })).not.toContain('ws:')
  })
})

describe('server environment', () => {
  it('exports the viewer options Nitro reads at startup', () => {
    const env: Record<string, string | undefined> = {}
    applyServerEnvironment({ project: '/repo', hours: 24, host: '127.0.0.1', port: 0, devServerUrl: '' }, 4321, env)
    expect(env).toEqual({
      HOST: '127.0.0.1',
      PORT: '4321',
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: '4321',
      LCC_PROJECT: '/repo',
      NUXT_LCC_PROJECT: '/repo',
      LCC_HOURS: '24',
      NUXT_LCC_HOURS: '24',
    })
  })
})

describe('free port', () => {
  it('reports the port the operating system handed out', async () => {
    await expect(findFreePort({ createServer: portProbe({ port: 5321 }) })).resolves.toBe(5321)
  })

  it('fails when no address is available', async () => {
    await expect(findFreePort({ createServer: portProbe({}) })).rejects.toThrow('Could not reserve a port')
  })

  it('surfaces listen errors', async () => {
    await expect(findFreePort({ createServer: portProbe({ error: new Error('EADDRINUSE') }) }))
      .rejects.toThrow('EADDRINUSE')
  })
})

describe('server readiness', () => {
  it('returns as soon as the server answers', async () => {
    const probe = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(new Response())
    const sleep = vi.fn(noSleep)

    await waitForServer('http://127.0.0.1:8787', { fetch: probe, sleep, attempts: 5, intervalMs: 10 })

    expect(probe).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledWith(10)
  })

  it('gives up with the last connection error attached', async () => {
    const probe = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))

    await expect(waitForServer('http://127.0.0.1:8787', { fetch: probe, sleep: noSleep, attempts: 3 }))
      .rejects.toThrow('Dashboard server did not start at http://127.0.0.1:8787: ECONNREFUSED')
    expect(probe).toHaveBeenCalledTimes(3)
  })
})

describe('starting the dashboard', () => {
  const deps = (env: Record<string, string | undefined>, port = 4321) => ({
    env,
    createServer: portProbe({ port }),
    fetch: vi.fn().mockResolvedValue(new Response()),
    sleep: noSleep,
    importServer: vi.fn().mockResolvedValue(undefined),
    attempts: 2,
  })

  it('reserves a port, configures Nitro, then loads it', async () => {
    const env: Record<string, string | undefined> = {}
    const dependencies = deps(env)
    dependencies.importServer.mockImplementation(() => {
      // Nitro reads its port the moment the module is imported.
      expect(env.NITRO_PORT).toBe('4321')
      return Promise.resolve(undefined)
    })

    const url = await startDashboard(
      { project: '/repo', hours: 48, host: '127.0.0.1', port: 0, devServerUrl: '' },
      dependencies,
    )

    expect(url).toBe('http://127.0.0.1:4321')
    expect(dependencies.importServer).toHaveBeenCalledTimes(1)
    expect(dependencies.fetch).toHaveBeenCalledWith('http://127.0.0.1:4321')
    expect(env.NUXT_LCC_PROJECT).toBe('/repo')
    expect(env.NUXT_LCC_HOURS).toBe('48')
  })

  it('honours a pinned port instead of reserving one', async () => {
    const env: Record<string, string | undefined> = {}
    const dependencies = { ...deps(env), createServer: portProbe({ error: new Error('should not be called') }) }

    const url = await startDashboard(
      { project: '', hours: 168, host: '127.0.0.1', port: 8787, devServerUrl: '' },
      dependencies,
    )

    expect(url).toBe('http://127.0.0.1:8787')
    expect(env.NITRO_PORT).toBe('8787')
  })

  it('attaches to a running dev server without starting Nitro', async () => {
    const env: Record<string, string | undefined> = {}
    const dependencies = deps(env)

    const url = await startDashboard(
      { project: '', hours: 168, host: '127.0.0.1', port: 0, devServerUrl: 'http://127.0.0.1:3000' },
      dependencies,
    )

    expect(url).toBe('http://127.0.0.1:3000')
    expect(dependencies.importServer).not.toHaveBeenCalled()
    expect(dependencies.fetch).toHaveBeenCalledWith('http://127.0.0.1:3000')
    expect(env).toEqual({})
  })

  it('fails loudly when the server never comes up', async () => {
    const env: Record<string, string | undefined> = {}
    const dependencies = { ...deps(env), fetch: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) }

    await expect(startDashboard(
      { project: '', hours: 168, host: '127.0.0.1', port: 0, devServerUrl: '' },
      dependencies,
    )).rejects.toThrow('Dashboard server did not start')
  })
})
