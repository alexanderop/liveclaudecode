import { dirname } from 'node:path'
import { Config, Context, Deferred, Effect, Fiber, Layer, Option, Result, Schema, Scope, Stream } from 'effect'
import type { Duration } from 'effect'
import { AcpAgentError, AcpConnector, type AcpConnection } from './acp-connection'
import { isDirectory } from './project'
import {
  appendChatEvent,
  CHAT_RECORD_CAPACITY,
  ChatStore,
  type ChatRecord,
} from './chat-store'
import { pathFor } from './runs'
import { ScanCache, UnknownRun } from './services'
import {
  loadSessionCatalog,
  SessionLocatorCache,
  UNASSIGNED_PROJECT,
  type SessionEventLocation,
} from './session-catalog'
import {
  parseInitializeResult,
  parseNewSessionResult,
  parsePromptResult,
  type SessionNotification,
} from '#shared/schemas/acp'
import { parseChatAction } from '#shared/schemas/chat'
import { normalizeSessionLabel } from '#shared/utils/session-label'
import type {
  ChatActionResponse,
  ChatAgentId,
  ChatEventsResponse,
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

/** The process already owns the maximum number of active Ask conversations. */
export class ChatCapacity extends Schema.TaggedErrorClass<ChatCapacity>()(
  'ChatCapacity',
  { capacity: Schema.Number },
) {
  override get message(): string {
    return `At most ${this.capacity} Ask conversations can run at once`
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

/** How each agent is launched when nothing overrides it, and its fixed env. */
const AGENT_DEFAULTS: Readonly<Record<ChatAgentId, {
  readonly setting: string
  readonly commandLine: ReadonlyArray<string>
  readonly env: Record<string, string>
}>> = {
  claude: {
    setting: 'LCC_ACP_CLAUDE',
    commandLine: ['npx', '-y', '@agentclientprotocol/claude-agent-acp'],
    env: {},
  },
  codex: {
    setting: 'LCC_ACP_CODEX',
    commandLine: ['npx', '-y', '@agentclientprotocol/codex-acp'],
    env: { INITIAL_AGENT_MODE: 'agent-full-access', NO_BROWSER: '1' },
  },
  copilot: {
    setting: 'LCC_ACP_COPILOT',
    commandLine: ['copilot', '--acp', '--stdio', '--allow-all'],
    env: {},
  },
}

/** A configured command line is whitespace-separated; a blank one is no override. */
export function chatAgentCommand(
  agent: ChatAgentId,
  configured: string | undefined,
): ChatAgentCommand {
  const { commandLine, env } = AGENT_DEFAULTS[agent]
  const parts = configured ? configured.split(/\s+/).filter(Boolean) : []
  const resolved = parts.length ? parts : commandLine
  return { command: resolved[0]!, args: resolved.slice(1), env }
}

/**
 * ACP agent launchers, keyed by the id the client sends. Ask agents start with
 * full tool access; ACP permission requests are approved by the policy below.
 *
 * Which binary gets that access is a real decision, so the reference default is
 * the vetted launcher for each agent and {@link layerChatAgentCommands} is the
 * only place `LCC_ACP_*` overrides are read.
 */
export const ChatAgentCommands = Context.Reference<Readonly<Record<ChatAgentId, ChatAgentCommand>>>(
  'lcc/ChatAgentCommands',
  {
    defaultValue: () => ({
      claude: chatAgentCommand('claude', undefined),
      codex: chatAgentCommand('codex', undefined),
      copilot: chatAgentCommand('copilot', undefined),
    }),
  },
)

/** The launchers with `LCC_ACP_*` overrides applied, read once per runtime. */
export const layerChatAgentCommands: Layer.Layer<never, Config.ConfigError> = Layer.effect(
  ChatAgentCommands,
  Effect.gen(function*() {
    const entries = yield* Effect.forEach(
      Object.entries(AGENT_DEFAULTS) as ReadonlyArray<[ChatAgentId, { setting: string }]>,
      ([agent, { setting }]) => Effect.map(
        Config.option(Config.string(setting)),
        configured => [agent, chatAgentCommand(agent, Option.getOrUndefined(configured))] as const,
      ),
    )
    return Object.fromEntries(entries) as Readonly<Record<ChatAgentId, ChatAgentCommand>>
  }),
)

const chatKey = (project: string, key: string): string => `${project}\0${key}`

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

function chatUpdateHandler(record: ChatRecord, generation: number) {
  return (notification: SessionNotification): Effect.Effect<void> => Effect.sync(() => {
    if (record.generation !== generation) return
    if (record.sessionId !== notification.sessionId) return
    if (notification.update.kind !== 'known') return
    const update = notification.update.data
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        if (update.content.text === undefined) return
        if (isAgentLaunchNotice(record.agent, update.content.text)) return
        appendChatEvent(record, {
          kind: update.sessionUpdate === 'agent_message_chunk' ? 'assistant-chunk' : 'thought-chunk',
          agent: record.agent,
          text: update.content.text,
        })
        return
      }
      case 'tool_call':
      case 'tool_call_update': {
        appendChatEvent(record, {
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

/**
 * The framing sent once per ACP conversation. A subagent's transcript holds
 * only that subagent's own turns — the parent session and its siblings live in
 * other files — so the agent is told where the record stops rather than left to
 * infer it from a file that simply ends early.
 */
function chatPreamble(location: SessionEventLocation, transcriptPath: string, cwd: string): string {
  const { node } = location
  const subagent = node.kind === 'subagent'
  const label = normalizeSessionLabel(node.label, node.key)
  return [
    'You are embedded in the Ask panel of liveclaudecode, a dashboard for observing coding-agent sessions.',
    subagent
      ? `The user is inspecting one subagent run of a recorded ${location.source} session and asks follow-up questions about it.`
      : `The user is inspecting a recorded ${location.source} session and asks follow-up questions about it.`,
    ...(subagent
      ? [
          `The subagent is "${label}"${node.agentType ? `, an ${node.agentType} agent` : ''}.`,
          'The transcript is only this subagent\'s own conversation: it contains neither the parent session\'s messages nor any sibling subagent\'s work.',
          'Scope every answer to that transcript. When the answer is not in it, say so instead of inferring what the parent session did.',
        ]
      : []),
    `The ${subagent ? 'subagent' : 'session'} transcript (JSONL) is at: ${transcriptPath}`,
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
  let location = yield* locatorCache.get(projectInput, hours, project, key)
  if (Option.isNone(location)) {
    yield* loadSessionCatalog(projectInput, hours)
    location = yield* locatorCache.get(projectInput, hours, project, key)
  }
  if (Option.isNone(location)) return yield* new UnknownRun({ key })
  return location.value
})

/**
 * Working directory for the agent process. claude-agent-acp refuses a cwd
 * that does not exist, so this falls back from the observed session's own
 * cwd to directories that are guaranteed to be present.
 */
const resolveChatCwd = Effect.fn('resolveChatCwd')(function*(
  location: SessionEventLocation,
  transcriptPath: string,
) {
  if (location.source === 'claude') {
    const scans = yield* ScanCache
    const scan = yield* scans.get(transcriptPath)
    if (scan.cwd && (yield* isDirectory(scan.cwd))) return scan.cwd
    return location.projectDirectory
  }

  if (location.projectId !== UNASSIGNED_PROJECT && (yield* isDirectory(location.projectId))) {
    return location.projectId
  }
  return dirname(transcriptPath)
})

/** Closes the record's ACP connection through `ChatStore`, the single owner of that teardown. */
const closeChatConnection = Effect.fn('closeChatConnection')(function*(record: ChatRecord) {
  const store = yield* ChatStore
  yield* store.closeConnection(record)
})

const failChatTurn = Effect.fn('failChatTurn')(function*(
  record: ChatRecord,
  generation: number,
  error: AcpAgentError,
) {
  if (record.generation !== generation) return
  appendChatEvent(record, { kind: 'error', message: error.message })
  yield* Effect.sync(() => {
    record.status = 'error'
  })
  yield* closeChatConnection(record)
})

const requestWithTimeout = Effect.fn('requestWithTimeout')(
  function*(
    connection: AcpConnection,
    method: string,
    params: unknown,
    _timeout: Duration.Input,
  ) {
    return yield* connection.request(method, params)
  },
  (effect, _connection, method, _params, timeout) => effect.pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.fail(new AcpAgentError({
        reason: `${method} timed out after ${timeout}`,
      })),
    }),
  ),
)

/** One prompt turn, run on a detached fiber so the HTTP request returns early. */
const runChatTurn = Effect.fn('runChatTurn')(function*(
  record: ChatRecord,
  generation: number,
  connector: AcpConnector['Service'],
  command: ChatAgentCommand,
  location: SessionEventLocation,
  transcriptPath: string,
  cwd: string,
  text: string,
) {
  if (record.generation !== generation) return
  if (record.scope && !record.connection) yield* closeChatConnection(record)
  let connection = record.connection
  if (!connection) {
    const scope = yield* Scope.make()
    yield* Effect.sync(() => {
      record.scope = scope
    })
    connection = yield* Scope.provide(scope)(connector.connect({
      command: command.command,
      args: command.args,
      env: command.env,
      cwd,
      permission: chatPermissionPolicy,
    }))
    yield* Effect.sync(() => {
      record.connection = connection
    })
    // A scoped consumer, not the callback the connection used to take
    // directly: the reader fiber only enqueues updates, so this fiber (and
    // not protocol dispatch) absorbs however long `chatUpdateHandler` takes.
    // Forked onto the connection's own scope, it is interrupted when that
    // scope closes.
    yield* Scope.provide(scope)(Effect.forkScoped(
      Stream.runForEach(connection.updates, chatUpdateHandler(record, generation)),
    ))
    const initialized = yield* requestWithTimeout(connection, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'liveclaudecode', version: '0.0.0' },
    }, '30 seconds')
    const initializeResult = parseInitializeResult(initialized)
    if (Result.isFailure(initializeResult) || initializeResult.success.protocolVersion !== 1) {
      return yield* new AcpAgentError({ reason: 'agent does not support ACP protocol version 1' })
    }
    const created = yield* requestWithTimeout(
      connection,
      'session/new',
      { cwd, mcpServers: [] },
      '30 seconds',
    )
    const parsed = parseNewSessionResult(created)
    if (Result.isFailure(parsed)) {
      return yield* new AcpAgentError({ reason: 'session/new returned no session id' })
    }
    yield* Effect.sync(() => {
      record.sessionId = parsed.success.sessionId
      record.primed = false
    })
  }

  const prompt = record.primed
    ? [{ type: 'text', text }]
    : [
        { type: 'text', text: chatPreamble(location, transcriptPath, cwd) },
        { type: 'text', text },
      ]
  yield* Effect.sync(() => {
    record.primed = true
    record.status = 'busy'
  })

  const result = yield* requestWithTimeout(connection, 'session/prompt', {
    sessionId: record.sessionId,
    prompt,
  }, '10 minutes')

  const stop = parsePromptResult(result)
  if (Result.isFailure(stop)) {
    yield* Effect.logDebug('chat: unparseable session/prompt result, reporting stopReason unknown', {
      result,
      error: stop.failure,
    })
  }
  if (record.generation !== generation) return
  appendChatEvent(record, {
    kind: 'turn-end',
    stopReason: Result.isSuccess(stop) ? stop.success.stopReason : 'unknown',
  })
  yield* Effect.sync(() => {
    record.status = 'idle'
  })
})

const runChatTurnSafely = Effect.fn('runChatTurnSafely')(
  function*(
    chatKey: string,
    store: ChatStore['Service'],
    record: ChatRecord,
    generation: number,
    connector: AcpConnector['Service'],
    command: ChatAgentCommand,
    location: SessionEventLocation,
    transcriptPath: string,
    cwd: string,
    text: string,
  ) {
    yield* runChatTurn(record, generation, connector, command, location, transcriptPath, cwd, text)
  },
  (effect, chatKey, store, record, generation) => effect.pipe(
    Effect.catch(error => failChatTurn(record, generation, error)),
    Effect.ensuring(store.settle(chatKey, record, generation)),
  ),
)

export const sendChatMessage = Effect.fn('sendChatMessage')(function*(
  projectInput: string,
  hours: number,
  project: string,
  key: string,
  agent: ChatAgentId,
  text: string,
) {
  const store = yield* ChatStore
  const connector = yield* AcpConnector
  const commands = yield* ChatAgentCommands
  const command = commands[agent]

  const id = chatKey(project, key)
  const location = yield* locateChatSession(projectInput, hours, project, key)
  const transcriptPath = location.source === 'claude'
    ? yield* pathFor(location.projectDirectory, key)
    : location.source === 'codex'
      ? location.transcriptPath
      : location.copilotLocation.path
  const cwd = yield* resolveChatCwd(location, transcriptPath)

  return yield* Effect.uninterruptible(Effect.gen(function*() {
    const reservation = yield* store.reserve(id, agent, text)
    if (reservation._tag === 'Busy') return yield* new ChatBusy({ key })
    if (reservation._tag === 'Full') {
      return yield* new ChatCapacity({ capacity: CHAT_RECORD_CAPACITY })
    }
    const { record, generation } = reservation
    const start = yield* Deferred.make<void>()
    const turn = yield* Effect.forkDetach(
      Deferred.await(start).pipe(
        Effect.andThen(runChatTurnSafely(
          id,
          store,
          record,
          generation,
          connector,
          command,
          location,
          transcriptPath,
          cwd,
          text,
        )),
      ),
    )
    const attached = yield* store.attach(id, record, generation, turn)
    if (attached) yield* Deferred.succeed(start, undefined)
    else yield* Fiber.interrupt(turn)
    return { status: attached ? record.status : 'idle' } satisfies ChatActionResponse
  }))
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
    const response: ChatEventsResponse = {
      events: [],
      next: 0,
      revision: 0,
      reset: since > 0 || revision !== 0,
      status: 'idle',
      agent: null,
    }
    return response
  }
  const end = record.base + record.events.length
  const reset = revision !== record.revision || since < record.base || since > end
  const events = reset ? [...record.events] : record.events.slice(since - record.base)
  const response: ChatEventsResponse = {
    events,
    next: end,
    revision: record.revision,
    reset,
    status: record.status,
    agent: record.agent,
  }
  return response
})

export const cancelChat = Effect.fn('cancelChat')(function*(project: string, key: string) {
  return yield* Effect.uninterruptibleMask(restore => Effect.gen(function*() {
    const store = yield* ChatStore
    const id = chatKey(project, key)
    const cancellation = yield* store.claimCancellation(id)
    if (cancellation._tag === 'Inactive') {
      return { status: cancellation.status } satisfies ChatActionResponse
    }
    const { generation, record, turn } = cancellation
    const cleanup = Effect.gen(function*() {
      if (turn) yield* Fiber.interrupt(turn)
      if (record.generation === generation) {
        yield* closeChatConnection(record)
        appendChatEvent(record, { kind: 'turn-end', stopReason: 'cancelled' })
        yield* Effect.sync(() => {
          record.status = 'idle'
        })
        yield* store.settle(id, record, generation)
      }
    })
    // Best-effort: the agent may already be gone when a cancel arrives, so a
    // failed notification is logged rather than failing the cancellation.
    const notify = record.connection && record.sessionId
      ? record.connection.notify('session/cancel', { sessionId: record.sessionId }).pipe(
          Effect.catch(error => Effect.logWarning('chat: cancel notification failed', { error })),
        )
      : Effect.void
    yield* restore(notify).pipe(Effect.ensuring(cleanup))
    return { status: record.status } satisfies ChatActionResponse
  }))
})

export const resetChat = Effect.fn('resetChat')(function*(project: string, key: string) {
  return yield* Effect.uninterruptible(Effect.gen(function*() {
    const store = yield* ChatStore
    yield* store.remove(chatKey(project, key))
    return { status: 'idle' } satisfies ChatActionResponse
  }))
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
        action.text,
      )
    case 'cancel':
      return yield* cancelChat(action.project, action.key)
    case 'reset':
      return yield* resetChat(action.project, action.key)
  }
})
