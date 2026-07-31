import { Result, Schema, SchemaTransformation } from 'effect'

export const ChatAgentIdSchema = Schema.Literals(['claude', 'codex', 'copilot'])

/**
 * Trims on decode so the trimmed value is what gets checked (and what every
 * consumer sees) — canonical at the schema boundary instead of the caller
 * trimming again after parsing.
 */
const ChatTextSchema = Schema.String.pipe(
  Schema.decode(SchemaTransformation.trim()),
).check(
  Schema.isPattern(/\S/),
  Schema.isMaxLength(20_000),
)

export const ChatActionSchema = Schema.Union([
  Schema.Struct({
    action: Schema.Literal('send'),
    project: Schema.String,
    key: Schema.String,
    agent: ChatAgentIdSchema,
    text: ChatTextSchema,
  }),
  Schema.Struct({
    action: Schema.Literal('cancel'),
    project: Schema.String,
    key: Schema.String,
  }),
  Schema.Struct({
    action: Schema.Literal('reset'),
    project: Schema.String,
    key: Schema.String,
  }),
])

const decodeChatAction = Schema.decodeUnknownResult(ChatActionSchema)

export type ParsedChatAction = typeof ChatActionSchema.Type

export function parseChatAction(value: unknown): Result.Result<ParsedChatAction, Schema.SchemaError> {
  return decodeChatAction(value)
}
