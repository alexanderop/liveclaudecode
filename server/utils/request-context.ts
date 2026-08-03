import type { H3Event } from 'h3'
import { getQuery } from 'h3'
import { parseHours } from '#shared/schemas/request'

export interface BrowserOptions {
  project: string
  hours: number
}

function browserOptions(
  configured: { project?: unknown, hours?: unknown },
  requestedHours: unknown,
): BrowserOptions {
  return {
    project: String(configured.project || ''),
    hours: parseHours(configured.hours, requestedHours),
  }
}

export function browserOptionsFor(event: H3Event): BrowserOptions {
  return browserOptions(useRuntimeConfig(event).lcc, getQuery(event).hours)
}

/**
 * What the browser asks for before it has asked for anything: no `hours`
 * override, so the configured range applies. This is the exact catalog key a
 * first page load produces, which is what makes it worth warming.
 */
export function defaultBrowserOptions(): BrowserOptions {
  return browserOptions(useRuntimeConfig().lcc, undefined)
}
