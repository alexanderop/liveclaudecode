import { dirname } from 'node:path'
import { Context, Effect, Exit, Layer, Result, Schema, Scope } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { AcpAgentError, AcpConnector, type AcpConnection } from './acp-connection'
import { pathFor } from './runs'
import { ScanCache, SessionLocatorCache, UnknownRun, type SessionEventLocation } from './services'
import { loadSessionCatalog } from './session-browser'
import {
  parseInitializeResult,
  parseNewSessionResult,
  parsePromptResult,
  type SessionNotification,
} from '#shared/schemas/acp'
import { parseChatAction } from '#shared/schemas/chat'
import type {
  ChatActionResponse,
  ChatAgentId,
  ChatEvent,
  ChatEventsResponse,
  ChatStatus,
} from '#shared/types/chat'

/** A reply is already streaming for this chat — one turn in flight at a time. */
export class ChatBusy extends Schema.TaggedErrorClass<ChatBusy>()(
  'ChatBusy',
  { key: Schema.String },
) {
  override get message(): string {
    return 'A reply is already in progress for this chat'
  }
}

/** The requested agent id has no configured ACP command. */
export class UnknownChatAgent extends Schema.TaggedErrorClass<UnknownChatAgent>()(
  'UnknownChatAgent',
  { agent: Schema.String },
) {
  override get message(): string {
    return `Unknown chat agent ${JSON.stringify(this.agent)}`
  }
}

/** The POST body is not one of the supported chat actions. */
export class InvalidChatAction extends Schema.TaggedErrorClass<InvalidChatAction>()(
  'InvalidChatAction',
  { reason: Schema.String },
) {
  override get message(): string {
    return `Invalid chat action: ${this.reason}`
  }
}

export interface ChatAgentCommand {
  command: string
  args: ReadonlyArray<string>
  env: Record<string, string>
}

function commandFromEnv(
  value: string | undefined,
  fallback: ReadonlyArray<string>,
): { command: string, args: ReadonlyArray<string> } {
  const parts = value ? value.split(/\s+/).filter(Boolean) : fallback
  const resolved = parts.length ? parts : fallback
  return { command: resolved[0]!, args: resolved.slice(1) }
}

/**
 * ACP agent launchers, keyed by the id the client sends. Overridable via
 * `LCC_ACP_CLAUDE`, `LCC_ACP_CODEX`, or `LCC_ACP_COPILOT` (a full command
 * line, split on spaces). Ask agents start with full tool access; ACP
 * permission requests are approved by the policy below.
 */
export function chatAgentCommandsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<ChatAgentId, ChatAgentCommand>> {
  return {
    claude: {
      ...commandFromEnv(env.LCC_ACP_CLAUDE, ['npx', '-y', '@agentclientprotocol/claude-agent-acp']),
      env: {},
    },
    codex: {
      ...commandFromEnv(env.LCC_ACP_CODEX, ['npx', '-y', '@agentclientprotocol/codex-acp']),
      env: { INITIAL_AGENT_MODE: 'agent-full-access', NO_BROWSER: '1' },
    },
    copilot: {
      ...commandFromEnv(env.LCC_ACP_COPILOT, [
        'copilot',
        '--acp',
        '--stdio',
        '--allow-all',
      ]),
      env: {},
    },
  }
}

export const ChatAgentCommands = Context.Reference<Readonly<Record<ChatAgentId, ChatAgentCommand>>>(
  'lcc/ChatAgentCommands',
  {
    defaultValue: () => chatAgentCommandsFromEnv(process.env),
  },
)

export interface ChatRecord {
  agent: ChatAgentId
  status: ChatStatus
  revision: number
  /** Index of `events[0]` in the chat's full history; grows when trimmed. */
  base: number
  events: ChatEvent[]
  scope: Scope.Closeable | null
  connection: AcpConnection | null
  sessionId: string | null
  /** Whether the transcript preamble has been sent on this ACP session. */
  primed: boolean
}

/** Live chats keyed by `${project}\0${key}`, scoped to the provided Layer. */
export class ChatStore extends Context.Service<ChatStore, {
  readonly get: (chatKey: string) => Effect.Effect<ChatRecord | undefined>
  readonly set: (chatKey: string, record: ChatRecord) => Effect.Effect<void>
  readonly remove: (chatKey: string) => Effect.Effect<ChatRecord | undefined>
}>()('lcc/ChatStore') {
  static readonly layer = Layer.effect(
    ChatStore,
    Effect.gen(function*() {
      const records = new Map<string, ChatRecord>()
      yield* Effect.addFinalizer(() => Effect.forEach(
        records.values(),
        record => record.scope ? Scope.close(record.scope, Exit.void) : Effect.void,
        { discard: true },
      ))
      return ChatStore.of({
        get: chatKey => Effect.sync(() => records.get(chatKey)),
        set: (chatKey, record) => Effect.sync(() => {
          records.set(chatKey, record)
        }),
        remove: chatKey => Effect.sync(() => {
          const record = records.get(chatKey)
          records.delete(chatKey)
          return record
        }),
      })
    }),
  )
}

const chatKey = (project: string, key: string): string => `${project}\0${key}`

const MAX_EVENTS = 4_000
const TRIM_EVENTS = 1_000

function appendEvent(record: ChatRecord, event: ChatEvent): void {
  record.events.push(event)
  if (record.events.length > MAX_EVENTS) {
    record.events.splice(0, TRIM_EVENTS)
    record.base += TRIM_EVENTS
  }
}

/** Ask agents have full tool access, including edits and command execution. */
function chatPermissionPolicy(): 'allow' {
  return 'allow'
}

/**
 * Copilot reports its launch-time tool filter as an assistant message on the
 * first prompt. It is ACP transport noise rather than model output, so keep it
 * out of the user's conversation while preserving all other chunks verbatim.
 */
function isAgentLaunchNotice(agent: ChatAgentId, text: string): boolean {
  return agent === 'copilot' && text.startsWith('Info: Disabled tools: ')
}

function chatUpdateHandler(record: ChatRecord) {
  return (notification: SessionNotification): Effect.Effect<void> => Effect.sync(() => {
    if (record.sessionId !== notification.sessionId) return
    const update = notification.update
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        if (!('content' in update) || typeof update.content.text !== 'string') return
        if (isAgentLaunchNotice(record.agent, update.content.text)) return
        appendEvent(record, {
          kind: update.sessionUpdate === 'agent_message_chunk' ? 'assistant-chunk' : 'thought-chunk',
          agent: record.agent,
          text: update.content.text,
        })
        return
      }
      case 'tool_call':
      case 'tool_call_update': {
        if (!('toolCallId' in update)) return
        appendEvent(record, {
          kind: 'tool',
          toolCallId: update.toolCallId,
          title: update.title ?? '',
          toolKind: update.kind ?? '',
          status: update.status ?? (update.sessionUpdate === 'tool_call' ? 'pending' : ''),
        })
      }
    }
  })
}

function chatPreamble(location: SessionEventLocation, transcriptPath: string, cwd: string): string {
  return [
    'You are embedded in the Ask panel of liveclaudecode, a dashboard for observing coding-agent sessions.',
    `The user is inspecting a recorded ${location.source} session and asks follow-up questions about it.`,
    `The session transcript (JSONL) is at: ${transcriptPath}`,
    `The observed session's working directory was: ${cwd}`,
    'Answer by reading the transcript and any files it references.',
    'You have full tool access and may edit files or run commands when needed to fulfill the request.',
    'Keep answers concise and cite concrete evidence — file paths, commands, errors — from the transcript.',
  ].join('\n')
}

const locateChatSession = Effect.fn('locateChatSession')(function*(
  projectInput: string,
  hours: number,
  project: string,
  key: string,
) {
  const locatorCache = yield* SessionLocatorCache
  let location = yield* locatorCache.get(project, key)
  if (!location) {
    yield* loadSessionCatalog(projectInput, hours)
    location = yield* locatorCache.get(project, key)
  }
  if (!location) return yield* new UnknownRun({ key })
  return location
})

/**
 * Working directory for the agent process. claude-agent-acp refuses a cwd
 * that does not exist, so this falls back from the observed session's own
 * cwd to directories that are guaranteed to be present.
 */
const usableDirectory = Effect.fn('usableDirectory')(function*(path: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.stat(path).pipe(
    Effect.map(info => info.type === 'Directory'),
    Effect.catchIf(error => error.reason._tag === 'NotFound', () => Effect.succeed(false)),
  )
})

const resolveChatCwd = Effect.fn('resolveChatCwd')(function*(
  location: SessionEventLocation,
  transcriptPath: string,
) {
  if (location.source === 'claude') {
    const scans = yield* ScanCache
    const scan = yield* scans.get(transcriptPath)
    if (scan.cwd && (yield* usableDirectory(scan.cwd))) return scan.cwd
    return location.projectDirectory
  }

  if (location.projectId !== '__unassigned__' && (yield* usableDirectory(location.projectId))) {
    return location.projectId
  }
  return dirname(transcriptPath)
})

const closeChatConnection = Effect.fn('closeChatConnection')(function*(record: ChatRecord) {
  const scope = record.scope
  record.scope = null
  record.connection = null
  record.sessionId = null
  record.primed = false
  if (scope) yield* Scope.close(scope, Exit.void)
})

const failChatTurn = Effect.fn('failChatTurn')(function*(record: ChatRecord, error: AcpAgentError) {
  appendEvent(record, { kind: 'error', message: error.message })
  record.status = 'error'
  yield* closeChatConnection(record)
})

const requestWithTimeout = Effect.fn('requestWithTimeout')(
  function*(
    connection: AcpConnection,
    method: string,
    params: unknown,
    timeout: '30 seconds' | '10 minutes',
  ) {
    return yield* connection.request(method, params)
  },
  (effect, _connection, method, _params, timeout) => effect.pipe(
    Effect.timeout(timeout),
    Effect.catchTag('TimeoutError', () => Effect.fail(new AcpAgentError({
      reason: `${method} timed out after ${timeout}`,
    }))),
  ),
)

/** One prompt turn, run on a detached fiber so the HTTP request returns early. */
const runChatTurn = Effect.fn('runChatTurn')(function*(
  record: ChatRecord,
  connector: AcpConnector['Service'],
  command: ChatAgentCommand,
  location: SessionEventLocation,
  transcriptPath: string,
  cwd: string,
  text: string,
) {
  let connection = record.connection
  if (!connection) {
    const scope = yield* Scope.make()
    record.scope = scope
    connection = yield* Scope.provide(scope)(connector.connect({
      command: command.command,
      args: command.args,
      env: command.env,
      cwd,
      onUpdate: chatUpdateHandler(record),
      permission: chatPermissionPolicy,
    }))
    record.connection = connection
    const initialized = yield* requestWithTimeout(connection, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'liveclaudecode', version: '0.0.0' },
    }, '30 seconds')
    const initializeResult = parseInitializeResult(initialized)
    if (!initializeResult.success || initializeResult.value.protocolVersion !== 1) {
      return yield* new AcpAgentError({ reason: 'agent does not support ACP protocol version 1' })
    }
    const created = yield* requestWithTimeout(
      connection,
      'session/new',
      { cwd, mcpServers: [] },
      '30 seconds',
    )
    const parsed = parseNewSessionResult(created)
    if (!parsed.success) {
      return yield* new AcpAgentError({ reason: 'session/new returned no session id' })
    }
    record.sessionId = parsed.value.sessionId
    record.primed = false
  }

  const prompt = record.primed
    ? [{ type: 'text', text }]
    : [
        { type: 'text', text: chatPreamble(location, transcriptPath, cwd) },
        { type: 'text', text },
      ]
  record.primed = true
  record.status = 'busy'

  const result = yield* requestWithTimeout(connection, 'session/prompt', {
    sessionId: record.sessionId,
    prompt,
  }, '10 minutes')

  const stop = parsePromptResult(result)
  appendEvent(record, { kind: 'turn-end', stopReason: stop.success ? stop.value.stopReason : 'unknown' })
  record.status = 'idle'
})

const runChatTurnSafely = Effect.fn('runChatTurnSafely')(
  function*(
    record: ChatRecord,
    connector: AcpConnector['Service'],
    command: ChatAgentCommand,
    location: SessionEventLocation,
    transcriptPath: string,
    cwd: string,
    text: string,
  ) {
    yield* runChatTurn(record, connector, command, location, transcriptPath, cwd, text)
  },
  (effect, record) => effect.pipe(Effect.catch(error => failChatTurn(record, error))),
)

export const sendChatMessage = Effect.fn('sendChatMessage')(function*(
  projectInput: string,
  hours: number,
  project: string,
  key: string,
  agent: string,
  text: string,
) {
  const store = yield* ChatStore
  const connector = yield* AcpConnector
  const commands = yield* ChatAgentCommands
  const command = (commands as Record<string, ChatAgentCommand | undefined>)[agent]
  if (!command) return yield* new UnknownChatAgent({ agent })

  const id = chatKey(project, key)
  let record = yield* store.get(id)
  if (record && (record.status === 'busy' || record.status === 'starting')) {
    return yield* new ChatBusy({ key })
  }

  const location = yield* locateChatSession(projectInput, hours, project, key)
  const transcriptPath = location.source === 'claude'
    ? yield* pathFor(location.projectDirectory, key)
    : location.source === 'codex'
      ? location.transcriptPath
      : location.copilotLocation.path
  const cwd = yield* resolveChatCwd(location, transcriptPath)

  if (record && record.agent !== agent) {
    yield* closeChatConnection(record)
    record.agent = agent as ChatAgentId
  }
  if (!record) {
    record = {
      agent: agent as ChatAgentId,
      status: 'idle',
      revision: 1,
      base: 0,
      events: [],
      scope: null,
      connection: null,
      sessionId: null,
      primed: false,
    }
    yield* store.set(id, record)
  }

  appendEvent(record, { kind: 'user', text })
  record.status = record.connection ? 'busy' : 'starting'

  yield* Effect.forkDetach(
    runChatTurnSafely(record, connector, command, location, transcriptPath, cwd, text),
  )
  return { status: record.status } satisfies ChatActionResponse
})

export const pollChatEvents = Effect.fn('pollChatEvents')(function*(
  project: string,
  key: string,
  since: number,
  revision: number,
) {
  const store = yield* ChatStore
  const record = yield* store.get(chatKey(project, key))
  if (!record) {
    return {
      events: [],
      next: 0,
      revision: 0,
      reset: since > 0 || revision !== 0,
      status: 'idle' as ChatStatus,
      agent: null,
    } satisfies ChatEventsResponse
  }
  const end = record.base + record.events.length
  const reset = revision !== record.revision || since < record.base || since > end
  const events = reset ? [...record.events] : record.events.slice(since - record.base)
  return {
    events,
    next: end,
    revision: record.revision,
    reset,
    status: record.status,
    agent: record.agent,
  } satisfies ChatEventsResponse
})

export const cancelChat = Effect.fn('cancelChat')(function*(project: string, key: string) {
  const store = yield* ChatStore
  const record = yield* store.get(chatKey(project, key))
  if (record?.status === 'busy' && record.connection && record.sessionId) {
    yield* record.connection.notify('session/cancel', { sessionId: record.sessionId }).pipe(Effect.ignore)
  }
  return { status: record?.status ?? 'idle' } satisfies ChatActionResponse
})

export const resetChat = Effect.fn('resetChat')(function*(project: string, key: string) {
  const store = yield* ChatStore
  const record = yield* store.remove(chatKey(project, key))
  if (record) yield* closeChatConnection(record)
  return { status: 'idle' } satisfies ChatActionResponse
})

export const handleChatAction = Effect.fn('handleChatAction')(function*(
  projectInput: string,
  hours: number,
  input: unknown,
) {
  const parsed = parseChatAction(input)
  if (Result.isFailure(parsed)) {
    return yield* new InvalidChatAction({ reason: parsed.failure.message })
  }
  const action = parsed.success
  switch (action.action) {
    case 'send':
      return yield* sendChatMessage(
        projectInput,
        hours,
        action.project,
        action.key,
        action.agent,
        action.text.trim(),
      )
    case 'cancel':
      return yield* cancelChat(action.project, action.key)
    case 'reset':
      return yield* resetChat(action.project, action.key)
  }
})
