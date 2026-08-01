import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const T0 = 1_785_052_800_000

function clean<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export interface CopilotRequestOptions {
  timestamp?: number
  state?: number
  completedAt?: number
  agentId?: string
  mode?: string
  model?: string
  response?: unknown[]
  error?: { message: string, code?: string }
  elapsedMs?: number
  copilotMetadata?: boolean
  promptTokens?: number
  outputTokens?: number
}

export function markdown(value: string): unknown {
  return { value, supportHtml: true, supportThemeIcons: true }
}

export function thinking(value: string, id = 'thinking-1'): unknown {
  return { kind: 'thinking', id, value }
}

export function tool(
  toolId: string,
  toolCallId: string,
  options: {
    complete?: boolean
    command?: string | {
      original?: string
      toolEdited?: string
      forDisplay?: string
      isSandboxWrapped?: boolean
    }
    exitCode?: number
    isError?: boolean
    message?: string
    todoList?: Array<{ title: string, status: string }>
  } = {},
): unknown {
  const specific = options.command === undefined && !options.todoList
    ? undefined
    : options.todoList
      ? { kind: 'todoList', todoList: options.todoList }
      : {
          kind: 'terminal',
          commandLine: options.command,
          terminalCommandState: options.exitCode === undefined
            ? undefined
            : { exitCode: options.exitCode, timestamp: T0 + 2_000 },
        }
  return clean({
    kind: 'toolInvocationSerialized',
    toolCallId,
    toolId,
    isComplete: options.complete ?? true,
    invocationMessage: options.message || `Running ${toolId}`,
    pastTenseMessage: options.message || `Ran ${toolId}`,
    toolSpecificData: specific,
    resultDetails: options.isError === undefined ? undefined : { isError: options.isError },
  })
}

export function textEdit(path: string, text = 'updated\n'): unknown {
  return clean({
    kind: 'textEditGroup',
    done: true,
    uri: { scheme: 'file', path, fsPath: path },
    edits: [[{
      text,
      range: { startLineNumber: 2, endLineNumber: 3 },
    }]],
  })
}

export function request(
  requestId: string,
  text: string,
  options: CopilotRequestOptions = {},
): unknown {
  return clean({
    requestId,
    timestamp: options.timestamp ?? T0,
    message: { text },
    agent: {
      id: options.agentId ?? 'github.copilot.editsAgent',
      extensionPublisherId: options.copilotMetadata === false ? 'Other' : 'GitHub',
      extensionDisplayName: options.copilotMetadata === false ? 'Other Provider' : 'GitHub Copilot',
    },
    modeInfo: options.mode ? { kind: options.mode } : undefined,
    modelId: options.model ?? 'copilot-test-model',
    modelState: {
      value: options.state ?? 1,
      completedAt: options.completedAt ?? T0 + 1_000,
    },
    response: options.response ?? [],
    result: options.error
      ? { errorDetails: options.error }
      : { metadata: {
          resolvedModel: options.model ?? 'copilot-test-model',
          promptTokens: options.promptTokens,
          outputTokens: options.outputTokens ?? 7,
        } },
    elapsedMs: options.elapsedMs,
  })
}

export function snapshot(options: {
  id?: string
  title?: string
  creationDate?: number
  responder?: string
  workingDirectory?: string
  requests?: unknown[]
  pendingRequests?: unknown[]
} = {}): unknown {
  return clean({
    version: 3,
    creationDate: options.creationDate ?? T0,
    sessionId: options.id ?? 'copilot-session',
    customTitle: options.title,
    initialLocation: 'panel',
    responderUsername: options.responder ?? 'GitHub Copilot',
    workingDirectory: options.workingDirectory,
    hasPendingEdits: false,
    pendingRequests: options.pendingRequests ?? [],
    requests: options.requests ?? [],
  })
}

export function initial(value: unknown): unknown {
  return { kind: 0, v: value }
}

export function set(path: ReadonlyArray<string | number>, value: unknown): unknown {
  return { kind: 1, k: path, v: value }
}

export function push(
  path: ReadonlyArray<string | number>,
  value: unknown[],
  index?: number,
): unknown {
  return { kind: 2, k: path, v: value, i: index }
}

export function unknownRecord(kind = 99): unknown {
  return { kind, future: true }
}

export function log(
  records: unknown[],
  options: { malformed?: boolean, trailingPartial?: boolean } = {},
): string {
  const lines = records.map(record => JSON.stringify(record))
  if (options.malformed) lines.push('{bad json')
  const complete = `${lines.join('\n')}\n`
  return options.trailingPartial ? `${complete}{"kind":1` : complete
}

export function writeLog(path: string, records: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, log(records))
}

export function appendRecords(path: string, records: unknown[]): void {
  appendFileSync(path, records.map(record => `${JSON.stringify(record)}\n`).join(''))
}
