import type { Timestamp } from '#shared/types/run'

export const TOOL_ICONS: Record<string, string> = {
  Read: '📖',
  Glob: '🔍',
  Grep: '🔍',
  Edit: '✏️',
  Write: '✏️',
  MultiEdit: '✏️',
  NotebookEdit: '✏️',
  Bash: '⌘',
  Agent: '⇄',
  Task: '⇄',
  Skill: '⚡',
  TodoWrite: '☑',
  WebFetch: '🌐',
  WebSearch: '🌐',
}

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
