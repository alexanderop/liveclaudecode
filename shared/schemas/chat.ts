import { Result, Schema } from 'effect'

const ChatAgentIdSchema = Schema.Literals(['claude', 'codex'])
const ChatTextSchema = Schema.String.check(
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
