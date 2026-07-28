import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const T0 = (second = 0): string => `2026-07-25T18:00:${String(second).padStart(2, '0')}.000Z`

type RecordValue = Record<string, unknown>

function record(value: RecordValue): RecordValue {
  return { cwd: '/repo', ...value }
}

export function assistant(
  blocks: RecordValue[],
  options: {
    ts?: string
    usage?: RecordValue
    model?: string
    stopReason?: string | null
    extra?: RecordValue
  } = {},
): RecordValue {
  const message: RecordValue = {
    content: blocks,
    model: options.model || 'claude-opus-5',
  }
  if (options.usage) message.usage = options.usage
  if (options.stopReason !== undefined) message.stop_reason = options.stopReason
  return record({ type: 'assistant', timestamp: options.ts || T0(), message, ...options.extra })
}

export function userResult(
  toolUseId: string,
  content: unknown,
  options: { ts?: string, isError?: boolean, toolUseResult?: RecordValue, extra?: RecordValue } = {},
): RecordValue {
  return record({
    type: 'user',
    timestamp: options.ts || T0(1),
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content,
        is_error: options.isError || false,
      }],
    },
    ...(options.toolUseResult ? { toolUseResult: options.toolUseResult } : {}),
    ...options.extra,
  })
}

export function system(subtype: string, values: RecordValue = {}): RecordValue {
  return record({ type: 'system', subtype, timestamp: T0(2), ...values })
}

export function attachment(type: string, values: RecordValue = {}): RecordValue {
  return record({ type: 'attachment', timestamp: T0(2), attachment: { type, ...values } })
}

export function userText(value: string, options: { ts?: string, meta?: boolean } = {}): RecordValue {
  return record({
    type: 'user',
    timestamp: options.ts || T0(),
    message: { content: [{ type: 'text', text: value }] },
    ...(options.meta ? { isMeta: true } : {}),
  })
}

export function text(value: string): RecordValue {
  return { type: 'text', text: value }
}

export function tool(name: string, id: string, input: RecordValue = {}): RecordValue {
  return { type: 'tool_use', id, name, input }
}

/**
 * Serialise records as JSONL without touching the disk, for use with the
 * in-memory FileSystem layer.
 */
export function transcript(
  records: RecordValue[],
  options: { trailingPartial?: boolean } = {},
): string {
  return records.map(value => `${JSON.stringify(value)}\n`).join('')
    + (options.trailingPartial ? '{"type":"assistant","message":{"conte' : '')
}

export function writeTranscript(
  path: string,
  records: RecordValue[],
  options: { trailingPartial?: boolean } = {},
): string {
  mkdirSync(dirname(path), { recursive: true })
  const body = records.map(value => `${JSON.stringify(value)}\n`).join('')
    + (options.trailingPartial ? '{"type":"assistant","message":{"conte' : '')
  writeFileSync(path, body)
  return path
}

export function appendRecords(path: string, records: RecordValue[]): void {
  appendFileSync(path, records.map(value => `${JSON.stringify(value)}\n`).join(''))
}

export function writeSubagent(
  sessionDirectory: string,
  agentId: string,
  records: RecordValue[],
  meta: RecordValue,
): string {
  const subagents = join(sessionDirectory, 'subagents')
  mkdirSync(subagents, { recursive: true })
  const path = writeTranscript(join(subagents, `${agentId}.jsonl`), records)
  writeFileSync(join(subagents, `${agentId}.meta.json`), JSON.stringify(meta))
  return path
}
