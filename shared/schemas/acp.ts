import { Result, Schema } from 'effect'

/**
 * Schemas for the Agent Client Protocol (ACP) wire format: newline-delimited
 * JSON-RPC 2.0 spoken over an agent subprocess's stdio.
 *
 * Adapters (claude-agent-acp, codex-acp) extend the protocol over time —
 * unknown update variants, `_meta` fields, extra permission option ids — so
 * every decoder preserves excess properties and unknown variants degrade to
 * a raw envelope instead of failing the connection.
 */
const PRESERVE = { onExcessProperty: 'preserve' } as const

/** Agents may answer a numeric request id with its string spelling. */
export const JsonRpcIdSchema = Schema.Union([Schema.Finite, Schema.String])

/**
 * One inbound line. Dispatch order: a `method` with an `id` is an
 * agent-initiated request, a `method` without an `id` is a notification, and
 * no `method` means a response to one of our requests.
 */
export const InboundMessageSchema = Schema.Struct({
  id: Schema.optionalKey(JsonRpcIdSchema),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Unknown),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Struct({
    code: Schema.optionalKey(Schema.Finite),
    message: Schema.optionalKey(Schema.String),
  })),
})
export type InboundMessage = typeof InboundMessageSchema.Type

// -- Results of requests we send --------------------------------------------

export const InitializeResultSchema = Schema.Struct({
  protocolVersion: Schema.Finite,
})

export const NewSessionResultSchema = Schema.Struct({
  sessionId: Schema.String,
})

export const PromptResultSchema = Schema.Struct({
  stopReason: Schema.String,
})

// -- session/update notification --------------------------------------------

const ContentBlockSchema = Schema.Struct({
  type: Schema.String,
  text: Schema.optionalKey(Schema.String),
})

const MessageChunkUpdateSchema = Schema.Struct({
  sessionUpdate: Schema.Literals(['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk']),
  content: ContentBlockSchema,
})

const ToolCallUpdateSchema = Schema.Struct({
  sessionUpdate: Schema.Literals(['tool_call', 'tool_call_update']),
  toolCallId: Schema.String,
  title: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
})

/** Catch-all keeps unknown variants (plan, keepalive, …) from failing decode. */
const OtherUpdateSchema = Schema.Struct({
  sessionUpdate: Schema.String,
})

export const SessionUpdateSchema = Schema.Union([
  MessageChunkUpdateSchema,
  ToolCallUpdateSchema,
  OtherUpdateSchema,
])
export type SessionUpdate = typeof SessionUpdateSchema.Type

export const SessionNotificationSchema = Schema.Struct({
  sessionId: Schema.String,
  update: SessionUpdateSchema,
})
export type SessionNotification = typeof SessionNotificationSchema.Type

// -- session/request_permission (agent → client) -----------------------------

export const PermissionOptionSchema = Schema.Struct({
  optionId: Schema.String,
  name: Schema.optionalKey(Schema.String),
  kind: Schema.String,
})
export type PermissionOption = typeof PermissionOptionSchema.Type

export const PermissionRequestSchema = Schema.Struct({
  sessionId: Schema.String,
  toolCall: Schema.optionalKey(Schema.Struct({
    toolCallId: Schema.optionalKey(Schema.String),
    title: Schema.optionalKey(Schema.String),
    kind: Schema.optionalKey(Schema.String),
  })),
  options: Schema.Array(PermissionOptionSchema),
})
export type PermissionRequest = typeof PermissionRequestSchema.Type

// -- Parse helpers ------------------------------------------------------------

const decodeInbound = Schema.decodeUnknownResult(InboundMessageSchema, PRESERVE)
const decodeNotification = Schema.decodeUnknownResult(SessionNotificationSchema, PRESERVE)
const decodePermission = Schema.decodeUnknownResult(PermissionRequestSchema, PRESERVE)
const decodeInitialize = Schema.decodeUnknownResult(InitializeResultSchema, PRESERVE)
const decodeNewSession = Schema.decodeUnknownResult(NewSessionResultSchema, PRESERVE)
const decodePrompt = Schema.decodeUnknownResult(PromptResultSchema, PRESERVE)

type Parsed<T> = { success: true, value: T } | { success: false, error: Schema.SchemaError }

function toParsed<T>(result: Result.Result<T, Schema.SchemaError>): Parsed<T> {
  return Result.isSuccess(result)
    ? { success: true, value: result.success }
    : { success: false, error: result.failure }
}

export const parseInboundMessage = (value: unknown): Parsed<InboundMessage> => toParsed(decodeInbound(value))
export const parseSessionNotification = (value: unknown): Parsed<SessionNotification> => toParsed(decodeNotification(value))
export const parsePermissionRequest = (value: unknown): Parsed<PermissionRequest> => toParsed(decodePermission(value))
export const parseInitializeResult = (value: unknown): Parsed<typeof InitializeResultSchema.Type> => toParsed(decodeInitialize(value))
export const parseNewSessionResult = (value: unknown): Parsed<typeof NewSessionResultSchema.Type> => toParsed(decodeNewSession(value))
export const parsePromptResult = (value: unknown): Parsed<typeof PromptResultSchema.Type> => toParsed(decodePrompt(value))
