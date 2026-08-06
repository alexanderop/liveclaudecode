export type Timestamp = string | null

export type SessionSource = 'claude' | 'codex' | 'copilot'

export type SourceState = 'ready' | 'degraded' | 'unavailable'

export interface SessionSourceStatus {
  source: SessionSource
  state: SourceState
  sessions: number
  malformed: number
  message: string
}

export type EventKind =
  | 'text'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'prompt'
  | 'meta'
  | 'system'

export interface Usage {
  in: number
  out: number
  cr: number
  cw: number
}

export interface CostEstimate {
  usd: number
  pricedRequests: number
  unpricedRequests: number
  estimated: true
}

export interface CostSummary extends CostEstimate {
  currency: 'USD'
  todayUsd: number
  /** Null when the selected transcript range does not cover seven days. */
  last7DaysUsd: number | null
  coverageHours: number
}

export interface CostOverviewDay {
  date: string
  estimatedUsd: number
  usage: Usage
}

export interface CostOverviewGroup {
  source: SessionSource
  label: string
  model: string | null
  sessions: number
  usage: Usage
  estimatedUsd: number | null
  pricedRequests: number
  unpricedRequests: number
  days: CostOverviewDay[]
}

export interface CostOverviewResponse {
  now: number
  hours: number
  currency: 'USD'
  estimated: true
  estimatedUsd: number
  pricedRequests: number
  unpricedRequests: number
  sessions: number
  usage: Usage
  harnesses: CostOverviewGroup[]
  models: CostOverviewGroup[]
  sources: SessionSourceStatus[]
}

export interface TranscriptEvent {
  role: 'assistant' | 'user' | 'tool' | 'system'
  kind: EventKind
  ts: Timestamp
  line: number
  body?: string
  full?: number
  tool?: string
  id?: string
  summary?: string
  input?: string
  spawn?: boolean
  write?: boolean
  error?: boolean
  model?: string
  usage?: Usage
  childKey?: string
  uuid?: string
  parentUuid?: string | null
  requestId?: string
  promptId?: string
  sourceUuid?: string
  sidechain?: boolean
  stopReason?: string | null
  effort?: string
  /** Present when events are returned as a merged, session-wide activity stream. */
  agentKey?: string
  agentLabel?: string
  agentType?: string
  agentDepth?: number
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info'

export interface DiagnosticIncident {
  id: string
  severity: DiagnosticSeverity
  category: 'api' | 'tool' | 'permission' | 'hook' | 'timeout' | 'interruption' | 'agent' | 'truncation' | 'workflow' | 'lsp'
  title: string
  detail: string
  ts: Timestamp
  line: number
  tool?: string
  code?: string
  toolUseId?: string
  who?: string
  key?: string
}

export interface TurnTiming {
  ts: Timestamp
  durationMs: number
  messageCount: number
  pendingAgents: number
  pendingWorkflows: number
  who?: string
  key?: string
}

export interface ContextUsageSample {
  ts: Timestamp
  model: string
  effort: string
  usage: Usage
  stopReason: string | null
  messageId?: string
  requestId?: string
  cacheWrite5m?: number
  cacheWrite1h?: number
  webSearchRequests?: number
  serviceTier?: string
  inferenceGeo?: string
  speed?: string
  who?: string
  key?: string
}

export interface CompactionEvent {
  ts: Timestamp
  durationMs: number
  preTokens: number
  postTokens: number
  droppedTokens: number
  preservedMessages: number
  trigger: string
  who?: string
  key?: string
}

export interface SessionEnvironment {
  cwd: string
  gitBranch: string
  version: string
  entrypoint: string
  permissionMode: string
  /** The harness interaction mode — Claude's `normal`/`plan`, Copilot's chat mode. */
  mode: string
}

export interface ToolStats {
  reads: number
  searches: number
  commands: number
  edits: number
  linesAdded: number
  linesRemoved: number
  other: number
}

export interface AgentOutcome {
  toolUseId: string
  ts: Timestamp
  status: string
  model: string
  durationMs: number
  totalTokens: number
  totalToolUseCount: number
  stats: ToolStats
  childKey?: string
  label?: string
}

export interface ChangeDetail {
  toolUseId: string
  ts: Timestamp
  tool: string
  path: string
  linesAdded: number
  linesRemoved: number
  userModified: boolean
  staleRecovered: boolean
  who?: string
  key?: string
}

export interface GitEvent {
  toolUseId: string
  ts: Timestamp
  kind: 'commit' | 'push' | 'pr' | 'branch'
  label: string
  url?: string
  who?: string
  key?: string
}

/**
 * The budget the harness itself reports, as opposed to the `CostEstimate` this
 * tool derives from a local price table. Rewritten as the session runs, so the
 * last record is the current state.
 */
export interface BudgetReport {
  usedUsd: number
  totalUsd: number
  remainingUsd: number
  ts: Timestamp
}

/**
 * One hook's activity across a session, aggregated rather than listed: a
 * `UserPromptSubmit` hook fires on every prompt, so the per-invocation records
 * are repetitive while the totals are what identify a slow or flaky hook.
 */
export interface HookSummary {
  name: string
  event: string
  runs: number
  failures: number
  totalMs: number
  maxMs: number
  lastTs: Timestamp
}

export interface CausalSummary {
  records: number
  recordsWithUuid: number
  branchPoints: number
  sidechainRecords: number
  interruptions: number
}

export interface ScanDiagnostics {
  incidents: DiagnosticIncident[]
  turns: TurnTiming[]
  context: ContextUsageSample[]
  compactions: CompactionEvent[]
  outcomes: AgentOutcome[]
  changes: ChangeDetail[]
  git: GitEvent[]
  environment: SessionEnvironment
  causal: CausalSummary
  /** Claude-only signals; the Codex and Copilot scanners omit them. */
  hooks?: HookSummary[]
  budget?: BudgetReport
}

export interface AgentDiagnosticSummary {
  key: string
  label: string
  agentType: string
  models: string[]
  efforts: string[]
  usage: Usage
  turns: number
  turnDurationMs: number
  compactions: number
  branchPoints: number
  sidechainRecords: number
}

/**
 * Why a transcript record was skipped. The distinction matters to whoever has
 * to act on it: `invalid-json` is a damaged or still-being-written file,
 * whereas `schema-mismatch` and `unsupported-shape` mean a record the provider
 * wrote in a shape liveclaudecode does not model — a gap on our side, not the
 * user's. An unrecognised record `type` is *not* an issue; the schemas surface
 * those as `unknown` records on purpose, since providers add kinds over time.
 */
export type ParseIssueReason = 'invalid-json' | 'schema-mismatch' | 'unsupported-shape'

/** One skipped record, kept so a skip can be traced back to a file and line. */
export interface ParseIssue {
  reason: ParseIssueReason
  /** Zero-based line index within the transcript, as the scanners count lines. */
  line: number
  /** The record's `type`/`kind` discriminator, or '' when it had none. */
  recordType: string
  /** Human-readable cause: the decode failure, or the JSON parse error. */
  detail: string
  /** Bounded excerpt of the offending record, for eyeballing the shape. */
  excerpt: string
}

export interface ParseIssueCounts {
  invalidJson: number
  schemaMismatch: number
  unsupportedShape: number
}

/** Per-session parse outcome; `skipped` is the sum of `counts`. */
export interface SessionParseSummary {
  skipped: number
  counts: ParseIssueCounts
}

/** A session's parse health plus the sampled issues behind it, for `/debug`. */
export interface SessionParseHealth extends SessionParseSummary {
  source: SessionSource
  sourceDetail: string
  projectId: string
  projectName: string
  key: string
  label: string
  transcriptPath: string
  lastTs: Timestamp
  samples: ParseIssue[]
}

export interface ParseHealthResponse {
  hours: number
  sources: SessionSourceStatus[]
  /** Sessions that skipped at least one record, worst first. */
  sessions: SessionParseHealth[]
  skipped: number
  /** How many issues each session retains, so the UI can say "first N". */
  sampleLimit: number
}

export interface RunDiagnostics {
  incidents: DiagnosticIncident[]
  turns: TurnTiming[]
  /** One entry per model request, in timestamp order; the context-pressure series. */
  context: ContextUsageSample[]
  compactions: CompactionEvent[]
  outcomes: AgentOutcome[]
  changes: ChangeDetail[]
  git: GitEvent[]
  agents: AgentDiagnosticSummary[]
  environment: SessionEnvironment
  causal: CausalSummary
  usage: Usage
  cost?: CostEstimate
  /** Hook activity per hook name; absent for harnesses that do not record it. */
  hooks?: HookSummary[]
  /** The harness-reported budget, which outranks `cost` when present. */
  budget?: BudgetReport
  /** Records skipped across this run's own transcripts, split by cause. */
  parse: SessionParseSummary
}

export interface CurrentActivity {
  tool: string
  summary: string
  ts: Timestamp
}

export interface Todo {
  content?: string
  activeForm?: string
  status: 'pending' | 'in_progress' | 'completed' | string
}

export interface SkillUse {
  skill: string
  ts: Timestamp
}

export interface Milestone {
  title: string
  ts: Timestamp
  strong: boolean
  who?: string
}

export interface FileChange {
  path: string
  ops: number
  tools: string[]
  lastTs: Timestamp
}

export interface CommandRun {
  cmd: string
  ts: Timestamp
  ok: boolean | null
  tid: string
  /** Why the command exited as it did, when the transcript said so explicitly. */
  note?: string
}

export interface TranscriptStats {
  records: number
  tools: number
  toolCounts: Record<string, number>
  reads: number
  errors: number
  tokensOut: number
  firstTs: Timestamp
  lastTs: Timestamp
  mtime: number
  ago: number
  live: boolean
  size: number
  todos: Todo[] | null
  skills: SkillUse[]
  milestones: Milestone[]
  current: CurrentActivity | null
  files: FileChange[]
  commands: CommandRun[]
  finalText: string
}

export interface RunNode extends TranscriptStats {
  source: SessionSource
  sourceDetail: string
  key: string
  kind: 'session' | 'subagent'
  sid: string
  /** The name to display: `title` when the harness recorded one, else `openingPrompt`. */
  label: string
  /** A harness-recorded session title (user-set, or one the model generated); '' when none. */
  title: string
  /** The prompt that started the session, kept even when `title` supersedes it as the label. */
  openingPrompt: string
  /** The most recent human instruction, which for a live session is what it is working on. */
  lastPrompt: string
  agentType: string
  toolUseId: string | null
  model: string
  spawnDepth: number | null
  parentAgentId: string | null
  stoppedByUser: boolean
  spawnState: '' | 'running' | 'returned'
  children: RunNode[]
  subAgents: number
  subRunning: number
  subErrors: number
  subTools: number
  subFiles: Record<string, number>
  subLast: Timestamp
  subLive: boolean
}

export type PublicRunNode = Omit<RunNode, 'children' | 'subFiles'>

export interface TimelineLane {
  key: string
  label: string
  agentType: string
  kind: RunNode['kind']
  depth: number
  firstTs: Timestamp
  lastTs: Timestamp
  live: boolean
  errors: number
  tools: number
  spawnState: RunNode['spawnState']
  files: number
}

export interface TreeResponse {
  projects: ProjectRuns[]
  sources: SessionSourceStatus[]
  now: number
  hours: number
  /** Always present: `listSessions` summarises costs unconditionally. */
  costs: CostSummary
}

export interface ProjectRuns {
  id: string
  name: string
  roots: RunNode[]
}

export interface RunResponse {
  key: string
  transcriptPath: string
  lanes: TimelineLane[]
  files: Array<[string, number]>
  phases: Milestone[]
  diagnostics: RunDiagnostics
  node: PublicRunNode
  root: PublicRunNode
}

export interface EventsResponse {
  key: string
  events: TranscriptEvent[]
  next: number
  revision: number
  reset: boolean
  node: PublicRunNode
}

export interface SessionEventsResponse {
  key: string
  events: TranscriptEvent[]
  total: number
  truncated: boolean
}
