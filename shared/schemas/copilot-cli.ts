import { Result, Schema } from 'effect'
import { parseOrNull } from './parse'

const PRESERVE = { onExcessProperty: 'preserve' } as const

const optionalString = Schema.optionalKey(Schema.String)

export const CopilotCliEventEnvelopeSchema = Schema.Struct({
  type: Schema.NonEmptyString,
  data: Schema.Unknown,
  id: optionalString,
  timestamp: Schema.String,
  parentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

export const CopilotCliSessionStartSchema = Schema.Struct({
  sessionId: Schema.String,
  version: Schema.Finite,
  producer: optionalString,
  copilotVersion: optionalString,
  startTime: optionalString,
  context: Schema.optionalKey(Schema.Struct({
    cwd: optionalString,
    gitRoot: optionalString,
    branch: optionalString,
    headCommit: optionalString,
    repository: optionalString,
    hostType: optionalString,
  })),
})

export const CopilotCliUserMessageSchema = Schema.Struct({
  content: Schema.String,
  transformedContent: optionalString,
  interactionId: optionalString,
  parentAgentTaskId: optionalString,
})

export const CopilotCliToolRequestSchema = Schema.Struct({
  toolCallId: Schema.String,
  name: Schema.String,
  arguments: Schema.Unknown,
  type: optionalString,
  intentionSummary: optionalString,
})

export const CopilotCliAssistantMessageSchema = Schema.Struct({
  messageId: optionalString,
  model: optionalString,
  content: Schema.String,
  reasoning: optionalString,
  reasoningText: optionalString,
  outputTokens: Schema.optionalKey(Schema.Finite),
  toolRequests: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  interactionId: optionalString,
  turnId: optionalString,
  requestId: optionalString,
})

export const CopilotCliModelChangeSchema = Schema.Struct({
  newModel: Schema.String,
  reasoningEffort: Schema.optionalKey(Schema.NullOr(Schema.String)),
  contextTier: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

export const CopilotCliToolExecutionStartSchema = Schema.Struct({
  toolCallId: Schema.String,
  toolName: Schema.String,
  arguments: Schema.Unknown,
})

export const CopilotCliToolExecutionCompleteSchema = Schema.Struct({
  toolCallId: Schema.String,
  model: optionalString,
  interactionId: optionalString,
  success: Schema.optionalKey(Schema.Boolean),
  error: Schema.optionalKey(Schema.Unknown),
  result: Schema.optionalKey(Schema.Unknown),
})

export const CopilotCliTurnStartSchema = Schema.Struct({
  turnId: Schema.String,
  interactionId: optionalString,
})

export const CopilotCliTurnEndSchema = Schema.Struct({
  turnId: Schema.String,
})

export const CopilotCliSessionShutdownSchema = Schema.Struct({
  shutdownType: optionalString,
  currentModel: optionalString,
})

export const CopilotCliAbortSchema = Schema.Struct({
  reason: optionalString,
})

export const CopilotCliArgumentsSchema = Schema.Record(Schema.String, Schema.Unknown)

export const CopilotCliToolResultSchema = Schema.Struct({
  content: optionalString,
  detailedContent: optionalString,
})

export type CopilotCliSessionStart = typeof CopilotCliSessionStartSchema.Type
export type CopilotCliUserMessage = typeof CopilotCliUserMessageSchema.Type
export type CopilotCliAssistantMessage = typeof CopilotCliAssistantMessageSchema.Type
export type CopilotCliToolRequest = typeof CopilotCliToolRequestSchema.Type
export type CopilotCliModelChange = typeof CopilotCliModelChangeSchema.Type
export type CopilotCliToolExecutionStart = typeof CopilotCliToolExecutionStartSchema.Type
export type CopilotCliToolExecutionComplete = typeof CopilotCliToolExecutionCompleteSchema.Type
export type CopilotCliTurnStart = typeof CopilotCliTurnStartSchema.Type
export type CopilotCliTurnEnd = typeof CopilotCliTurnEndSchema.Type
export type CopilotCliSessionShutdown = typeof CopilotCliSessionShutdownSchema.Type
export type CopilotCliAbort = typeof CopilotCliAbortSchema.Type

export type ParsedCopilotCliEvent =
  | { kind: 'session.start', timestamp: string, data: CopilotCliSessionStart }
  | { kind: 'user.message', timestamp: string, data: CopilotCliUserMessage }
  | { kind: 'assistant.message', timestamp: string, data: CopilotCliAssistantMessage }
  | { kind: 'session.model_change', timestamp: string, data: CopilotCliModelChange }
  | { kind: 'tool.execution_start', timestamp: string, data: CopilotCliToolExecutionStart }
  | { kind: 'tool.execution_complete', timestamp: string, data: CopilotCliToolExecutionComplete }
  | { kind: 'assistant.turn_start', timestamp: string, data: CopilotCliTurnStart }
  | { kind: 'assistant.turn_end', timestamp: string, data: CopilotCliTurnEnd }
  | { kind: 'session.shutdown', timestamp: string, data: CopilotCliSessionShutdown }
  | { kind: 'abort', timestamp: string, data: CopilotCliAbort }
  | { kind: 'unknown', timestamp: string, type: string }

export type CopilotCliParseResult =
  | { success: true, event: ParsedCopilotCliEvent }
  | { success: false, known: boolean, error: Schema.SchemaError }

/**
 * Envelope fields shared by every known event shape. Each per-type struct
 * below decodes the *whole* wire message (not just `data`), so the tagged
 * union can discriminate on `type` directly against the raw value.
 */
const eventEnvelopeFields = {
  id: optionalString,
  timestamp: Schema.String,
  parentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
}

const CopilotCliEventSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal('session.start'), ...eventEnvelopeFields, data: CopilotCliSessionStartSchema }),
  Schema.Struct({ type: Schema.Literal('user.message'), ...eventEnvelopeFields, data: CopilotCliUserMessageSchema }),
  Schema.Struct({ type: Schema.Literal('assistant.message'), ...eventEnvelopeFields, data: CopilotCliAssistantMessageSchema }),
  Schema.Struct({ type: Schema.Literal('session.model_change'), ...eventEnvelopeFields, data: CopilotCliModelChangeSchema }),
  Schema.Struct({ type: Schema.Literal('tool.execution_start'), ...eventEnvelopeFields, data: CopilotCliToolExecutionStartSchema }),
  Schema.Struct({ type: Schema.Literal('tool.execution_complete'), ...eventEnvelopeFields, data: CopilotCliToolExecutionCompleteSchema }),
  Schema.Struct({ type: Schema.Literal('assistant.turn_start'), ...eventEnvelopeFields, data: CopilotCliTurnStartSchema }),
  Schema.Struct({ type: Schema.Literal('assistant.turn_end'), ...eventEnvelopeFields, data: CopilotCliTurnEndSchema }),
  Schema.Struct({ type: Schema.Literal('session.shutdown'), ...eventEnvelopeFields, data: CopilotCliSessionShutdownSchema }),
  Schema.Struct({ type: Schema.Literal('abort'), ...eventEnvelopeFields, data: CopilotCliAbortSchema }),
]).pipe(Schema.toTaggedUnion('type'))

const decodeEnvelope = Schema.decodeUnknownResult(CopilotCliEventEnvelopeSchema, PRESERVE)
const decodeEvent = Schema.decodeUnknownResult(CopilotCliEventSchema, PRESERVE)

export function parseCopilotCliEvent(value: unknown): CopilotCliParseResult {
  const envelope = decodeEnvelope(value)
  if (!Result.isSuccess(envelope)) return { success: false, known: false, error: envelope.failure }
  const { timestamp, type } = envelope.success
  if (!Object.hasOwn(CopilotCliEventSchema.cases, type)) {
    return { success: true, event: { kind: 'unknown', timestamp, type } }
  }

  const parsed = decodeEvent(value)
  if (!Result.isSuccess(parsed)) return { success: false, known: true, error: parsed.failure }
  const { type: kind, data } = parsed.success
  return { success: true, event: { kind, timestamp, data } as ParsedCopilotCliEvent }
}

export const parseCopilotCliToolRequest = parseOrNull(CopilotCliToolRequestSchema, PRESERVE)
export const parseCopilotCliArguments = parseOrNull(CopilotCliArgumentsSchema, PRESERVE)
export const parseCopilotCliToolResult = parseOrNull(CopilotCliToolResultSchema, PRESERVE)
