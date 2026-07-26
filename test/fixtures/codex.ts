import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

type RecordValue = Record<string, unknown>

export const C0 = (second = 0): string =>
  `2026-07-26T08:00:${String(second).padStart(2, '0')}.000Z`

export function sessionMeta(
  id: string,
  options: {
    ts?: string
    cwd?: string
    originator?: string
    source?: unknown
    threadSource?: string
  } = {},
): RecordValue {
  return {
    timestamp: options.ts || C0(),
    type: 'session_meta',
    payload: {
      id,
      timestamp: options.ts || C0(),
      cwd: options.cwd,
      originator: options.originator || 'codex-tui',
      cli_version: '0.146.0-test',
      source: options.source || 'cli',
      thread_source: options.threadSource || 'user',
      model_provider: 'openai',
      git: { branch: 'main' },
    },
  }
}

export function subagentSource(
  parentThreadId: string,
  options: { depth?: number, path?: string, nickname?: string, role?: string } = {},
): RecordValue {
  return {
    subagent: {
      thread_spawn: {
        parent_thread_id: parentThreadId,
        depth: options.depth ?? 1,
        agent_path: options.path || '/root/worker',
        agent_nickname: options.nickname || 'Worker',
        agent_role: options.role || 'worker',
      },
    },
  }
}

export function turnContext(
  options: { ts?: string, cwd?: string, model?: string, effort?: string } = {},
): RecordValue {
  return {
    timestamp: options.ts || C0(1),
    type: 'turn_context',
    payload: {
      turn_id: 'turn-1',
      cwd: options.cwd,
      model: options.model || 'gpt-5.6-test',
      effort: options.effort || 'high',
      approval_policy: 'never',
      sandbox_policy: { type: 'read-only' },
      workspace_roots: options.cwd ? [options.cwd] : [],
    },
  }
}

export function message(
  role: 'user' | 'assistant' | 'developer' | 'system',
  text: string,
  options: { ts?: string, phase?: string } = {},
): RecordValue {
  return {
    timestamp: options.ts || C0(2),
    type: 'response_item',
    payload: {
      type: 'message',
      role,
      content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
      ...(options.phase ? { phase: options.phase } : {}),
    },
  }
}

export function reasoning(text: string, ts = C0(3)): RecordValue {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: { type: 'reasoning', summary: [{ type: 'summary_text', text }] },
  }
}

export function toolCall(
  name: string,
  callId: string,
  input: RecordValue = {},
  options: { ts?: string, custom?: boolean } = {},
): RecordValue {
  return {
    timestamp: options.ts || C0(4),
    type: 'response_item',
    payload: options.custom
      ? { type: 'custom_tool_call', name, call_id: callId, input: JSON.stringify(input), status: 'completed' }
      : { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(input) },
  }
}

export function toolOutput(
  callId: string,
  output: unknown,
  options: { ts?: string, custom?: boolean } = {},
): RecordValue {
  return {
    timestamp: options.ts || C0(5),
    type: 'response_item',
    payload: options.custom
      ? { type: 'custom_tool_call_output', call_id: callId, output }
      : { type: 'function_call_output', call_id: callId, output },
  }
}

export function event(type: string, values: RecordValue = {}, ts = C0(6)): RecordValue {
  return { timestamp: ts, type: 'event_msg', payload: { type, ...values } }
}

export function rollout(
  records: RecordValue[],
  options: { malformed?: boolean, trailingPartial?: boolean } = {},
): string {
  return records.map(value => `${JSON.stringify(value)}\n`).join('')
    + (options.malformed ? '{"type":"response_item","payload":}\n' : '')
    + (options.trailingPartial ? '{"timestamp":"2026-07' : '')
}

export function writeRollout(
  path: string,
  records: RecordValue[],
  options: { malformed?: boolean, trailingPartial?: boolean } = {},
): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, rollout(records, options))
  return path
}

export function appendRecords(path: string, records: RecordValue[]): void {
  appendFileSync(path, records.map(value => `${JSON.stringify(value)}\n`).join(''))
}
