import type {
  CostOverviewGroup,
  CostOverviewResponse,
  EventsResponse,
  ParseHealthResponse,
  PublicRunNode,
  RunDiagnostics,
  RunNode,
  RunResponse,
  SessionEventsResponse,
  SessionParseHealth,
  TimelineLane,
  TranscriptEvent,
  TreeResponse,
  Usage,
} from '#shared/types/run'

/** Base timestamp of the fixture session; later fixture times offset from it. */
export const T0 = '2026-07-25T18:00:00.000Z'

/** Look-back window the dashboard requests by default. */
export const DEFAULT_HOURS = 168

/** Project id used by `treeResponse` and the default `mockLiveApi` handlers. */
export const PROJECT_ID = '/repo'

export function runNode(overrides: Partial<RunNode> = {}): RunNode {
  return {
    source: 'claude',
    sourceDetail: 'Claude Code',
    key: 'session',
    kind: 'session',
    sid: 'session',
    label: 'Ship the dashboard',
    title: '',
    openingPrompt: 'Ship the dashboard',
    lastPrompt: '',
    agentType: '',
    toolUseId: null,
    model: 'claude-sonnet-5',
    spawnDepth: null,
    parentAgentId: null,
    stoppedByUser: false,
    spawnState: 'returned',
    children: [],
    records: 8,
    tools: 3,
    toolCounts: { Edit: 1, Bash: 2 },
    reads: 0,
    errors: 1,
    tokensOut: 120,
    firstTs: T0,
    lastTs: '2026-07-25T18:02:00.000Z',
    mtime: 0,
    ago: 0,
    live: false,
    size: 1_024,
    todos: [
      { content: 'Inspect transcripts', status: 'completed' },
      { content: 'Run checks', activeForm: 'Running checks', status: 'in_progress' },
    ],
    skills: [],
    milestones: [{
      title: 'Validation',
      ts: '2026-07-25T18:01:00.000Z',
      strong: true,
      who: 'main',
    }],
    current: null,
    files: [{
      path: 'app/components/Dashboard.vue',
      ops: 1,
      tools: ['Edit'],
      lastTs: '2026-07-25T18:01:00.000Z',
    }],
    commands: [
      { cmd: 'pnpm test:unit', ts: '2026-07-25T18:01:00.000Z', ok: true, tid: 'test' },
      { cmd: 'pnpm test:nuxt', ts: '2026-07-25T18:02:00.000Z', ok: false, tid: 'nuxt' },
    ],
    finalText: 'The dashboard is ready for review.',
    subAgents: 0,
    subRunning: 0,
    subErrors: 1,
    subTools: 3,
    subFiles: { 'app/components/Dashboard.vue': 1 },
    subLast: '2026-07-25T18:02:00.000Z',
    subLive: false,
    ...overrides,
  }
}

function publicNode(node: RunNode): PublicRunNode {
  const { children: _children, subFiles: _subFiles, ...publicFields } = node
  return publicFields
}

export function runDiagnostics(overrides: Partial<RunDiagnostics> = {}): RunDiagnostics {
  return {
    incidents: [],
    turns: [],
    context: [
      {
        ts: T0,
        model: 'claude-sonnet-5',
        effort: 'medium',
        usage: { in: 100, out: 40, cr: 10, cw: 200 },
        stopReason: 'tool_use',
        who: 'main',
        key: 'session',
      },
      {
        ts: '2026-07-25T18:01:00.000Z',
        model: 'claude-sonnet-5',
        effort: 'medium',
        usage: { in: 200, out: 80, cr: 40, cw: 0 },
        stopReason: 'end_turn',
        who: 'main',
        key: 'session',
      },
    ],
    compactions: [],
    outcomes: [],
    changes: [{
      toolUseId: 'edit',
      ts: '2026-07-25T18:01:00.000Z',
      tool: 'Edit',
      path: 'app/components/Dashboard.vue',
      linesAdded: 12,
      linesRemoved: 3,
      userModified: false,
      staleRecovered: false,
      who: 'main',
      key: 'session',
    }],
    git: [{
      toolUseId: 'pr',
      ts: '2026-07-25T18:02:00.000Z',
      kind: 'pr',
      label: 'Open pull request',
      url: 'https://example.com/pull/1',
      who: 'main',
      key: 'session',
    }],
    agents: [],
    environment: {
      cwd: '/repo',
      gitBranch: 'feature/testing',
      version: '2.1.0',
      entrypoint: 'cli',
      permissionMode: 'default',
      mode: 'normal',
    },
    causal: {
      records: 8,
      recordsWithUuid: 8,
      branchPoints: 0,
      sidechainRecords: 0,
      interruptions: 0,
    },
    usage: { in: 300, out: 120, cr: 50, cw: 0 },
    cost: { usd: 0.014, pricedRequests: 2, unpricedRequests: 0, estimated: true },
    parse: { skipped: 0, counts: { invalidJson: 0, schemaMismatch: 0, unsupportedShape: 0 } },
    ...overrides,
  }
}

export function timelineLane(overrides: Partial<TimelineLane> = {}): TimelineLane {
  return {
    key: 'session',
    label: 'Ship the dashboard',
    agentType: '',
    kind: 'session',
    depth: 0,
    firstTs: T0,
    lastTs: '2026-07-25T18:02:00.000Z',
    live: false,
    errors: 0,
    tools: 3,
    spawnState: 'returned',
    files: 1,
    ...overrides,
  }
}

export function transcriptEvent(
  body: string,
  overrides: Partial<TranscriptEvent> = {},
): TranscriptEvent {
  return {
    role: 'assistant',
    kind: 'text',
    ts: '2026-07-29T08:00:00.000Z',
    line: 1,
    body,
    ...overrides,
  }
}

export function eventsResponse(
  key: string,
  bodies: string[],
  overrides: Partial<EventsResponse> = {},
): EventsResponse {
  return {
    key,
    events: bodies.map(body => transcriptEvent(body)),
    next: bodies.length,
    revision: 1,
    reset: false,
    node: runNode({ key }),
    ...overrides,
  }
}

export function sessionEventsResponse(
  key: string,
  bodies: string[] = [],
  overrides: Partial<SessionEventsResponse> = {},
): SessionEventsResponse {
  return {
    key,
    events: bodies.map(body => transcriptEvent(body)),
    total: bodies.length,
    truncated: false,
    ...overrides,
  }
}

export function treeResponse(
  roots: RunNode | RunNode[],
  hours = DEFAULT_HOURS,
): TreeResponse {
  return {
    projects: [{
      id: PROJECT_ID,
      name: 'repo',
      roots: Array.isArray(roots) ? roots : [roots],
    }],
    sources: [],
    now: 0,
    hours,
  }
}

const usage = (overrides: Partial<Usage> = {}): Usage =>
  ({ in: 1_000, out: 400, cr: 3_000, cw: 200, ...overrides })

/**
 * One row of the cost overview. Both the harness cards and the model table
 * are built from this shape, so the same builder serves both.
 */
export function costOverviewGroup(
  overrides: Partial<CostOverviewGroup> = {},
): CostOverviewGroup {
  return {
    source: 'claude',
    label: 'Claude Code',
    model: 'claude-opus-5',
    sessions: 3,
    usage: usage(),
    estimatedUsd: 1.25,
    pricedRequests: 12,
    unpricedRequests: 0,
    days: [
      { date: '2026-07-24', estimatedUsd: 0.5, usage: usage({ in: 400, out: 150 }) },
      { date: '2026-07-25', estimatedUsd: 0.75, usage: usage({ in: 600, out: 250 }) },
    ],
    ...overrides,
  }
}

export function costOverviewResponse(
  overrides: Partial<CostOverviewResponse> = {},
): CostOverviewResponse {
  const harnesses = overrides.harnesses ?? [costOverviewGroup({ model: null })]
  const models = overrides.models ?? [costOverviewGroup()]
  return {
    now: 0,
    hours: 720,
    currency: 'USD',
    estimated: true,
    estimatedUsd: 1.25,
    pricedRequests: 12,
    unpricedRequests: 0,
    sessions: 3,
    usage: usage(),
    sources: [],
    ...overrides,
    harnesses,
    models,
  }
}

export function sessionParseHealth(
  overrides: Partial<SessionParseHealth> = {},
): SessionParseHealth {
  const counts = overrides.counts
    || { invalidJson: 0, schemaMismatch: 2, unsupportedShape: 0 }
  return {
    source: 'claude',
    sourceDetail: 'Claude Code',
    projectId: PROJECT_ID,
    projectName: 'repo',
    key: 'session',
    label: 'Ship the dashboard',
    transcriptPath: '/claude/projects/repo/session.jsonl',
    lastTs: T0,
    skipped: counts.invalidJson + counts.schemaMismatch + counts.unsupportedShape,
    samples: [{
      reason: 'schema-mismatch',
      line: 411,
      recordType: 'assistant',
      detail: 'Missing key at ["message"]["content"]',
      excerpt: '{"type":"assistant","message":{"role":"assistant"}}',
    }],
    ...overrides,
    counts,
  }
}

export function parseHealthResponse(
  sessions: SessionParseHealth[] = [sessionParseHealth()],
  overrides: Partial<ParseHealthResponse> = {},
): ParseHealthResponse {
  return {
    hours: DEFAULT_HOURS,
    sources: [],
    sessions,
    skipped: sessions.reduce((total, session) => total + session.skipped, 0),
    sampleLimit: 8,
    ...overrides,
  }
}

export function runResponse(overrides: Partial<RunResponse> = {}): RunResponse {
  const root = runNode()
  return {
    key: root.key,
    transcriptPath: `/claude/projects/repo/${root.key}.jsonl`,
    lanes: [{
      key: root.key,
      label: root.label,
      agentType: root.agentType,
      kind: root.kind,
      depth: 0,
      firstTs: root.firstTs,
      lastTs: root.lastTs,
      live: root.live,
      errors: root.errors,
      tools: root.tools,
      spawnState: root.spawnState,
      files: root.files.length,
    }],
    files: [['app/components/Dashboard.vue', 1]],
    phases: root.milestones,
    diagnostics: runDiagnostics(),
    node: publicNode(root),
    root: publicNode(root),
    ...overrides,
  }
}
