/**
 * Hand-written declarations for `electron/desktop.js`, which ships as plain
 * JavaScript because Electron loads it without a build step. Keep in sync with
 * the implementation next to this file.
 */

import type { Server } from 'node:net'

export interface DesktopOptions {
  /** Repo path or Claude project-storage slug to watch; empty watches everything. */
  project: string
  /** Only surface runs touched within this many hours. */
  hours: number
  /** Loopback interface the bundled server binds to. */
  host: string
  /** Fixed port, or `0` to reserve a free one at startup. */
  port: number
  /** Attach to an already running dev server instead of starting Nitro. */
  devServerUrl: string
}

export interface StartDashboardDeps {
  /** Environment the Nitro server reads its configuration from. */
  env: Record<string, string | undefined>
  /** `node:net` server factory used to reserve a free port. */
  createServer: () => Server
  /** Probe used to detect that the server accepts connections. */
  fetch: (url: string) => Promise<unknown>
  /** Delay between readiness probes. */
  sleep: (milliseconds: number) => Promise<void>
  /** Loads the built Nitro entry, which starts listening as a side effect. */
  importServer: () => Promise<unknown>
  /** Number of readiness probes before giving up. */
  attempts?: number
  /** Milliseconds between readiness probes. */
  intervalMs?: number
}

export interface WindowDefaults {
  width: number
  height: number
  minWidth: number
  minHeight: number
}

export const DEFAULT_HOURS: number
export const DEFAULT_HOST: string
export const DEFAULT_WINDOW: WindowDefaults

export function parseDesktopOptions(env?: Record<string, string | undefined>): DesktopOptions
export function unpackedAppPath(appPath: string): string
export function isInternalUrl(url: string, origin: string): boolean
export function isExternalUrl(url: string): boolean
export function inlineScriptHashes(html: string): string[]
export function contentSecurityPolicy(options?: { dev?: boolean, scriptHashes?: ReadonlyArray<string> }): string
export function findFreePort(deps: { createServer: () => Server, host?: string }): Promise<number>
export function applyServerEnvironment(
  options: DesktopOptions,
  port: number,
  env: Record<string, string | undefined>,
): void
export function waitForServer(
  url: string,
  deps: Pick<StartDashboardDeps, 'fetch' | 'sleep' | 'attempts' | 'intervalMs'>,
): Promise<void>
export function startDashboard(options: DesktopOptions, deps: StartDashboardDeps): Promise<string>
