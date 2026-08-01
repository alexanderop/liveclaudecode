import type { SessionSource, Timestamp } from '#shared/types/run'

export function formatTime(timestamp: Timestamp, withSeconds = true): string {
  if (!timestamp) return ''
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
  })
}

export function formatCount(value: number): string | number {
  if (!value) return 0
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return value
}

export function formatUsd(value: number): string {
  if (!value) return '$0.00'
  if (value < 0.01) return `$${value.toFixed(3)}`
  return `$${value.toFixed(2)}`
}

export function secondsBetween(start: Timestamp, end: Timestamp): number {
  if (!start || !end) return 0
  return (new Date(end).getTime() - new Date(start).getTime()) / 1_000
}

export function formatDuration(start: Timestamp, end: Timestamp): string {
  const seconds = Math.round(secondsBetween(start, end))
  if (!seconds) return '0s'
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m${seconds % 60}s`
  return `${Math.floor(seconds / 3_600)}h${Math.floor((seconds % 3_600) / 60)}m`
}

export function formatMilliseconds(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1_000)
  if (seconds < 1) return `${Math.round(milliseconds)}ms`
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m${seconds % 60}s`
  return `${Math.floor(seconds / 3_600)}h${Math.floor((seconds % 3_600) / 60)}m`
}

/** Parses an ISO timestamp; `null` for missing or unparseable values. */
export function parseTimestamp(value: Timestamp | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export interface FormatRelativeAgeOptions {
  /**
   * Word placed before the age, e.g. `'Updated'` → `'Updated 5m ago'`.
   *
   * @default ''
   */
  prefix?: string
  /**
   * Text returned when no timestamp is known.
   *
   * @default 'No event'
   */
  noneLabel?: string
}

/**
 * Human relative age of an activity timestamp, e.g. `'Now'`, `'12s ago'`,
 * `'3m ago'`, `'2h ago'`.
 */
export function formatRelativeAge(
  milliseconds: number | null,
  options: FormatRelativeAgeOptions = {},
): string {
  const { prefix = '', noneLabel = 'No event' } = options
  if (milliseconds === null) return noneLabel
  const seconds = Math.floor(milliseconds / 1_000)
  const minutes = Math.floor(seconds / 60)
  const age = seconds < 5
    ? 'now'
    : seconds < 60
      ? `${seconds}s ago`
      : minutes < 60
        ? `${minutes}m ago`
        : `${Math.floor(minutes / 60)}h ago`
  if (!prefix) return age === 'now' ? 'Now' : age
  return `${prefix} ${age}`
}

/** Display name of a transcript source; `'Local'` when none is known. */
export function sessionSourceLabel(source: SessionSource | null | undefined): string {
  if (source === 'claude') return 'Claude'
  if (source === 'codex') return 'Codex'
  if (source === 'copilot') return 'Copilot'
  return 'Local'
}
