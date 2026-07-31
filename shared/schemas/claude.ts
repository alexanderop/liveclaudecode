import { Result, Schema } from 'effect'
import { NonNegativeInt, parseOrNull } from './parse'

/**
 * Schemas for the JSONL records Claude Code appends to a transcript.
 *
 * Claude Code adds fields to the transcript format over time, and this tool
 * must keep working when it does. `Schema.Struct` strips undeclared keys by
 * default, so every decoder here is built with `PRESERVE` — the equivalent of
 * the `.passthrough()` the zod schemas relied on. It applies recursively,
 * through nested structs and union members alike.
 */
const PRESERVE = { onExcessProperty: 'preserve' } as const

const MessageContent = Schema.Union([Schema.String, Schema.Array(Schema.Unknown)])

/** Fields shared by every record shape Claude Code writes. */
const baseFields = {
  timestamp: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  sessionId: Schema.optionalKey(Schema.String),
  session_id: Schema.optionalKey(Schema.String),
  uuid: Schema.optionalKey(Schema.String),
  parentUuid: Schema.optionalKey(Schema.NullOr(Schema.String)),
  logicalParentUuid: Schema.optionalKey(Schema.String),
  agentId: Schema.optionalKey(Schema.String),
  isSidechain: Schema.optionalKey(Schema.Boolean),
  entrypoint: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
  gitBranch: Schema.optionalKey(Schema.String),
  userType: Schema.optionalKey(Schema.String),
}

// -- Content blocks ---------------------------------------------------------

export const ClaudeCacheCreationSchema = Schema.Struct({
  ephemeral_5m_input_tokens: Schema.optionalKey(NonNegativeInt),
  ephemeral_1h_input_tokens: Schema.optionalKey(NonNegativeInt),
})

export const ClaudeServerToolUseSchema = Schema.Struct({
  web_search_requests: Schema.optionalKey(NonNegativeInt),
})

export const ClaudeUsageSchema = Schema.Struct({
  input_tokens: Schema.optionalKey(NonNegativeInt),
  output_tokens: Schema.optionalKey(NonNegativeInt),
  cache_read_input_tokens: Schema.optionalKey(NonNegativeInt),
  cache_creation_input_tokens: Schema.optionalKey(NonNegativeInt),
  cache_creation: Schema.optionalKey(ClaudeCacheCreationSchema),
  server_tool_use: Schema.optionalKey(ClaudeServerToolUseSchema),
  service_tier: Schema.optionalKey(Schema.String),
  inference_geo: Schema.optionalKey(Schema.String),
  speed: Schema.optionalKey(Schema.String),
})

export const ClaudeTextBlockSchema = Schema.Struct({
  type: Schema.Literal('text'),
  text: Schema.String,
})

export const ClaudeThinkingBlockSchema = Schema.Struct({
  type: Schema.Literal('thinking'),
  thinking: Schema.String,
  signature: Schema.optionalKey(Schema.String),
})

export const ClaudeToolUseBlockSchema = Schema.Struct({
  type: Schema.Literal('tool_use'),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Record(Schema.String, Schema.Unknown),
  caller: Schema.optionalKey(Schema.Struct({ type: Schema.String })),
})

export const ClaudeToolResultBlockSchema = Schema.Struct({
  type: Schema.Literal('tool_result'),
  tool_use_id: Schema.String,
  content: Schema.optionalKey(Schema.Unknown),
  is_error: Schema.optionalKey(Schema.Boolean),
})

export const ClaudeImageBlockSchema = Schema.Struct({
  type: Schema.Literal('image'),
  source: Schema.optionalKey(Schema.Unknown),
})

export const ClaudeContentBlockEnvelopeSchema = Schema.Struct({
  type: Schema.NonEmptyString,
})

export const ClaudeAssistantBlockSchema = Schema.Union([
  ClaudeTextBlockSchema,
  ClaudeThinkingBlockSchema,
  ClaudeToolUseBlockSchema,
]).pipe(Schema.toTaggedUnion('type'))

export const ClaudeUserBlockSchema = Schema.Union([
  ClaudeTextBlockSchema,
  ClaudeToolResultBlockSchema,
  ClaudeImageBlockSchema,
]).pipe(Schema.toTaggedUnion('type'))

export type ClaudeTextBlock = typeof ClaudeTextBlockSchema.Type
export type ClaudeThinkingBlock = typeof ClaudeThinkingBlockSchema.Type
export type ClaudeToolUseBlock = typeof ClaudeToolUseBlockSchema.Type
export type ClaudeToolResultBlock = typeof ClaudeToolResultBlockSchema.Type
export type ClaudeImageBlock = typeof ClaudeImageBlockSchema.Type
export type ClaudeContentBlockEnvelope = typeof ClaudeContentBlockEnvelopeSchema.Type

/** `{ kind, data }` pairs for every tagged member of a block union, derived from its decoded `Type` instead of hand-listed. */
type ParsedTaggedBlock<Block extends { type: string }> = {
  [T in Block['type']]: { kind: T, data: Extract<Block, { type: T }> }
}[Block['type']]

export type ParsedClaudeAssistantBlock =
  | ParsedTaggedBlock<typeof ClaudeAssistantBlockSchema.Type>
  | { kind: 'unknown', data: ClaudeContentBlockEnvelope }

export type ParsedClaudeUserBlock =
  | ParsedTaggedBlock<typeof ClaudeUserBlockSchema.Type>
  | { kind: 'unknown', data: ClaudeContentBlockEnvelope }

const decodeAssistantBlock = Schema.decodeUnknownResult(ClaudeAssistantBlockSchema, PRESERVE)
const decodeUserBlock = Schema.decodeUnknownResult(ClaudeUserBlockSchema, PRESERVE)
const decodeBlockEnvelope = Schema.decodeUnknownResult(ClaudeContentBlockEnvelopeSchema, PRESERVE)

/**
 * A block whose `type` we do not know yet is expected and is reported as
 * `unknown`. A block whose `type` we *do* know but whose body is malformed is
 * a genuine defect and returns `null`, so the caller skips it.
 */
export function parseClaudeAssistantBlock(value: unknown): ParsedClaudeAssistantBlock | null {
  const envelope = decodeBlockEnvelope(value)
  if (!Result.isSuccess(envelope)) return null
  if (!Object.hasOwn(ClaudeAssistantBlockSchema.cases, envelope.success.type)) {
    return { kind: 'unknown', data: envelope.success }
  }
  const block = decodeAssistantBlock(value)
  if (!Result.isSuccess(block)) return null
  return ClaudeAssistantBlockSchema.match(block.success, {
    text: (data): ParsedClaudeAssistantBlock => ({ kind: 'text', data }),
    thinking: (data): ParsedClaudeAssistantBlock => ({ kind: 'thinking', data }),
    tool_use: (data): ParsedClaudeAssistantBlock => ({ kind: 'tool_use', data }),
  })
}

export function parseClaudeUserBlock(value: unknown): ParsedClaudeUserBlock | null {
  const envelope = decodeBlockEnvelope(value)
  if (!Result.isSuccess(envelope)) return null
  if (!Object.hasOwn(ClaudeUserBlockSchema.cases, envelope.success.type)) {
    return { kind: 'unknown', data: envelope.success }
  }
  const block = decodeUserBlock(value)
  if (!Result.isSuccess(block)) return null
  return ClaudeUserBlockSchema.match(block.success, {
    text: (data): ParsedClaudeUserBlock => ({ kind: 'text', data }),
    tool_result: (data): ParsedClaudeUserBlock => ({ kind: 'tool_result', data }),
    image: (data): ParsedClaudeUserBlock => ({ kind: 'image', data }),
  })
}

// -- Messages ---------------------------------------------------------------

export const ClaudeAssistantMessageSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  role: Schema.optionalKey(Schema.Literal('assistant')),
  model: Schema.optionalKey(Schema.String),
  content: MessageContent,
  usage: Schema.optionalKey(ClaudeUsageSchema),
  stop_reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

export const ClaudeUserMessageSchema = Schema.Struct({
  role: Schema.optionalKey(Schema.Literal('user')),
  content: MessageContent,
})

/**
 * The set of messages kept across a compaction.
 *
 * Verified against real transcript records: this is currently an object, never
 * a count. The numeric union preserves compatibility with older or future
 * count-shaped payloads.
 */
export const ClaudePreservedMessagesSchema = Schema.Struct({
  anchorUuid: Schema.optionalKey(Schema.String),
  uuids: Schema.optionalKey(Schema.Array(Schema.String)),
  allUuids: Schema.optionalKey(Schema.Array(Schema.String)),
})

/**
 * `compact_boundary` payload. Declared explicitly so the transcript reader can
 * consume typed values instead of coercing an `unknown` record field by field.
 */
export const ClaudeCompactMetadataSchema = Schema.Struct({
  durationMs: Schema.optionalKey(Schema.Finite),
  preTokens: Schema.optionalKey(Schema.Finite),
  postTokens: Schema.optionalKey(Schema.Finite),
  cumulativeDroppedTokens: Schema.optionalKey(Schema.Finite),
  preservedMessages: Schema.optionalKey(
    Schema.Union([Schema.Finite, ClaudePreservedMessagesSchema]),
  ),
  trigger: Schema.optionalKey(Schema.String),
})

// -- Records ----------------------------------------------------------------

export const ClaudeAssistantRecordSchema = Schema.Struct({
  ...baseFields,
  type: Schema.Literal('assistant'),
  message: ClaudeAssistantMessageSchema,
  requestId: Schema.optionalKey(Schema.String),
  attributionSkill: Schema.optionalKey(Schema.String),
  attributionAgent: Schema.optionalKey(Schema.String),
  attributionPlugin: Schema.optionalKey(Schema.String),
  attributionMcpServer: Schema.optionalKey(Schema.String),
  attributionMcpTool: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Schema.String),
  isApiErrorMessage: Schema.optionalKey(Schema.Boolean),
  error: Schema.optionalKey(Schema.String),
  apiErrorStatus: Schema.optionalKey(Schema.Finite),
})

export const ClaudeUserRecordSchema = Schema.Struct({
  ...baseFields,
  type: Schema.Literal('user'),
  message: ClaudeUserMessageSchema,
  isMeta: Schema.optionalKey(Schema.Boolean),
  promptId: Schema.optionalKey(Schema.String),
  sourceToolUseID: Schema.optionalKey(Schema.String),
  sourceToolAssistantUUID: Schema.optionalKey(Schema.String),
  toolUseResult: Schema.optionalKey(Schema.Unknown),
  promptSource: Schema.optionalKey(Schema.String),
  toolDenialKind: Schema.optionalKey(Schema.String),
  interruptedMessageId: Schema.optionalKey(Schema.String),
  isCompactSummary: Schema.optionalKey(Schema.Boolean),
  permissionMode: Schema.optionalKey(Schema.String),
})

export const ClaudeSystemRecordSchema = Schema.Struct({
  ...baseFields,
  type: Schema.Literal('system'),
  subtype: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.String),
  level: Schema.optionalKey(Schema.String),
  isMeta: Schema.optionalKey(Schema.Boolean),
  durationMs: Schema.optionalKey(Schema.Finite),
  messageCount: Schema.optionalKey(Schema.Finite),
  pendingBackgroundAgentCount: Schema.optionalKey(Schema.Finite),
  pendingWorkflowCount: Schema.optionalKey(Schema.Finite),
  compactMetadata: Schema.optionalKey(ClaudeCompactMetadataSchema),
  // `hookErrors` is currently a list, while the numeric union preserves
  // compatibility with a count-shaped payload.
  hookErrors: Schema.optionalKey(Schema.Union([Schema.Finite, Schema.Array(Schema.Unknown)])),
  preventedContinuation: Schema.optionalKey(Schema.Boolean),
  toolUseID: Schema.optionalKey(Schema.String),
})

export const ClaudeAttachmentRecordSchema = Schema.Struct({
  ...baseFields,
  type: Schema.Literal('attachment'),
  attachment: Schema.Struct({ type: Schema.NonEmptyString }),
})

export const ClaudeWorkflowStartedRecordSchema = Schema.Struct({
  type: Schema.Literal('started'),
  agentId: Schema.String,
  key: Schema.String,
})

export const ClaudeWorkflowResultRecordSchema = Schema.Struct({
  type: Schema.Literal('result'),
  agentId: Schema.String,
  key: Schema.String,
  result: Schema.optionalKey(Schema.Unknown),
})

const sessionStateMembers = [
  Schema.Struct({ type: Schema.Literal('last-prompt'), sessionId: Schema.String, lastPrompt: Schema.optionalKey(Schema.String), leafUuid: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ type: Schema.Literal('mode'), sessionId: Schema.String, mode: Schema.String }),
  Schema.Struct({ type: Schema.Literal('permission-mode'), sessionId: Schema.String, permissionMode: Schema.String }),
  Schema.Struct({ type: Schema.Literal('ai-title'), sessionId: Schema.String, aiTitle: Schema.String }),
  Schema.Struct({ type: Schema.Literal('custom-title'), sessionId: Schema.String, customTitle: Schema.String }),
  Schema.Struct({ type: Schema.Literal('agent-name'), sessionId: Schema.String, agentName: Schema.String }),
  Schema.Struct({ type: Schema.Literal('bridge-session'), sessionId: Schema.String, bridgeSessionId: Schema.String, lastSequenceNum: Schema.Finite }),
  Schema.Struct({ type: Schema.Literal('queue-operation'), sessionId: Schema.String, operation: Schema.String, content: Schema.optionalKey(Schema.Unknown), timestamp: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ type: Schema.Literal('file-history-snapshot'), messageId: Schema.String, snapshot: Schema.optionalKey(Schema.Unknown) }),
  Schema.Struct({ type: Schema.Literal('file-history-delta'), messageId: Schema.String, snapshotMessageId: Schema.String, backup: Schema.optionalKey(Schema.Unknown) }),
  Schema.Struct({ type: Schema.Literal('pr-link'), sessionId: Schema.String, prNumber: Schema.Finite, prRepository: Schema.String, prUrl: Schema.String, timestamp: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ type: Schema.Literal('frame-link'), sessionId: Schema.String, path: Schema.String, frameUrl: Schema.String, title: Schema.optionalKey(Schema.String), timestamp: Schema.optionalKey(Schema.String) }),
] as const

export const ClaudeSessionStateRecordSchema = Schema.Union(sessionStateMembers)

export const ClaudeRecordEnvelopeSchema = Schema.Struct({
  type: Schema.NonEmptyString,
})

/**
 * Every known record shape as one discriminated union keyed on `type`.
 *
 * This replaces the hand-written `switch` that dispatched to a schema and then
 * cast the result — the cast could not verify that the `kind` label actually
 * matched the schema that produced the data.
 */
export const ClaudeRecordSchema = Schema.Union([
  ClaudeAssistantRecordSchema,
  ClaudeUserRecordSchema,
  ClaudeSystemRecordSchema,
  ClaudeAttachmentRecordSchema,
  ClaudeWorkflowStartedRecordSchema,
  ClaudeWorkflowResultRecordSchema,
  ...sessionStateMembers,
]).pipe(Schema.toTaggedUnion('type'))

export type ClaudeAssistantRecord = typeof ClaudeAssistantRecordSchema.Type
export type ClaudeUserRecord = typeof ClaudeUserRecordSchema.Type
export type ClaudeSystemRecord = typeof ClaudeSystemRecordSchema.Type
export type ClaudeAttachmentRecord = typeof ClaudeAttachmentRecordSchema.Type
export type ClaudeSessionStateRecord = typeof ClaudeSessionStateRecordSchema.Type
export type ClaudeWorkflowStartedRecord = typeof ClaudeWorkflowStartedRecordSchema.Type
export type ClaudeWorkflowResultRecord = typeof ClaudeWorkflowResultRecordSchema.Type
export type ClaudeRecordEnvelope = typeof ClaudeRecordEnvelopeSchema.Type
export type ClaudeRecord = typeof ClaudeRecordSchema.Type
export type ClaudeRecordType = ClaudeRecord['type']

export type ParsedClaudeRecord =
  | { kind: 'assistant', data: ClaudeAssistantRecord }
  | { kind: 'user', data: ClaudeUserRecord }
  | { kind: 'system', data: ClaudeSystemRecord }
  | { kind: 'attachment', data: ClaudeAttachmentRecord }
  | { kind: 'session_state', data: ClaudeSessionStateRecord }
  | { kind: 'workflow_started', data: ClaudeWorkflowStartedRecord }
  | { kind: 'workflow_result', data: ClaudeWorkflowResultRecord }
  | { kind: 'unknown', data: ClaudeRecordEnvelope }

export type ClaudeRecordParseResult =
  | { success: true, record: ParsedClaudeRecord }
  | { success: false, error: Schema.SchemaError }

const decodeRecord = Schema.decodeUnknownResult(ClaudeRecordSchema, PRESERVE)
const decodeRecordEnvelope = Schema.decodeUnknownResult(ClaudeRecordEnvelopeSchema, PRESERVE)

export function parseClaudeRecord(value: unknown): ClaudeRecordParseResult {
  const envelope = decodeRecordEnvelope(value)
  if (!Result.isSuccess(envelope)) return { success: false, error: envelope.failure }

  // An unrecognised `type` is expected — Claude Code adds record kinds over
  // time, and those are surfaced as `unknown` rather than treated as errors.
  const { type } = envelope.success
  if (!Object.hasOwn(ClaudeRecordSchema.cases, type)) {
    return { success: true, record: { kind: 'unknown', data: envelope.success } }
  }

  // A known `type` that fails to decode is a real defect, not a new field.
  const record = decodeRecord(value)
  if (!Result.isSuccess(record)) return { success: false, error: record.failure }

  // `.match` requires a handler for every tag `ClaudeRecordSchema` declares,
  // so the mapping to `ParsedClaudeRecord['kind']` stays exhaustive without a
  // separate lookup table or a cast at the end.
  return {
    success: true,
    record: ClaudeRecordSchema.match(record.success, {
      assistant: (data): ParsedClaudeRecord => ({ kind: 'assistant', data }),
      user: (data): ParsedClaudeRecord => ({ kind: 'user', data }),
      system: (data): ParsedClaudeRecord => ({ kind: 'system', data }),
      attachment: (data): ParsedClaudeRecord => ({ kind: 'attachment', data }),
      started: (data): ParsedClaudeRecord => ({ kind: 'workflow_started', data }),
      result: (data): ParsedClaudeRecord => ({ kind: 'workflow_result', data }),
      'last-prompt': (data): ParsedClaudeRecord => ({ kind: 'session_state', data }),
      'mode': (data): ParsedClaudeRecord => ({ kind: 'session_state', data }),
      'permission-mode': (data): ParsedClaudeRecord => ({ kind: 'session_state', data }),
      'ai-title': (data): ParsedClaudeRecord => ({ kind: 'session_state', data }),
      'custom-title': (data): ParsedClaudeRecord => ({ kind: 'session_state', data }),
      'agent-name': (data): ParsedClaudeRecord => ({ kind: 'session_state', data }),
      'bridge-session': (data): ParsedClaudeRecord => ({ kind: 'session_state', data }),
      'queue-operation': (data): ParsedClaudeRecord => ({ kind: 'session_state', data }),
      'file-history-snapshot': (data): ParsedClaudeRecord => ({ kind: 'session_state', data }),
      'file-history-delta': (data): ParsedClaudeRecord => ({ kind: 'session_state', data }),
      'pr-link': (data): ParsedClaudeRecord => ({ kind: 'session_state', data }),
      'frame-link': (data): ParsedClaudeRecord => ({ kind: 'session_state', data }),
    }),
  }
}

// -- Subagent metadata ------------------------------------------------------

export const ClaudeSubagentMetaSchema = Schema.Struct({
  agentType: Schema.String,
  description: Schema.optionalKey(Schema.String),
  spawnDepth: Schema.optionalKey(NonNegativeInt),
  toolUseId: Schema.optionalKey(Schema.String),
  parentAgentId: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  stoppedByUser: Schema.optionalKey(Schema.Boolean),
})

export type ClaudeSubagentMeta = typeof ClaudeSubagentMetaSchema.Type

export const parseClaudeSubagentMeta = parseOrNull(ClaudeSubagentMetaSchema, PRESERVE)

/**
 * Subagent metadata is persisted as a JSON file. Composing with
 * `fromJsonString` lets a malformed file surface as a normal decode failure
 * instead of a raw `JSON.parse` throw the caller has to catch by hand.
 */
export const ClaudeSubagentMetaFromJsonSchema = Schema.fromJsonString(ClaudeSubagentMetaSchema)

const decodeSubagentMetaJson = Schema.decodeUnknownResult(ClaudeSubagentMetaFromJsonSchema, PRESERVE)

/** Decode a JSON-encoded subagent metadata file, reporting a parse failure as a `Result` failure. */
export function parseClaudeSubagentMetaJson(
  value: string,
): Result.Result<ClaudeSubagentMeta, Schema.SchemaError> {
  return decodeSubagentMetaJson(value)
}
