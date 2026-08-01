import type {
  EventsResponse,
  PublicRunNode,
  RunDiagnostics,
  RunNode,
  RunResponse,
  SessionEventsResponse,
  TimelineLane,
  TranscriptEvent,
  TreeResponse,
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
