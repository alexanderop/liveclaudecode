import { Predicate } from 'effect'
import type { DiagnosticIncident, Milestone, Timestamp } from '#shared/types/run'
import { findMilestones } from './transcript-content'

/**
 * Helpers shared by the four transcript scanners (Claude, Codex, Copilot
 * VS Code, Copilot CLI). Plain, effect-free functions only — the scanners
 * themselves own the mutable state and any effectful I/O.
 */

/** Per-path bookkeeping for edited files, keyed by their short display path. */
export interface MutableFileChange {
  ops: number
  tools: string[]
  lastTs: Timestamp
}

/** Record one more operation against `key` in `files`, creating the entry if needed. */
export function recordFileChange(
  files: Map<string, MutableFileChange>,
  key: string,
  tool: string,
  ts: Timestamp,
): void {
  const change = files.get(key) || { ops: 0, tools: [], lastTs: ts }
  change.ops += 1
  change.lastTs = ts
  if (!change.tools.includes(tool)) change.tools.push(tool)
  files.set(key, change)
}

/** Compact arbitrary JSON-ish content (objects or strings) into a single-line preview. */
export function compactText(value: unknown, limit = 240): string {
  if (typeof value === 'string') return value.trim().replace(/\s+/g, ' ').slice(0, limit)
  if (!Predicate.isObject(value)) return ''
  try {
    return JSON.stringify(value).replace(/\s+/g, ' ').slice(0, limit)
  } catch {
    return ''
  }
}

/** Compact a known string into a single-line preview. */
export function compact(value: string, limit = 240): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, limit)
}

/** Push `incident` onto `incidents`, deriving its id from position and category. */
export function pushIncident(
  incidents: DiagnosticIncident[],
  incident: Omit<DiagnosticIncident, 'id'>,
): void {
  incidents.push({ ...incident, id: `${incident.line}:${incident.category}:${incidents.length}` })
}

/** Append a milestone found in `text`, skipping a title that repeats the most recent one. */
export function recordMilestones(milestones: Milestone[], text: string, ts: Timestamp): void {
  for (const [title, strong] of findMilestones(text)) {
    if (milestones.at(-1)?.title !== title) {
      milestones.push({ title: title.slice(0, 90), ts, strong })
    }
  }
}

/** Sum tool-use counts and the subset matching `readTools`, as used by `statsAt`. */
export function toolStatsFromCounts(
  counts: Record<string, number>,
  readTools: ReadonlySet<string>,
): { tools: number, reads: number } {
  const tools = Object.values(counts).reduce((total, count) => total + count, 0)
  const reads = Object.entries(counts)
    .filter(([name]) => readTools.has(name))
    .reduce((total, [, count]) => total + count, 0)
  return { tools, reads }
}

/** Split raw JSONL text into its complete lines, dropping the trailing partial line. */
export function completeJsonlLines(raw: string): string[] {
  return raw.split('\n').slice(0, -1)
}

export interface MalformedJsonlLine {
  index: number
  line: string
}

/**
 * Parse `lines[fromIndex..]` as JSON, skipping blank lines. Lines that fail to
 * parse are reported in `malformed` (with their raw text, for diagnosability)
 * instead of being silently dropped — the caller decides how to log and count
 * them, since only it runs inside an effectful context.
 */
export function parseJsonlValues(
  lines: ReadonlyArray<string>,
  fromIndex = 0,
): { values: Array<[index: number, value: unknown]>, malformed: MalformedJsonlLine[] } {
  const values: Array<[number, unknown]> = []
  const malformed: MalformedJsonlLine[] = []
  for (let index = fromIndex; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line?.trim()) continue
    try {
      values.push([index, JSON.parse(line) as unknown])
    } catch {
      malformed.push({ index, line })
    }
  }
  return { values, malformed }
}
