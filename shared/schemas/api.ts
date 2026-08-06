import { Schema } from 'effect'
import { ChatAgentIdSchema } from '#shared/schemas/chat'
import type { ChatActionResponse, ChatEventsResponse } from '#shared/types/chat'
import type { CostOverviewResponse } from '#shared/types/run'

/**
 * Decoders for what `server/api/**` returns.
 *
 * `shared/types/run.ts` keeps the hand-written, *mutable* interfaces and stays
 * the server's construction type: `server/utils/runs.ts` and its siblings build
 * the run tree by calling `.push` and `.sort` on `RunNode.children` and on the
 * project `roots` arrays, and `Schema.Struct` keys are readonly while
 * `Schema.Array` produces `ReadonlyArray`. Re-exporting the derived types would
 * be a wall of errors across five server files.
 *
 * So the boundary is one-directional: the schemas here own decoding and export
 * their readonly `.Type` under a `*Wire` name, `app/**` migrates its
 * `import type` lines to those, and a drift guard per response asserts that the
 * mutable interface is still assignable to the wire type. Mutable is assignable
 * to readonly; the reverse is not, which is the point.
 */

export const SessionSourceSchema = Schema.Literals(['claude', 'codex', 'copilot'])

export type SessionSourceWire = typeof SessionSourceSchema.Type

export const SessionSourceStatusSchema = Schema.Struct({
  source: SessionSourceSchema,
  state: Schema.Literals(['ready', 'degraded', 'unavailable']),
  sessions: Schema.Number,
  malformed: Schema.Number,
  message: Schema.String,
})

export const UsageSchema = Schema.Struct({
  in: Schema.Number,
  out: Schema.Number,
  cr: Schema.Number,
  cw: Schema.Number,
})

export type UsageWire = typeof UsageSchema.Type

const CostOverviewDaySchema = Schema.Struct({
  date: Schema.String,
  estimatedUsd: Schema.Number,
  usage: UsageSchema,
})

export const CostOverviewGroupSchema = Schema.Struct({
  source: SessionSourceSchema,
  label: Schema.String,
  model: Schema.NullOr(Schema.String),
  sessions: Schema.Number,
  usage: UsageSchema,
  estimatedUsd: Schema.NullOr(Schema.Number),
  pricedRequests: Schema.Number,
  unpricedRequests: Schema.Number,
  days: Schema.Array(CostOverviewDaySchema),
})

export type CostOverviewGroupWire = typeof CostOverviewGroupSchema.Type

/**
 * `GET /api/costs`.
 *
 * `currency` and `estimated` are literal types on the server, not `string` and
 * `boolean`, and `now` is fractional epoch *seconds* (`nowMillis / 1_000`), not
 * milliseconds — so it stays a `Number` and is never decoded into a `Date`.
 */
export const CostOverviewResponseSchema = Schema.Struct({
  now: Schema.Number,
  hours: Schema.Number,
  currency: Schema.Literal('USD'),
  estimated: Schema.Literal(true),
  estimatedUsd: Schema.Number,
  pricedRequests: Schema.Number,
  unpricedRequests: Schema.Number,
  sessions: Schema.Number,
  usage: UsageSchema,
  harnesses: Schema.Array(CostOverviewGroupSchema),
  models: Schema.Array(CostOverviewGroupSchema),
  sources: Schema.Array(SessionSourceStatusSchema),
})

export type CostOverviewResponseWire = typeof CostOverviewResponseSchema.Type

/**
 * Drift guard. The server constructs the mutable interface; the wire type must
 * accept it. Deliberately one-directional — a decoded value is readonly and is
 * NOT assignable back to the mutable interface, which is the whole point.
 */
const _costsWireAcceptsServerShape: CostOverviewResponseWire =
  undefined as unknown as CostOverviewResponse
void _costsWireAcceptsServerShape

export const ChatStatusSchema = Schema.Literals(['idle', 'starting', 'busy', 'error'])

export type ChatStatusWire = typeof ChatStatusSchema.Type

/**
 * One entry in a chat's append-only log.
 *
 * A plain `Schema.Union` rather than a tagged one: the discriminant is `kind`,
 * not `_tag`, and the arms are small enough that `anyOf` costs nothing — a poll
 * decodes only the events after the cursor, which is a handful per turn.
 */
export const ChatEventSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('user'), text: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal('assistant-chunk'),
    agent: ChatAgentIdSchema,
    text: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal('thought-chunk'),
    agent: ChatAgentIdSchema,
    text: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal('tool'),
    toolCallId: Schema.String,
    title: Schema.String,
    toolKind: Schema.String,
    status: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal('turn-end'), stopReason: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('error'), message: Schema.String }),
])

export type ChatEventWire = typeof ChatEventSchema.Type

/**
 * `GET /api/chat`.
 *
 * `reset` is the server telling the client to replace its log rather than
 * extend it — a new `revision`, a cursor before the retained window, or a
 * cursor past the end. `agent` is null until the first message is sent, and
 * again after a reset, because the reset removes the record entirely
 * (`server/utils/chat.ts:526-532`).
 */
export const ChatEventsResponseSchema = Schema.Struct({
  events: Schema.Array(ChatEventSchema),
  next: Schema.Number,
  revision: Schema.Number,
  reset: Schema.Boolean,
  status: ChatStatusSchema,
  agent: Schema.NullOr(ChatAgentIdSchema),
})

export type ChatEventsResponseWire = typeof ChatEventsResponseSchema.Type

/** `POST /api/chat`. */
export const ChatActionResponseSchema = Schema.Struct({ status: ChatStatusSchema })

export type ChatActionResponseWire = typeof ChatActionResponseSchema.Type

const _chatEventsWireAcceptsServerShape: ChatEventsResponseWire =
  undefined as unknown as ChatEventsResponse
void _chatEventsWireAcceptsServerShape

const _chatActionWireAcceptsServerShape: ChatActionResponseWire =
  undefined as unknown as ChatActionResponse
void _chatActionWireAcceptsServerShape
