import { Effect, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'

type RecordValue = Record<string, unknown>

export const T0 = (second = 0): string =>
  `2026-07-30T08:00:${String(second).padStart(2, '0')}.000Z`

export function event(type: string, data: RecordValue, second = 0): RecordValue {
  return {
    type,
    data,
    id: `event-${second}`,
    timestamp: T0(second),
    parentId: second === 0 ? null : `event-${second - 1}`,
  }
}

export function sessionStart(id = 'session-1', second = 0): RecordValue {
  return event('session.start', {
    sessionId: id,
    version: 1,
    producer: 'copilot-agent',
    copilotVersion: '1.0.75-test',
    startTime: T0(second),
    context: { cwd: '/repo', gitRoot: '/repo', branch: 'main' },
  }, second)
}

export function modelChange(model = 'claude-sonnet-4.5', second = 1): RecordValue {
  return event('session.model_change', {
    newModel: model,
    reasoningEffort: 'high',
    contextTier: null,
  }, second)
}

export function userMessage(content: string, second = 2): RecordValue {
  return event('user.message', {
    content,
    transformedContent: content,
    attachments: [],
    interactionId: 'interaction-1',
  }, second)
}

export function turnStart(turnId = 'turn-1', second = 3): RecordValue {
  return event('assistant.turn_start', { turnId, interactionId: 'interaction-1' }, second)
}

export function assistantMessage(options: {
  content?: string
  reasoning?: string
  toolRequests?: unknown[]
  outputTokens?: number
  second?: number
} = {}): RecordValue {
  return event('assistant.message', {
    messageId: 'message-1',
    model: 'claude-sonnet-4.5',
    content: options.content || '',
    reasoningText: options.reasoning,
    outputTokens: options.outputTokens ?? 17,
    requestId: 'request-1',
    toolRequests: options.toolRequests || [],
  }, options.second ?? 4)
}

export function toolRequest(name: string, toolCallId: string, arguments_: unknown): RecordValue {
  return { toolCallId, name, arguments: arguments_, type: 'function', intentionSummary: `Run ${name}` }
}

export function toolStart(name: string, toolCallId: string, arguments_: unknown, second = 5): RecordValue {
  return event('tool.execution_start', { toolCallId, toolName: name, arguments: arguments_ }, second)
}

export function toolComplete(
  toolCallId: string,
  options: { success?: boolean, error?: unknown, content?: string, second?: number } = {},
): RecordValue {
  return event('tool.execution_complete', {
    toolCallId,
    model: 'claude-sonnet-4.5',
    ...(options.success === undefined ? {} : { success: options.success }),
    ...(options.error === undefined ? {} : { error: options.error }),
    result: { content: options.content || '', detailedContent: options.content || '' },
  }, options.second ?? 6)
}

export function turnEnd(turnId = 'turn-1', second = 7): RecordValue {
  return event('assistant.turn_end', { turnId }, second)
}

export function shutdown(second = 8): RecordValue {
  return event('session.shutdown', { shutdownType: 'normal', currentModel: 'claude-sonnet-4.5' }, second)
}

export function abort(reason = 'stopped by user', second = 8): RecordValue {
  return event('abort', { reason }, second)
}

export function jsonl(
  records: RecordValue[],
  options: { malformed?: boolean, trailingPartial?: boolean } = {},
): string {
  return records.map(record => `${JSON.stringify(record)}\n`).join('')
    + (options.malformed ? '{"type":"assistant.message","data":}\n' : '')
    + (options.trailingPartial ? '{"type":"user.message"' : '')
}

export function mutableEventFile(path: string, initial: string, initialMtime = 1): {
  layer: ReturnType<typeof FileSystem.layerNoop>
  update: (content: string, mtime?: number) => void
} {
  let content = initial
  let mtime = initialMtime
  return {
    layer: FileSystem.layerNoop({
      readFileString: candidate => candidate === path
        ? Effect.succeed(content)
        : Effect.die(new Error(`unexpected path: ${candidate}`)),
      stat: candidate => candidate === path
        ? Effect.succeed({
            type: 'File',
            mtime: Option.some(new Date(mtime * 1_000)),
            size: FileSystem.Size(Buffer.byteLength(content)),
          } as FileSystem.File.Info)
        : Effect.die(new Error(`unexpected path: ${candidate}`)),
    }),
    update: (next, nextMtime = mtime + 1) => {
      content = next
      mtime = nextMtime
    },
  }
}
