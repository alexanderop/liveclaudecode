import { Schema } from 'effect'
import { ChatAgentIdSchema } from '#shared/schemas/chat'
import type { ChatActionResponse, ChatEventsResponse } from '#shared/types/chat'
import type { CostOverviewResponse, TreeResponse } from '#shared/types/run'

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

/** `Timestamp` — an ISO string, or null when the transcript recorded none. */
const TimestampSchema = Schema.NullOr(Schema.String)

const TodoSchema = Schema.Struct({
  content: Schema.optionalKey(Schema.String),
  activeForm: Schema.optionalKey(Schema.String),
  // The three known states are documented on the interface as a union with
  // `string`, which collapses to `string`. Harnesses invent their own.
  status: Schema.String,
})

const SkillUseSchema = Schema.Struct({ skill: Schema.String, ts: TimestampSchema })

const MilestoneSchema = Schema.Struct({
  title: Schema.String,
  ts: TimestampSchema,
  strong: Schema.Boolean,
  who: Schema.optionalKey(Schema.String),
})

const CurrentActivitySchema = Schema.Struct({
  tool: Schema.String,
  summary: Schema.String,
  ts: TimestampSchema,
})

const FileChangeSchema = Schema.Struct({
  path: Schema.String,
  ops: Schema.Number,
  tools: Schema.Array(Schema.String),
  lastTs: TimestampSchema,
})

const CommandRunSchema = Schema.Struct({
  cmd: Schema.String,
  ts: TimestampSchema,
  ok: Schema.NullOr(Schema.Boolean),
  tid: Schema.String,
  note: Schema.optionalKey(Schema.String),
})

/**
 * The fields `RunNode` inherits from `TranscriptStats`.
 *
 * A record rather than a schema so the recursive and non-recursive node schemas
 * can each spread it. `Schema.Struct` does support omission through
 * `.mapFields(Struct.omit([…]))`, but the recursive node has to be annotated
 * `Schema.Codec<…>` for `Schema.suspend` to typecheck, and `Codec` has no
 * `mapFields`. This is the one place that trade-off applies; prefer `mapFields`
 * everywhere else.
 */
const TranscriptStatsFields = {
  records: Schema.Number,
  tools: Schema.Number,
  toolCounts: Schema.Record(Schema.String, Schema.Number),
  reads: Schema.Number,
  errors: Schema.Number,
  tokensOut: Schema.Number,
  firstTs: TimestampSchema,
  lastTs: TimestampSchema,
  mtime: Schema.Number,
  /** Milliseconds since `mtime`, recomputed per request — see the note on equality. */
  ago: Schema.Number,
  live: Schema.Boolean,
  size: Schema.Number,
  todos: Schema.NullOr(Schema.Array(TodoSchema)),
  skills: Schema.Array(SkillUseSchema),
  milestones: Schema.Array(MilestoneSchema),
  current: Schema.NullOr(CurrentActivitySchema),
  files: Schema.Array(FileChangeSchema),
  commands: Schema.Array(CommandRunSchema),
  finalText: Schema.String,
} as const

/** Everything a `RunNode` adds, except `children` and `subFiles`. */
const RunNodeOwnFields = {
  source: SessionSourceSchema,
  sourceDetail: Schema.String,
  key: Schema.String,
  kind: Schema.Literals(['session', 'subagent']),
  sid: Schema.String,
  label: Schema.String,
  title: Schema.String,
  openingPrompt: Schema.String,
  lastPrompt: Schema.String,
  agentType: Schema.String,
  toolUseId: Schema.NullOr(Schema.String),
  model: Schema.String,
  spawnDepth: Schema.NullOr(Schema.Number),
  parentAgentId: Schema.NullOr(Schema.String),
  stoppedByUser: Schema.Boolean,
  spawnState: Schema.Literals(['', 'running', 'returned']),
  subAgents: Schema.Number,
  subRunning: Schema.Number,
  subErrors: Schema.Number,
  subTools: Schema.Number,
  subLast: TimestampSchema,
  subLive: Schema.Boolean,
} as const

/**
 * One agent in the run tree, with its subagents beneath it.
 *
 * The interface is written out rather than inferred because `Schema.suspend`
 * needs a type to refer to while the schema is still being defined.
 */
export interface RunNodeWire extends
  Schema.Struct.Type<typeof TranscriptStatsFields>,
  Schema.Struct.Type<typeof RunNodeOwnFields>
{
  readonly children: ReadonlyArray<RunNodeWire>
  readonly subFiles: { readonly [path: string]: number }
}

export const RunNodeSchema: Schema.Codec<RunNodeWire> = Schema.Struct({
  ...TranscriptStatsFields,
  ...RunNodeOwnFields,
  children: Schema.Array(Schema.suspend((): Schema.Codec<RunNodeWire> => RunNodeSchema)),
  subFiles: Schema.Record(Schema.String, Schema.Number),
})

export const ProjectRunsSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  roots: Schema.Array(RunNodeSchema),
})

export type ProjectRunsWire = typeof ProjectRunsSchema.Type

/** The Claude spend summary the sidebar shows under the session list. */
export const CostSummarySchema = Schema.Struct({
  usd: Schema.Number,
  pricedRequests: Schema.Number,
  unpricedRequests: Schema.Number,
  estimated: Schema.Literal(true),
  currency: Schema.Literal('USD'),
  todayUsd: Schema.Number,
  /** Null when the selected range does not cover seven days. */
  last7DaysUsd: Schema.NullOr(Schema.Number),
  coverageHours: Schema.Number,
})

export type CostSummaryWire = typeof CostSummarySchema.Type

/**
 * `GET /api/tree`.
 *
 * `costs` is required, not optional. `listSessions` calls `summarizeCosts`
 * unconditionally and that function always returns a summary
 * (`server/utils/cost.ts:327`), so the `costs?` on `TreeResponse` described a
 * case the server cannot produce — it has been made required there too, which
 * is what lets the drift guard below hold. An `optional` here would have
 * propagated `| undefined` through every consumer for nothing.
 *
 * `hours` is the server's *effective* range: `parseHours` clamps what it was
 * asked for, so a client that sends nothing learns the configured default from
 * this field. That is the whole range handshake.
 */
export const TreeResponseSchema = Schema.Struct({
  projects: Schema.Array(ProjectRunsSchema),
  sources: Schema.Array(SessionSourceStatusSchema),
  /** Fractional epoch *seconds*, like `/api/costs` — not milliseconds. */
  now: Schema.Number,
  hours: Schema.Number,
  costs: CostSummarySchema,
})

export type TreeResponseWire = typeof TreeResponseSchema.Type

export type SessionSourceStatusWire = typeof SessionSourceStatusSchema.Type

const _treeWireAcceptsServerShape: TreeResponseWire = undefined as unknown as TreeResponse
void _treeWireAcceptsServerShape

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
