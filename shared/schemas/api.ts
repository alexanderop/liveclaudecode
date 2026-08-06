import { Schema } from 'effect'
import { ChatAgentIdSchema } from '#shared/schemas/chat'
import type { ChatActionResponse, ChatEventsResponse } from '#shared/types/chat'
import type {
  CostOverviewResponse,
  EventsResponse,
  ParseHealthResponse,
  PublicRunNode,
  RunResponse,
  SessionEventsResponse,
  TreeResponse,
} from '#shared/types/run'

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

/**
 * `PublicRunNode` — a node as the detail routes return it, without the subtree.
 *
 * `RunResponse` and `EventsResponse` carry the selected agent and its session
 * root this way, which is why the field records exist: the same fields, spread
 * once with `children`/`subFiles` and once without.
 */
export const PublicRunNodeSchema = Schema.Struct({
  ...TranscriptStatsFields,
  ...RunNodeOwnFields,
})

export type PublicRunNodeWire = typeof PublicRunNodeSchema.Type

export const TimelineLaneSchema = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  agentType: Schema.String,
  kind: Schema.Literals(['session', 'subagent']),
  depth: Schema.Number,
  firstTs: TimestampSchema,
  lastTs: TimestampSchema,
  live: Schema.Boolean,
  errors: Schema.Number,
  tools: Schema.Number,
  spawnState: Schema.Literals(['', 'running', 'returned']),
  files: Schema.Number,
})

export type TimelineLaneWire = typeof TimelineLaneSchema.Type

/**
 * One transcript record as the feed renders it.
 *
 * Almost every field is optional because one shape covers seven event kinds
 * across four harnesses; the server omits what a record did not carry rather
 * than filling in blanks. `optionalKey` rather than `optional`: the payload
 * arrives as JSON, which cannot express an explicit `undefined`.
 */
export const TranscriptEventSchema = Schema.Struct({
  role: Schema.Literals(['assistant', 'user', 'tool', 'system']),
  kind: Schema.Literals([
    'text',
    'thinking',
    'tool_use',
    'tool_result',
    'prompt',
    'meta',
    'system',
  ]),
  ts: TimestampSchema,
  line: Schema.Number,
  body: Schema.optionalKey(Schema.String),
  full: Schema.optionalKey(Schema.Number),
  tool: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Schema.String),
  input: Schema.optionalKey(Schema.String),
  spawn: Schema.optionalKey(Schema.Boolean),
  write: Schema.optionalKey(Schema.Boolean),
  error: Schema.optionalKey(Schema.Boolean),
  model: Schema.optionalKey(Schema.String),
  usage: Schema.optionalKey(UsageSchema),
  childKey: Schema.optionalKey(Schema.String),
  uuid: Schema.optionalKey(Schema.String),
  parentUuid: Schema.optionalKey(Schema.NullOr(Schema.String)),
  requestId: Schema.optionalKey(Schema.String),
  promptId: Schema.optionalKey(Schema.String),
  sourceUuid: Schema.optionalKey(Schema.String),
  sidechain: Schema.optionalKey(Schema.Boolean),
  stopReason: Schema.optionalKey(Schema.NullOr(Schema.String)),
  effort: Schema.optionalKey(Schema.String),
  /** Only on the merged, session-wide activity stream. */
  agentKey: Schema.optionalKey(Schema.String),
  agentLabel: Schema.optionalKey(Schema.String),
  agentType: Schema.optionalKey(Schema.String),
  agentDepth: Schema.optionalKey(Schema.Number),
})

export type TranscriptEventWire = typeof TranscriptEventSchema.Type

const DiagnosticIncidentSchema = Schema.Struct({
  id: Schema.String,
  severity: Schema.Literals(['error', 'warning', 'info']),
  category: Schema.Literals([
    'api',
    'tool',
    'permission',
    'hook',
    'timeout',
    'interruption',
    'agent',
    'truncation',
    'workflow',
    'lsp',
  ]),
  title: Schema.String,
  detail: Schema.String,
  ts: TimestampSchema,
  line: Schema.Number,
  tool: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.String),
  toolUseId: Schema.optionalKey(Schema.String),
  who: Schema.optionalKey(Schema.String),
  key: Schema.optionalKey(Schema.String),
})

export type DiagnosticIncidentWire = typeof DiagnosticIncidentSchema.Type

export const TurnTimingSchema = Schema.Struct({
  ts: TimestampSchema,
  durationMs: Schema.Number,
  messageCount: Schema.Number,
  pendingAgents: Schema.Number,
  pendingWorkflows: Schema.Number,
  who: Schema.optionalKey(Schema.String),
  key: Schema.optionalKey(Schema.String),
})

export type TurnTimingWire = typeof TurnTimingSchema.Type

const ContextUsageSampleSchema = Schema.Struct({
  ts: TimestampSchema,
  model: Schema.String,
  effort: Schema.String,
  usage: UsageSchema,
  stopReason: Schema.NullOr(Schema.String),
  messageId: Schema.optionalKey(Schema.String),
  requestId: Schema.optionalKey(Schema.String),
  cacheWrite5m: Schema.optionalKey(Schema.Number),
  cacheWrite1h: Schema.optionalKey(Schema.Number),
  webSearchRequests: Schema.optionalKey(Schema.Number),
  serviceTier: Schema.optionalKey(Schema.String),
  inferenceGeo: Schema.optionalKey(Schema.String),
  speed: Schema.optionalKey(Schema.String),
  who: Schema.optionalKey(Schema.String),
  key: Schema.optionalKey(Schema.String),
})

export type ContextUsageSampleWire = typeof ContextUsageSampleSchema.Type

export const CompactionEventSchema = Schema.Struct({
  ts: TimestampSchema,
  durationMs: Schema.Number,
  preTokens: Schema.Number,
  postTokens: Schema.Number,
  droppedTokens: Schema.Number,
  preservedMessages: Schema.Number,
  trigger: Schema.String,
  who: Schema.optionalKey(Schema.String),
  key: Schema.optionalKey(Schema.String),
})

export type CompactionEventWire = typeof CompactionEventSchema.Type

const ToolStatsSchema = Schema.Struct({
  reads: Schema.Number,
  searches: Schema.Number,
  commands: Schema.Number,
  edits: Schema.Number,
  linesAdded: Schema.Number,
  linesRemoved: Schema.Number,
  other: Schema.Number,
})

const AgentOutcomeSchema = Schema.Struct({
  toolUseId: Schema.String,
  ts: TimestampSchema,
  status: Schema.String,
  model: Schema.String,
  durationMs: Schema.Number,
  totalTokens: Schema.Number,
  totalToolUseCount: Schema.Number,
  stats: ToolStatsSchema,
  childKey: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.String),
})

const ChangeDetailSchema = Schema.Struct({
  toolUseId: Schema.String,
  ts: TimestampSchema,
  tool: Schema.String,
  path: Schema.String,
  linesAdded: Schema.Number,
  linesRemoved: Schema.Number,
  userModified: Schema.Boolean,
  staleRecovered: Schema.Boolean,
  who: Schema.optionalKey(Schema.String),
  key: Schema.optionalKey(Schema.String),
})

export type ChangeDetailWire = typeof ChangeDetailSchema.Type

const GitEventSchema = Schema.Struct({
  toolUseId: Schema.String,
  ts: TimestampSchema,
  kind: Schema.Literals(['commit', 'push', 'pr', 'branch']),
  label: Schema.String,
  url: Schema.optionalKey(Schema.String),
  who: Schema.optionalKey(Schema.String),
  key: Schema.optionalKey(Schema.String),
})

const AgentDiagnosticSummarySchema = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  agentType: Schema.String,
  models: Schema.Array(Schema.String),
  efforts: Schema.Array(Schema.String),
  usage: UsageSchema,
  turns: Schema.Number,
  turnDurationMs: Schema.Number,
  compactions: Schema.Number,
  branchPoints: Schema.Number,
  sidechainRecords: Schema.Number,
})

const SessionEnvironmentSchema = Schema.Struct({
  cwd: Schema.String,
  gitBranch: Schema.String,
  version: Schema.String,
  entrypoint: Schema.String,
  permissionMode: Schema.String,
  mode: Schema.String,
})

const CausalSummarySchema = Schema.Struct({
  records: Schema.Number,
  recordsWithUuid: Schema.Number,
  branchPoints: Schema.Number,
  sidechainRecords: Schema.Number,
  interruptions: Schema.Number,
})

const HookSummarySchema = Schema.Struct({
  name: Schema.String,
  event: Schema.String,
  runs: Schema.Number,
  failures: Schema.Number,
  totalMs: Schema.Number,
  maxMs: Schema.Number,
  lastTs: TimestampSchema,
})

const BudgetReportSchema = Schema.Struct({
  usedUsd: Schema.Number,
  totalUsd: Schema.Number,
  remainingUsd: Schema.Number,
  ts: TimestampSchema,
})

const CostEstimateSchema = Schema.Struct({
  usd: Schema.Number,
  pricedRequests: Schema.Number,
  unpricedRequests: Schema.Number,
  estimated: Schema.Literal(true),
})

const SessionParseSummarySchema = Schema.Struct({
  skipped: Schema.Number,
  counts: Schema.Struct({
    invalidJson: Schema.Number,
    schemaMismatch: Schema.Number,
    unsupportedShape: Schema.Number,
  }),
})

/**
 * Everything the inspector, the diagnostics view, and the context-pressure
 * chart read. `hooks`, `budget`, and `cost` are absent for harnesses that do
 * not report them, which is why they are optional here and nowhere else.
 */
const RunDiagnosticsSchema = Schema.Struct({
  incidents: Schema.Array(DiagnosticIncidentSchema),
  turns: Schema.Array(TurnTimingSchema),
  context: Schema.Array(ContextUsageSampleSchema),
  compactions: Schema.Array(CompactionEventSchema),
  outcomes: Schema.Array(AgentOutcomeSchema),
  changes: Schema.Array(ChangeDetailSchema),
  git: Schema.Array(GitEventSchema),
  agents: Schema.Array(AgentDiagnosticSummarySchema),
  environment: SessionEnvironmentSchema,
  causal: CausalSummarySchema,
  usage: UsageSchema,
  cost: Schema.optionalKey(CostEstimateSchema),
  hooks: Schema.optionalKey(Schema.Array(HookSummarySchema)),
  budget: Schema.optionalKey(BudgetReportSchema),
  parse: SessionParseSummarySchema,
})

export type RunDiagnosticsWire = typeof RunDiagnosticsSchema.Type

/** `GET /api/run`. */
export const RunResponseSchema = Schema.Struct({
  key: Schema.String,
  transcriptPath: Schema.String,
  lanes: Schema.Array(TimelineLaneSchema),
  /** `[path, operations]` pairs, ordered by the server. */
  files: Schema.Array(Schema.Tuple([Schema.String, Schema.Number])),
  phases: Schema.Array(MilestoneSchema),
  diagnostics: RunDiagnosticsSchema,
  node: PublicRunNodeSchema,
  root: PublicRunNodeSchema,
})

export type RunResponseWire = typeof RunResponseSchema.Type

/**
 * `GET /api/events` — one agent's transcript, after a cursor.
 *
 * `reset` means the provider rewrote the transcript: the client replaces its
 * buffer instead of extending it.
 */
export const EventsResponseSchema = Schema.Struct({
  key: Schema.String,
  events: Schema.Array(TranscriptEventSchema),
  next: Schema.Number,
  revision: Schema.Number,
  reset: Schema.Boolean,
  node: PublicRunNodeSchema,
})

export type EventsResponseWire = typeof EventsResponseSchema.Type

/**
 * `GET /api/session-events` — every agent of one session, merged.
 *
 * A snapshot rather than a cursor: `truncated` says the merge hit the per-poll
 * limit and dropped the oldest events.
 */
export const SessionEventsResponseSchema = Schema.Struct({
  key: Schema.String,
  events: Schema.Array(TranscriptEventSchema),
  total: Schema.Number,
  truncated: Schema.Boolean,
})

export type SessionEventsResponseWire = typeof SessionEventsResponseSchema.Type

const _publicNodeWireAcceptsServerShape: PublicRunNodeWire =
  undefined as unknown as PublicRunNode
void _publicNodeWireAcceptsServerShape

const _runWireAcceptsServerShape: RunResponseWire = undefined as unknown as RunResponse
void _runWireAcceptsServerShape

const _eventsWireAcceptsServerShape: EventsResponseWire = undefined as unknown as EventsResponse
void _eventsWireAcceptsServerShape

const _sessionEventsWireAcceptsServerShape: SessionEventsResponseWire =
  undefined as unknown as SessionEventsResponse
void _sessionEventsWireAcceptsServerShape

const ParseIssueSchema = Schema.Struct({
  reason: Schema.Literals(['invalid-json', 'schema-mismatch', 'unsupported-shape']),
  line: Schema.Number,
  recordType: Schema.String,
  detail: Schema.String,
  excerpt: Schema.String,
})

export type ParseIssueWire = typeof ParseIssueSchema.Type

const SessionParseHealthSchema = Schema.Struct({
  skipped: Schema.Number,
  counts: Schema.Struct({
    invalidJson: Schema.Number,
    schemaMismatch: Schema.Number,
    unsupportedShape: Schema.Number,
  }),
  source: SessionSourceSchema,
  sourceDetail: Schema.String,
  projectId: Schema.String,
  projectName: Schema.String,
  key: Schema.String,
  label: Schema.String,
  transcriptPath: Schema.String,
  lastTs: TimestampSchema,
  samples: Schema.Array(ParseIssueSchema),
})

export type SessionParseHealthWire = typeof SessionParseHealthSchema.Type

/** `GET /api/debug` — which records the scanners had to skip, and why. */
export const ParseHealthResponseSchema = Schema.Struct({
  hours: Schema.Number,
  sources: Schema.Array(SessionSourceStatusSchema),
  sessions: Schema.Array(SessionParseHealthSchema),
  skipped: Schema.Number,
  sampleLimit: Schema.Number,
})

export type ParseHealthResponseWire = typeof ParseHealthResponseSchema.Type

const _parseHealthWireAcceptsServerShape: ParseHealthResponseWire =
  undefined as unknown as ParseHealthResponse
void _parseHealthWireAcceptsServerShape

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
