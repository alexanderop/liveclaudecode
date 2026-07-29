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
  category: 'api' | 'tool' | 'permission' | 'hook' | 'timeout' | 'interruption' | 'agent' | 'truncation' | 'workflow'
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
  requestId?: string
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

export interface RunDiagnostics {
  incidents: DiagnosticIncident[]
  turns: TurnTiming[]
  compactions: CompactionEvent[]
  outcomes: AgentOutcome[]
  changes: ChangeDetail[]
  git: GitEvent[]
  agents: AgentDiagnosticSummary[]
  environment: SessionEnvironment
  causal: CausalSummary
  usage: Usage
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
  label: string
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
