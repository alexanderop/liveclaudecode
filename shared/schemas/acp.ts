import { Result, Schema } from 'effect'

/**
 * Schemas for the Agent Client Protocol (ACP) wire format: newline-delimited
 * JSON-RPC 2.0 spoken over an agent subprocess's stdio.
 *
 * Agents (claude-agent-acp, codex-acp, Copilot CLI) extend the protocol over
 * time — unknown update variants, `_meta` fields, extra permission option ids
 * — so every decoder preserves excess properties and unknown variants degrade
 * to a raw envelope instead of failing the connection.
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
export type InitializeResult = typeof InitializeResultSchema.Type

export const NewSessionResultSchema = Schema.Struct({
  sessionId: Schema.String,
})
export type NewSessionResult = typeof NewSessionResultSchema.Type

export const PromptResultSchema = Schema.Struct({
  stopReason: Schema.String,
})
export type PromptResult = typeof PromptResultSchema.Type

// -- session/update notification --------------------------------------------

const ContentBlockSchema = Schema.Struct({
  type: Schema.String,
  text: Schema.optionalKey(Schema.String),
})

// `toTaggedUnion` requires a single literal discriminant per member, so each
// `sessionUpdate` value gets its own struct rather than one struct sharing a
// `Schema.Literals([...])` field across variants.
const AgentMessageChunkSchema = Schema.Struct({
  sessionUpdate: Schema.Literal('agent_message_chunk'),
  content: ContentBlockSchema,
})
const AgentThoughtChunkSchema = Schema.Struct({
  sessionUpdate: Schema.Literal('agent_thought_chunk'),
  content: ContentBlockSchema,
})
const UserMessageChunkSchema = Schema.Struct({
  sessionUpdate: Schema.Literal('user_message_chunk'),
  content: ContentBlockSchema,
})

const toolCallFields = {
  toolCallId: Schema.String,
  title: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
}
const ToolCallSchema = Schema.Struct({ sessionUpdate: Schema.Literal('tool_call'), ...toolCallFields })
const ToolCallUpdateSchema = Schema.Struct({ sessionUpdate: Schema.Literal('tool_call_update'), ...toolCallFields })

/**
 * Every known `session/update` variant as one discriminated union keyed on
 * `sessionUpdate`. Unlike a plain `Schema.Union`, this excludes the raw
 * envelope from the decoded type, so a `switch` on `sessionUpdate` narrows
 * cleanly instead of keeping the wide "could still be anything" envelope
 * member alive in every case.
 */
export const SessionUpdateSchema = Schema.Union([
  AgentMessageChunkSchema,
  AgentThoughtChunkSchema,
  UserMessageChunkSchema,
  ToolCallSchema,
  ToolCallUpdateSchema,
]).pipe(Schema.toTaggedUnion('sessionUpdate'))
export type SessionUpdate = typeof SessionUpdateSchema.Type

/** Catch-all envelope for update variants (plan, keepalive, …) we don't model yet. */
export const SessionUpdateEnvelopeSchema = Schema.Struct({
  sessionUpdate: Schema.String,
})
export type SessionUpdateEnvelope = typeof SessionUpdateEnvelopeSchema.Type

export type ParsedSessionUpdate =
  | { kind: 'known', data: SessionUpdate }
  | { kind: 'unknown', data: SessionUpdateEnvelope }

export interface SessionNotification {
  sessionId: string
  update: ParsedSessionUpdate
}

const SessionNotificationEnvelopeSchema = Schema.Struct({
  sessionId: Schema.String,
  update: Schema.Unknown,
})

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

export const parseInboundMessage = Schema.decodeUnknownResult(InboundMessageSchema, PRESERVE)
export const parsePermissionRequest = Schema.decodeUnknownResult(PermissionRequestSchema, PRESERVE)
export const parseInitializeResult = Schema.decodeUnknownResult(InitializeResultSchema, PRESERVE)
export const parseNewSessionResult = Schema.decodeUnknownResult(NewSessionResultSchema, PRESERVE)
export const parsePromptResult = Schema.decodeUnknownResult(PromptResultSchema, PRESERVE)

const decodeNotificationEnvelope = Schema.decodeUnknownResult(SessionNotificationEnvelopeSchema, PRESERVE)
const decodeUpdateEnvelope = Schema.decodeUnknownResult(SessionUpdateEnvelopeSchema, PRESERVE)
const decodeKnownUpdate = Schema.decodeUnknownResult(SessionUpdateSchema, PRESERVE)

/**
 * A `session/update` whose `sessionUpdate` tag we do not know yet is expected
 * and degrades to `{ kind: 'unknown', ... }` rather than failing the
 * notification outright — Claude/Codex/Copilot's ACP agents add variants
 * (plan, keepalive, …) over time.
 */
export function parseSessionNotification(
  value: unknown,
): Result.Result<SessionNotification, Schema.SchemaError> {
  const envelope = decodeNotificationEnvelope(value)
  if (Result.isFailure(envelope)) return Result.fail(envelope.failure)
  const updateEnvelope = decodeUpdateEnvelope(envelope.success.update)
  if (Result.isFailure(updateEnvelope)) return Result.fail(updateEnvelope.failure)
  if (!Object.hasOwn(SessionUpdateSchema.cases, updateEnvelope.success.sessionUpdate)) {
    return Result.succeed({
      sessionId: envelope.success.sessionId,
      update: { kind: 'unknown', data: updateEnvelope.success },
    })
  }
  const known = decodeKnownUpdate(envelope.success.update)
  if (Result.isFailure(known)) return Result.fail(known.failure)
  return Result.succeed({
    sessionId: envelope.success.sessionId,
    update: { kind: 'known', data: known.success },
  })
}
