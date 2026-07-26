import { z } from 'zod'

const looseObject = <Shape extends z.ZodRawShape>(shape: Shape) => z.object(shape).passthrough()

export const ClaudeUsageSchema = looseObject({
  input_tokens: z.number().finite().optional(),
  output_tokens: z.number().finite().optional(),
  cache_read_input_tokens: z.number().finite().optional(),
  cache_creation_input_tokens: z.number().finite().optional(),
})

export const ClaudeTextBlockSchema = looseObject({
  type: z.literal('text'),
  text: z.string(),
})

export const ClaudeThinkingBlockSchema = looseObject({
  type: z.literal('thinking'),
  thinking: z.string(),
  signature: z.string().optional(),
})

export const ClaudeToolUseBlockSchema = looseObject({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
  caller: looseObject({ type: z.string() }).optional(),
})

export const ClaudeToolResultBlockSchema = looseObject({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.unknown(),
  is_error: z.boolean().optional(),
})

export const ClaudeImageBlockSchema = looseObject({
  type: z.literal('image'),
  source: z.unknown().optional(),
})

export const ClaudeContentBlockEnvelopeSchema = looseObject({
  type: z.string().min(1),
})

export type ClaudeTextBlock = z.infer<typeof ClaudeTextBlockSchema>
export type ClaudeThinkingBlock = z.infer<typeof ClaudeThinkingBlockSchema>
export type ClaudeToolUseBlock = z.infer<typeof ClaudeToolUseBlockSchema>
export type ClaudeToolResultBlock = z.infer<typeof ClaudeToolResultBlockSchema>
export type ClaudeImageBlock = z.infer<typeof ClaudeImageBlockSchema>
export type ClaudeContentBlockEnvelope = z.infer<typeof ClaudeContentBlockEnvelopeSchema>

export type ParsedClaudeAssistantBlock =
  | { kind: 'text', data: ClaudeTextBlock }
  | { kind: 'thinking', data: ClaudeThinkingBlock }
  | { kind: 'tool_use', data: ClaudeToolUseBlock }
  | { kind: 'unknown', data: ClaudeContentBlockEnvelope }

export type ParsedClaudeUserBlock =
  | { kind: 'text', data: ClaudeTextBlock }
  | { kind: 'tool_result', data: ClaudeToolResultBlock }
  | { kind: 'image', data: ClaudeImageBlock }
  | { kind: 'unknown', data: ClaudeContentBlockEnvelope }

export function parseClaudeAssistantBlock(value: unknown): ParsedClaudeAssistantBlock | null {
  const envelope = ClaudeContentBlockEnvelopeSchema.safeParse(value)
  if (!envelope.success) return null

  if (envelope.data.type === 'text') {
    const parsed = ClaudeTextBlockSchema.safeParse(value)
    return parsed.success ? { kind: 'text', data: parsed.data } : null
  }
  if (envelope.data.type === 'thinking') {
    const parsed = ClaudeThinkingBlockSchema.safeParse(value)
    return parsed.success ? { kind: 'thinking', data: parsed.data } : null
  }
  if (envelope.data.type === 'tool_use') {
    const parsed = ClaudeToolUseBlockSchema.safeParse(value)
    return parsed.success ? { kind: 'tool_use', data: parsed.data } : null
  }
  return { kind: 'unknown', data: envelope.data }
}

export function parseClaudeUserBlock(value: unknown): ParsedClaudeUserBlock | null {
  const envelope = ClaudeContentBlockEnvelopeSchema.safeParse(value)
  if (!envelope.success) return null

  if (envelope.data.type === 'text') {
    const parsed = ClaudeTextBlockSchema.safeParse(value)
    return parsed.success ? { kind: 'text', data: parsed.data } : null
  }
  if (envelope.data.type === 'tool_result') {
    const parsed = ClaudeToolResultBlockSchema.safeParse(value)
    return parsed.success ? { kind: 'tool_result', data: parsed.data } : null
  }
  if (envelope.data.type === 'image') {
    const parsed = ClaudeImageBlockSchema.safeParse(value)
    return parsed.success ? { kind: 'image', data: parsed.data } : null
  }
  return { kind: 'unknown', data: envelope.data }
}

const ClaudeBaseRecordSchema = looseObject({
  type: z.string().min(1),
  timestamp: z.string().optional(),
  cwd: z.string().optional(),
  sessionId: z.string().optional(),
  session_id: z.string().optional(),
  uuid: z.string().optional(),
  parentUuid: z.string().nullable().optional(),
  logicalParentUuid: z.string().optional(),
  agentId: z.string().optional(),
  isSidechain: z.boolean().optional(),
  entrypoint: z.string().optional(),
  version: z.string().optional(),
  gitBranch: z.string().optional(),
  userType: z.string().optional(),
})

export const ClaudeAssistantMessageSchema = looseObject({
  id: z.string().optional(),
  role: z.literal('assistant').optional(),
  model: z.string().optional(),
  content: z.union([z.string(), z.array(z.unknown())]),
  usage: ClaudeUsageSchema.optional(),
  stop_reason: z.string().nullable().optional(),
})

export const ClaudeUserMessageSchema = looseObject({
  role: z.literal('user').optional(),
  content: z.union([z.string(), z.array(z.unknown())]),
})

export const ClaudeAssistantRecordSchema = ClaudeBaseRecordSchema.extend({
  type: z.literal('assistant'),
  message: ClaudeAssistantMessageSchema,
  requestId: z.string().optional(),
  attributionSkill: z.string().optional(),
  attributionAgent: z.string().optional(),
  attributionPlugin: z.string().optional(),
  attributionMcpServer: z.string().optional(),
  attributionMcpTool: z.string().optional(),
  effort: z.string().optional(),
  isApiErrorMessage: z.boolean().optional(),
  error: z.string().optional(),
  apiErrorStatus: z.number().finite().optional(),
})

export const ClaudeUserRecordSchema = ClaudeBaseRecordSchema.extend({
  type: z.literal('user'),
  message: ClaudeUserMessageSchema,
  isMeta: z.boolean().optional(),
  promptId: z.string().optional(),
  sourceToolUseID: z.string().optional(),
  sourceToolAssistantUUID: z.string().optional(),
  toolUseResult: z.unknown().optional(),
  promptSource: z.string().optional(),
  toolDenialKind: z.string().optional(),
  interruptedMessageId: z.string().optional(),
  isCompactSummary: z.boolean().optional(),
  permissionMode: z.string().optional(),
})

export const ClaudeSystemRecordSchema = ClaudeBaseRecordSchema.extend({
  type: z.literal('system'),
  subtype: z.string().optional(),
  content: z.string().optional(),
  level: z.string().optional(),
  isMeta: z.boolean().optional(),
  durationMs: z.number().finite().optional(),
  messageCount: z.number().finite().optional(),
  pendingBackgroundAgentCount: z.number().finite().optional(),
  pendingWorkflowCount: z.number().finite().optional(),
  compactMetadata: z.unknown().optional(),
})

export const ClaudeAttachmentRecordSchema = ClaudeBaseRecordSchema.extend({
  type: z.literal('attachment'),
  attachment: looseObject({ type: z.string().min(1) }),
})

const ClaudeSessionStateSchemas = [
  looseObject({ type: z.literal('last-prompt'), sessionId: z.string(), lastPrompt: z.string().optional(), leafUuid: z.string().optional() }),
  looseObject({ type: z.literal('mode'), sessionId: z.string(), mode: z.string() }),
  looseObject({ type: z.literal('permission-mode'), sessionId: z.string(), permissionMode: z.string() }),
  looseObject({ type: z.literal('ai-title'), sessionId: z.string(), aiTitle: z.string() }),
  looseObject({ type: z.literal('custom-title'), sessionId: z.string(), customTitle: z.string() }),
  looseObject({ type: z.literal('agent-name'), sessionId: z.string(), agentName: z.string() }),
  looseObject({ type: z.literal('bridge-session'), sessionId: z.string(), bridgeSessionId: z.string(), lastSequenceNum: z.number().finite() }),
  looseObject({ type: z.literal('queue-operation'), sessionId: z.string(), operation: z.string(), content: z.unknown().optional(), timestamp: z.string().optional() }),
  looseObject({ type: z.literal('file-history-snapshot'), messageId: z.string(), snapshot: z.unknown() }),
  looseObject({ type: z.literal('file-history-delta'), messageId: z.string(), snapshotMessageId: z.string(), backup: z.unknown() }),
  looseObject({ type: z.literal('pr-link'), sessionId: z.string(), prNumber: z.number().finite(), prRepository: z.string(), prUrl: z.string(), timestamp: z.string().optional() }),
  looseObject({ type: z.literal('frame-link'), sessionId: z.string(), path: z.string(), frameUrl: z.string(), title: z.string().optional(), timestamp: z.string().optional() }),
] as const

export const ClaudeSessionStateRecordSchema = z.union(ClaudeSessionStateSchemas)

export const ClaudeWorkflowStartedRecordSchema = looseObject({
  type: z.literal('started'),
  agentId: z.string(),
  key: z.string(),
})

export const ClaudeWorkflowResultRecordSchema = looseObject({
  type: z.literal('result'),
  agentId: z.string(),
  key: z.string(),
  result: z.unknown(),
})

export const ClaudeRecordEnvelopeSchema = looseObject({
  type: z.string().min(1),
})

export type ClaudeAssistantRecord = z.infer<typeof ClaudeAssistantRecordSchema>
export type ClaudeUserRecord = z.infer<typeof ClaudeUserRecordSchema>
export type ClaudeSystemRecord = z.infer<typeof ClaudeSystemRecordSchema>
export type ClaudeAttachmentRecord = z.infer<typeof ClaudeAttachmentRecordSchema>
export type ClaudeSessionStateRecord = z.infer<typeof ClaudeSessionStateRecordSchema>
export type ClaudeWorkflowStartedRecord = z.infer<typeof ClaudeWorkflowStartedRecordSchema>
export type ClaudeWorkflowResultRecord = z.infer<typeof ClaudeWorkflowResultRecordSchema>
export type ClaudeRecordEnvelope = z.infer<typeof ClaudeRecordEnvelopeSchema>

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
  | { success: false, error: z.ZodError }

export function parseClaudeRecord(value: unknown): ClaudeRecordParseResult {
  const envelope = ClaudeRecordEnvelopeSchema.safeParse(value)
  if (!envelope.success) return { success: false, error: envelope.error }

  const known = <Kind extends ParsedClaudeRecord['kind'], Schema extends z.ZodType>(
    kind: Kind,
    schema: Schema,
  ): ClaudeRecordParseResult => {
    const parsed = schema.safeParse(value)
    if (!parsed.success) return { success: false, error: parsed.error }
    return { success: true, record: { kind, data: parsed.data } as ParsedClaudeRecord }
  }

  switch (envelope.data.type) {
    case 'assistant': return known('assistant', ClaudeAssistantRecordSchema)
    case 'user': return known('user', ClaudeUserRecordSchema)
    case 'system': return known('system', ClaudeSystemRecordSchema)
    case 'attachment': return known('attachment', ClaudeAttachmentRecordSchema)
    case 'started': return known('workflow_started', ClaudeWorkflowStartedRecordSchema)
    case 'result': return known('workflow_result', ClaudeWorkflowResultRecordSchema)
    case 'last-prompt':
    case 'mode':
    case 'permission-mode':
    case 'ai-title':
    case 'custom-title':
    case 'agent-name':
    case 'bridge-session':
    case 'queue-operation':
    case 'file-history-snapshot':
    case 'file-history-delta':
    case 'pr-link':
    case 'frame-link':
      return known('session_state', ClaudeSessionStateRecordSchema)
    default:
      return { success: true, record: { kind: 'unknown', data: envelope.data } }
  }
}

export const ClaudeSubagentMetaSchema = looseObject({
  agentType: z.string(),
  description: z.string().optional(),
  spawnDepth: z.number().int().nonnegative().optional(),
  toolUseId: z.string().optional(),
  parentAgentId: z.string().optional(),
  model: z.string().optional(),
  name: z.string().optional(),
  stoppedByUser: z.boolean().optional(),
})

export type ClaudeSubagentMeta = z.infer<typeof ClaudeSubagentMetaSchema>

export function parseClaudeSubagentMeta(value: unknown): ClaudeSubagentMeta | null {
  const parsed = ClaudeSubagentMetaSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
