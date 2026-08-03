import { Result, Schema } from 'effect'
import { NonNegativeInt, parseOrNull } from './parse'

const PRESERVE = { onExcessProperty: 'preserve' } as const

const optionalString = Schema.optionalKey(Schema.String)
const optionalFinite = Schema.optionalKey(Schema.Finite)
const optionalNonNegativeInt = Schema.optionalKey(NonNegativeInt)

export const CodexRecordEnvelopeSchema = Schema.Struct({
  timestamp: Schema.optionalKey(Schema.String),
  type: Schema.NonEmptyString,
  payload: Schema.Unknown,
})

export const CodexSessionMetaPayloadSchema = Schema.Struct({
  id: Schema.String,
  timestamp: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  originator: Schema.optionalKey(Schema.String),
  cli_version: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.Unknown),
  thread_source: Schema.optionalKey(Schema.String),
  model_provider: Schema.optionalKey(Schema.String),
  history_mode: Schema.optionalKey(Schema.String),
  git: Schema.optionalKey(Schema.Struct({
    branch: Schema.optionalKey(Schema.String),
    commit_hash: Schema.optionalKey(Schema.String),
    repository_url: Schema.optionalKey(Schema.String),
  })),
})

export const CodexThreadSpawnSchema = Schema.Struct({
  parent_thread_id: Schema.String,
  depth: Schema.optionalKey(Schema.Finite),
  agent_path: Schema.optionalKey(Schema.NullOr(Schema.String)),
  agent_nickname: Schema.optionalKey(Schema.NullOr(Schema.String)),
  agent_role: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

export const CodexSessionSourceSchema = Schema.Union([
  Schema.String,
  Schema.Struct({ subagent: Schema.String }),
  Schema.Struct({
    subagent: Schema.Struct({ thread_spawn: CodexThreadSpawnSchema }),
  }),
])

export const CodexTurnContextPayloadSchema = Schema.Struct({
  turn_id: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Schema.String),
  approval_policy: Schema.optionalKey(Schema.String),
  sandbox_policy: Schema.optionalKey(Schema.Unknown),
  workspace_roots: Schema.optionalKey(Schema.Array(Schema.String)),
})

export const CodexTextContentSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal('input_text'), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal('output_text'), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal('summary_text'), text: Schema.String }),
]).pipe(Schema.toTaggedUnion('type'))

export const CodexMessageItemSchema = Schema.Struct({
  type: Schema.Literal('message'),
  role: Schema.Literals(['user', 'assistant', 'developer', 'system']),
  content: Schema.Array(Schema.Unknown),
  id: optionalString,
  phase: optionalString,
})

export const CodexFunctionCallItemSchema = Schema.Struct({
  type: Schema.Literal('function_call'),
  name: Schema.String,
  call_id: Schema.String,
  arguments: Schema.String,
  id: optionalString,
})

export const CodexFunctionCallOutputItemSchema = Schema.Struct({
  type: Schema.Literal('function_call_output'),
  call_id: Schema.String,
  output: Schema.Unknown,
  id: optionalString,
})

export const CodexCustomToolCallItemSchema = Schema.Struct({
  type: Schema.Literal('custom_tool_call'),
  name: Schema.String,
  call_id: Schema.String,
  input: Schema.String,
  id: optionalString,
  status: optionalString,
})

export const CodexCustomToolCallOutputItemSchema = Schema.Struct({
  type: Schema.Literal('custom_tool_call_output'),
  call_id: Schema.String,
  output: Schema.Unknown,
  id: optionalString,
})

export const CodexReasoningItemSchema = Schema.Struct({
  type: Schema.Literal('reasoning'),
  id: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  encrypted_content: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

export const CodexResponseItemSchema = Schema.Union([
  CodexMessageItemSchema,
  CodexFunctionCallItemSchema,
  CodexFunctionCallOutputItemSchema,
  CodexCustomToolCallItemSchema,
  CodexCustomToolCallOutputItemSchema,
  CodexReasoningItemSchema,
]).pipe(Schema.toTaggedUnion('type'))

export const CodexResponseItemEnvelopeSchema = Schema.Struct({
  type: Schema.NonEmptyString,
})

export const CodexUsageSchema = Schema.Struct({
  input_tokens: optionalNonNegativeInt,
  cached_input_tokens: optionalNonNegativeInt,
  output_tokens: optionalNonNegativeInt,
  reasoning_output_tokens: optionalNonNegativeInt,
  total_tokens: optionalNonNegativeInt,
})

export const CodexTokenCountPayloadSchema = Schema.Struct({
  type: Schema.Literal('token_count'),
  info: Schema.optionalKey(Schema.NullOr(Schema.Struct({
    total_token_usage: Schema.optionalKey(CodexUsageSchema),
    last_token_usage: Schema.optionalKey(CodexUsageSchema),
    model_context_window: optionalFinite,
  }))),
})

export const CodexPatchApplyEndPayloadSchema = Schema.Struct({
  type: Schema.Literal('patch_apply_end'),
  call_id: Schema.optionalKey(Schema.String),
  success: Schema.optionalKey(Schema.Boolean),
  status: Schema.optionalKey(Schema.String),
  changes: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  stderr: Schema.optionalKey(Schema.String),
  stdout: Schema.optionalKey(Schema.String),
})

export const CodexAgentMessagePayloadSchema = Schema.Struct({
  type: Schema.Literal('agent_message'),
  message: Schema.String,
  phase: Schema.optionalKey(Schema.String),
})

export const CodexAgentReasoningPayloadSchema = Schema.Struct({
  type: Schema.Literal('agent_reasoning'),
  text: Schema.String,
})

export const CodexUserMessagePayloadSchema = Schema.Struct({
  type: Schema.Literal('user_message'),
  message: Schema.optionalKey(Schema.String),
})

export const CodexTaskStartedPayloadSchema = Schema.Struct({
  type: Schema.Literal('task_started'),
  turn_id: Schema.optionalKey(Schema.String),
  started_at: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite])),
})

export const CodexTaskCompletePayloadSchema = Schema.Struct({
  type: Schema.Literal('task_complete'),
  turn_id: Schema.optionalKey(Schema.String),
})

export const CodexTurnAbortedPayloadSchema = Schema.Struct({
  type: Schema.Literal('turn_aborted'),
  turn_id: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
})

export const CodexContextCompactedPayloadSchema = Schema.Struct({
  type: Schema.Literal('context_compacted'),
})

export const CodexMcpToolCallEndPayloadSchema = Schema.Struct({
  type: Schema.Literal('mcp_tool_call_end'),
  call_id: Schema.optionalKey(Schema.String),
  invocation: Schema.optionalKey(Schema.Struct({
    server: Schema.optionalKey(Schema.String),
    tool: Schema.optionalKey(Schema.String),
    arguments: Schema.optionalKey(Schema.Unknown),
  })),
  result: Schema.optionalKey(Schema.Unknown),
})

export const CodexEventPayloadSchema = Schema.Union([
  CodexTokenCountPayloadSchema,
  CodexPatchApplyEndPayloadSchema,
  CodexAgentMessagePayloadSchema,
  CodexAgentReasoningPayloadSchema,
  CodexUserMessagePayloadSchema,
  CodexTaskStartedPayloadSchema,
  CodexTaskCompletePayloadSchema,
  CodexTurnAbortedPayloadSchema,
  CodexContextCompactedPayloadSchema,
  CodexMcpToolCallEndPayloadSchema,
]).pipe(Schema.toTaggedUnion('type'))

export const CodexEventPayloadEnvelopeSchema = Schema.Struct({
  type: Schema.NonEmptyString,
})

export const CodexToolArgumentsSchema = Schema.Record(Schema.String, Schema.Unknown)

export const CodexToolOutputSchema = Schema.Struct({
  isError: Schema.optionalKey(Schema.Boolean),
  error: Schema.optionalKey(Schema.Boolean),
  exit_code: Schema.optionalKey(Schema.Finite),
  success: Schema.optionalKey(Schema.Boolean),
  status: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.Unknown),
})

export const CodexPlanInputSchema = Schema.Struct({
  plan: Schema.Array(Schema.Struct({
    step: Schema.String,
    status: Schema.String,
  })),
})

/**
 * Tool call `arguments`/`input` and `function_call_output`/`custom_tool_call_output`
 * fields sometimes arrive as JSON-encoded strings rather than parsed values.
 * These compose the existing structural schemas with `fromJsonString` so a
 * malformed string surfaces as a normal decode failure instead of a raw
 * `JSON.parse` throw the caller has to catch by hand.
 */
export const CodexToolArgumentsFromJsonSchema = Schema.fromJsonString(CodexToolArgumentsSchema)
export const CodexToolOutputFromJsonSchema = Schema.fromJsonString(CodexToolOutputSchema)

export type CodexSessionMetaPayload = typeof CodexSessionMetaPayloadSchema.Type
export type CodexTurnContextPayload = typeof CodexTurnContextPayloadSchema.Type
export type CodexResponseItem = typeof CodexResponseItemSchema.Type
export type CodexEventPayload = typeof CodexEventPayloadSchema.Type
export type CodexThreadSpawn = typeof CodexThreadSpawnSchema.Type

export type ParsedCodexRecord =
  | { kind: 'session_meta', timestamp?: string, data: CodexSessionMetaPayload }
  | { kind: 'turn_context', timestamp?: string, data: CodexTurnContextPayload }
  | { kind: 'response_item', timestamp?: string, data: CodexResponseItem }
  | { kind: 'event_msg', timestamp?: string, data: CodexEventPayload, known: true }
  | { kind: 'event_msg', timestamp?: string, data: { readonly type: string }, known: false }
  | { kind: 'unknown', timestamp?: string, type: string }

export type CodexParseResult =
  | { success: true, record: ParsedCodexRecord }
  | { success: false, known: boolean, error: Schema.SchemaError }

const decodeEnvelope = Schema.decodeUnknownResult(CodexRecordEnvelopeSchema, PRESERVE)
const decodeSessionMeta = Schema.decodeUnknownResult(CodexSessionMetaPayloadSchema, PRESERVE)
const decodeTurnContext = Schema.decodeUnknownResult(CodexTurnContextPayloadSchema, PRESERVE)
const decodeResponseItemEnvelope = Schema.decodeUnknownResult(CodexResponseItemEnvelopeSchema, PRESERVE)
const decodeResponseItem = Schema.decodeUnknownResult(CodexResponseItemSchema, PRESERVE)
const decodeEventEnvelope = Schema.decodeUnknownResult(CodexEventPayloadEnvelopeSchema, PRESERVE)
const decodeEvent = Schema.decodeUnknownResult(CodexEventPayloadSchema, PRESERVE)

export function parseCodexRecord(value: unknown): CodexParseResult {
  const envelope = decodeEnvelope(value)
  if (!Result.isSuccess(envelope)) return { success: false, known: false, error: envelope.failure }
  const { timestamp, type, payload } = envelope.success
  const withTimestamp = timestamp === undefined ? {} : { timestamp }

  if (type === 'session_meta') {
    const parsed = decodeSessionMeta(payload)
    return Result.isSuccess(parsed)
      ? { success: true, record: { kind: 'session_meta', ...withTimestamp, data: parsed.success } }
      : { success: false, known: true, error: parsed.failure }
  }
  if (type === 'turn_context') {
    const parsed = decodeTurnContext(payload)
    return Result.isSuccess(parsed)
      ? { success: true, record: { kind: 'turn_context', ...withTimestamp, data: parsed.success } }
      : { success: false, known: true, error: parsed.failure }
  }
  if (type === 'response_item') {
    const itemEnvelope = decodeResponseItemEnvelope(payload)
    if (!Result.isSuccess(itemEnvelope)) return { success: false, known: true, error: itemEnvelope.failure }
    const known = Object.hasOwn(CodexResponseItemSchema.cases, itemEnvelope.success.type)
    if (!known) {
      return {
        success: true,
        record: {
          kind: 'unknown',
          ...withTimestamp,
          type: `response_item:${itemEnvelope.success.type}`,
        },
      }
    }
    const parsed = decodeResponseItem(payload)
    return Result.isSuccess(parsed)
      ? { success: true, record: { kind: 'response_item', ...withTimestamp, data: parsed.success } }
      : { success: false, known: true, error: parsed.failure }
  }
  if (type === 'event_msg') {
    const eventEnvelope = decodeEventEnvelope(payload)
    if (!Result.isSuccess(eventEnvelope)) return { success: false, known: true, error: eventEnvelope.failure }
    const known = Object.hasOwn(CodexEventPayloadSchema.cases, eventEnvelope.success.type)
    if (!known) {
      return {
        success: true,
        record: { kind: 'event_msg', ...withTimestamp, data: eventEnvelope.success, known: false as const },
      }
    }
    const parsed = decodeEvent(payload)
    return Result.isSuccess(parsed)
      ? { success: true, record: { kind: 'event_msg', ...withTimestamp, data: parsed.success, known: true as const } }
      : { success: false, known: true, error: parsed.failure }
  }
  return { success: true, record: { kind: 'unknown', ...withTimestamp, type } }
}

export const parseCodexSessionSource = parseOrNull(CodexSessionSourceSchema, PRESERVE)
export const parseCodexTextContent = parseOrNull(CodexTextContentSchema, PRESERVE)
export const parseCodexToolArguments = parseOrNull(CodexToolArgumentsSchema, PRESERVE)
export const parseCodexToolOutput = parseOrNull(CodexToolOutputSchema, PRESERVE)
export const parseCodexPlanInput = parseOrNull(CodexPlanInputSchema, PRESERVE)

const decodeToolArgumentsFromJson = Schema.decodeUnknownResult(CodexToolArgumentsFromJsonSchema, PRESERVE)
const decodeToolOutputFromJson = Schema.decodeUnknownResult(CodexToolOutputFromJsonSchema, PRESERVE)

/** Decode a JSON-encoded tool-arguments string, reporting a parse failure as a `Result` failure. */
export function parseCodexToolArgumentsJson(
  value: string,
): Result.Result<typeof CodexToolArgumentsSchema.Type, Schema.SchemaError> {
  return decodeToolArgumentsFromJson(value)
}

/** Decode a JSON-encoded tool-output string, reporting a parse failure as a `Result` failure. */
export function parseCodexToolOutputJson(
  value: string,
): Result.Result<typeof CodexToolOutputSchema.Type, Schema.SchemaError> {
  return decodeToolOutputFromJson(value)
}
