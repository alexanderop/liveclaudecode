import type {
  PublicRunNode,
  RunDiagnostics,
  RunNode,
  RunResponse,
} from '#shared/types/run'

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
    firstTs: '2026-07-25T18:00:00.000Z',
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

function diagnostics(): RunDiagnostics {
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
  }
}

export function runResponse(overrides: Partial<RunResponse> = {}): RunResponse {
  const root = runNode()
  return {
    key: root.key,
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
    diagnostics: diagnostics(),
    node: publicNode(root),
    root: publicNode(root),
    ...overrides,
  }
}
