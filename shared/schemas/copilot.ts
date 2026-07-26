import { Result, Schema } from 'effect'

const PRESERVE = { onExcessProperty: 'preserve' } as const

const ArrayIndexSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PathSegmentSchema = Schema.Union([Schema.String, ArrayIndexSchema])

export const CopilotLogEnvelopeSchema = Schema.Struct({
  kind: Schema.Finite,
})

export const CopilotInitialLogRecordSchema = Schema.Struct({
  kind: Schema.Literal(0),
  v: Schema.Unknown,
})

export const CopilotSetLogRecordSchema = Schema.Struct({
  kind: Schema.Literal(1),
  k: Schema.Array(PathSegmentSchema),
  v: Schema.Unknown,
})

export const CopilotPushLogRecordSchema = Schema.Struct({
  kind: Schema.Literal(2),
  k: Schema.Array(PathSegmentSchema),
  v: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  i: Schema.optionalKey(ArrayIndexSchema),
})

export const CopilotDeleteLogRecordSchema = Schema.Struct({
  kind: Schema.Literal(3),
  k: Schema.Array(PathSegmentSchema),
})

export const CopilotLogRecordSchema = Schema.Union([
  CopilotInitialLogRecordSchema,
  CopilotSetLogRecordSchema,
  CopilotPushLogRecordSchema,
  CopilotDeleteLogRecordSchema,
]).pipe(Schema.toTaggedUnion('kind'))

export type CopilotLogRecord = typeof CopilotLogRecordSchema.Type

export type ParsedCopilotLogRecord =
  | { success: true, record: CopilotLogRecord }
  | { success: true, record: { kind: 'unknown', recordKind: number } }
  | { success: false, known: boolean }

const decodeLogEnvelope = Schema.decodeUnknownResult(CopilotLogEnvelopeSchema, PRESERVE)
const decodeLogRecord = Schema.decodeUnknownResult(CopilotLogRecordSchema, PRESERVE)

export function parseCopilotLogRecord(value: unknown): ParsedCopilotLogRecord {
  const envelope = decodeLogEnvelope(value)
  if (!Result.isSuccess(envelope)) return { success: false, known: false }
  if (![0, 1, 2, 3].includes(envelope.success.kind)) {
    return { success: true, record: { kind: 'unknown', recordKind: envelope.success.kind } }
  }
  const record = decodeLogRecord(value)
  return Result.isSuccess(record)
    ? { success: true, record: record.success }
    : { success: false, known: true }
}

export const CopilotUriSchema = Schema.Struct({
  scheme: Schema.optionalKey(Schema.String),
  authority: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
  fsPath: Schema.optionalKey(Schema.String),
  external: Schema.optionalKey(Schema.String),
})

export const CopilotMarkdownSchema = Schema.Struct({
  value: Schema.String,
})

export const CopilotAgentSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  fullName: Schema.optionalKey(Schema.String),
  extensionPublisherId: Schema.optionalKey(Schema.String),
  extensionDisplayName: Schema.optionalKey(Schema.String),
})

export const CopilotModelStateSchema = Schema.Struct({
  value: Schema.optionalKey(Schema.Finite),
  completedAt: Schema.optionalKey(Schema.Finite),
})

export const CopilotRequestResultSchema = Schema.Struct({
  details: Schema.optionalKey(Schema.String),
  errorDetails: Schema.optionalKey(Schema.Struct({
    message: Schema.optionalKey(Schema.String),
    code: Schema.optionalKey(Schema.String),
    responseIsIncomplete: Schema.optionalKey(Schema.Boolean),
    isRateLimited: Schema.optionalKey(Schema.Boolean),
    isQuotaExceeded: Schema.optionalKey(Schema.Boolean),
  })),
  metadata: Schema.optionalKey(Schema.Struct({
    agentId: Schema.optionalKey(Schema.String),
    resolvedModel: Schema.optionalKey(Schema.String),
    outputTokens: Schema.optionalKey(Schema.Finite),
    promptTokens: Schema.optionalKey(Schema.Finite),
  })),
})

export const CopilotRequestSchema = Schema.Struct({
  requestId: Schema.String,
  timestamp: Schema.Finite,
  message: Schema.Struct({ text: Schema.String }),
  agent: Schema.optionalKey(CopilotAgentSchema),
  modelId: Schema.optionalKey(Schema.String),
  modeInfo: Schema.optionalKey(Schema.Struct({
    kind: Schema.optionalKey(Schema.String),
    modeId: Schema.optionalKey(Schema.String),
    modeName: Schema.optionalKey(Schema.String),
    permissionLevel: Schema.optionalKey(Schema.String),
  })),
  modelState: Schema.optionalKey(CopilotModelStateSchema),
  response: Schema.Array(Schema.Unknown),
  result: Schema.optionalKey(CopilotRequestResultSchema),
  elapsedMs: Schema.optionalKey(Schema.Finite),
  timeSpentWaiting: Schema.optionalKey(Schema.Finite),
  editedFileEvents: Schema.optionalKey(Schema.Array(Schema.Struct({
    eventKind: Schema.optionalKey(Schema.Finite),
    uri: CopilotUriSchema,
  }))),
})

export const CopilotSessionSnapshotSchema = Schema.Struct({
  version: Schema.Literal(3),
  creationDate: Schema.Finite,
  sessionId: Schema.String,
  customTitle: Schema.optionalKey(Schema.String),
  responderUsername: Schema.optionalKey(Schema.String),
  initialLocation: Schema.optionalKey(Schema.String),
  workingDirectory: Schema.optionalKey(Schema.String),
  hasPendingEdits: Schema.optionalKey(Schema.Boolean),
  requests: Schema.Array(CopilotRequestSchema),
  pendingRequests: Schema.optionalKey(Schema.Array(Schema.Unknown)),
})

export const CopilotWorkspaceMetadataSchema = Schema.Struct({
  folder: Schema.optionalKey(Schema.String),
  workspace: Schema.optionalKey(Schema.String),
})

export const CopilotResponseEnvelopeSchema = Schema.Struct({
  kind: Schema.optionalKey(Schema.String),
})

export const CopilotThinkingPartSchema = Schema.Struct({
  kind: Schema.Literal('thinking'),
  id: Schema.optionalKey(Schema.String),
  value: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]),
})

export const CopilotToolOutcomeSchema = Schema.Struct({
  isError: Schema.optionalKey(Schema.Boolean),
  error: Schema.optionalKey(Schema.Boolean),
  success: Schema.optionalKey(Schema.Boolean),
  status: Schema.optionalKey(Schema.String),
  exitCode: Schema.optionalKey(Schema.Finite),
  exit_code: Schema.optionalKey(Schema.Finite),
})

export const CopilotTerminalStateSchema = Schema.Struct({
  exitCode: Schema.optionalKey(Schema.Finite),
  duration: Schema.optionalKey(Schema.Finite),
  timestamp: Schema.optionalKey(Schema.Finite),
})

export const CopilotToolSpecificDataSchema = Schema.Struct({
  kind: Schema.optionalKey(Schema.String),
  commandLine: Schema.optionalKey(Schema.String),
  terminalCommandState: Schema.optionalKey(CopilotTerminalStateSchema),
  todoList: Schema.optionalKey(Schema.Array(Schema.Struct({
    title: Schema.optionalKey(Schema.String),
    description: Schema.optionalKey(Schema.String),
    status: Schema.optionalKey(Schema.String),
  }))),
  agentName: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  modelName: Schema.optionalKey(Schema.String),
})

export const CopilotToolPartSchema = Schema.Struct({
  kind: Schema.Literal('toolInvocationSerialized'),
  toolCallId: Schema.String,
  toolId: Schema.String,
  isComplete: Schema.Boolean,
  invocationMessage: Schema.optionalKey(Schema.Union([Schema.String, CopilotMarkdownSchema])),
  pastTenseMessage: Schema.optionalKey(Schema.Union([Schema.String, CopilotMarkdownSchema])),
  resultDetails: Schema.optionalKey(Schema.Unknown),
  toolSpecificData: Schema.optionalKey(CopilotToolSpecificDataSchema),
})

const CopilotRangeSchema = Schema.Struct({
  startLineNumber: Schema.optionalKey(Schema.Finite),
  endLineNumber: Schema.optionalKey(Schema.Finite),
})

export const CopilotTextEditPartSchema = Schema.Struct({
  kind: Schema.Literal('textEditGroup'),
  uri: CopilotUriSchema,
  done: Schema.optionalKey(Schema.Boolean),
  edits: Schema.Array(Schema.Array(Schema.Struct({
    text: Schema.String,
    range: CopilotRangeSchema,
  }))),
})

export type CopilotSessionSnapshot = typeof CopilotSessionSnapshotSchema.Type
export type CopilotRequest = typeof CopilotRequestSchema.Type
export type CopilotThinkingPart = typeof CopilotThinkingPartSchema.Type
export type CopilotToolPart = typeof CopilotToolPartSchema.Type
export type CopilotTextEditPart = typeof CopilotTextEditPartSchema.Type

const decodeSnapshot = Schema.decodeUnknownResult(CopilotSessionSnapshotSchema, PRESERVE)
const decodeWorkspace = Schema.decodeUnknownResult(CopilotWorkspaceMetadataSchema, PRESERVE)
const decodeResponseEnvelope = Schema.decodeUnknownResult(CopilotResponseEnvelopeSchema, PRESERVE)
const decodeMarkdown = Schema.decodeUnknownResult(CopilotMarkdownSchema, PRESERVE)
const decodeThinking = Schema.decodeUnknownResult(CopilotThinkingPartSchema, PRESERVE)
const decodeTool = Schema.decodeUnknownResult(CopilotToolPartSchema, PRESERVE)
const decodeTextEdit = Schema.decodeUnknownResult(CopilotTextEditPartSchema, PRESERVE)
const decodeOutcome = Schema.decodeUnknownResult(CopilotToolOutcomeSchema, PRESERVE)

export function parseCopilotSnapshot(value: unknown): CopilotSessionSnapshot | null {
  const result = decodeSnapshot(value)
  return Result.isSuccess(result) ? result.success : null
}

export function parseCopilotWorkspace(value: unknown): typeof CopilotWorkspaceMetadataSchema.Type | null {
  const result = decodeWorkspace(value)
  return Result.isSuccess(result) ? result.success : null
}

export type ParsedCopilotResponsePart =
  | { kind: 'markdown', data: typeof CopilotMarkdownSchema.Type }
  | { kind: 'thinking', data: CopilotThinkingPart }
  | { kind: 'tool', data: CopilotToolPart }
  | { kind: 'text_edit', data: CopilotTextEditPart }
  | { kind: 'unknown', type: string }
  | { kind: 'malformed', type: string }

export function parseCopilotResponsePart(value: unknown): ParsedCopilotResponsePart {
  const envelope = decodeResponseEnvelope(value)
  if (!Result.isSuccess(envelope)) return { kind: 'malformed', type: '<invalid>' }
  const type = envelope.success.kind
  if (type === undefined || type === 'markdownContent') {
    const parsed = decodeMarkdown(value)
    return Result.isSuccess(parsed)
      ? { kind: 'markdown', data: parsed.success }
      : { kind: 'malformed', type: type || 'markdown' }
  }
  if (type === 'thinking') {
    const parsed = decodeThinking(value)
    return Result.isSuccess(parsed)
      ? { kind: 'thinking', data: parsed.success }
      : { kind: 'malformed', type }
  }
  if (type === 'toolInvocationSerialized') {
    const parsed = decodeTool(value)
    return Result.isSuccess(parsed)
      ? { kind: 'tool', data: parsed.success }
      : { kind: 'malformed', type }
  }
  if (type === 'textEditGroup') {
    const parsed = decodeTextEdit(value)
    return Result.isSuccess(parsed)
      ? { kind: 'text_edit', data: parsed.success }
      : { kind: 'malformed', type }
  }
  return { kind: 'unknown', type }
}

export function parseCopilotToolOutcome(value: unknown): typeof CopilotToolOutcomeSchema.Type | null {
  const result = decodeOutcome(value)
  return Result.isSuccess(result) ? result.success : null
}
