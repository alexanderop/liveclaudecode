import { assert, describe, it } from '@effect/vitest'
import { filterSessionProjects } from '~/utils/session-filter'
import type { ProjectRuns, RunNode, SessionSource } from '#shared/types/run'

function run(
  key: string,
  source: SessionSource,
  label: string,
  options: { detail?: string, live?: boolean, errors?: number } = {},
): RunNode {
  return {
    source,
    sourceDetail: options.detail || (source === 'claude'
      ? 'Claude Code'
      : source === 'codex' ? 'Codex Desktop' : 'VS Code · agent'),
    key,
    kind: 'session',
    sid: key,
    label,
    agentType: '',
    toolUseId: null,
    model: '',
    spawnDepth: null,
    parentAgentId: null,
    stoppedByUser: false,
    spawnState: '',
    children: [],
    records: 2,
    tools: 0,
    toolCounts: {},
    reads: 0,
    errors: options.errors || 0,
    tokensOut: 0,
    firstTs: '2026-07-26T08:00:00.000Z',
    lastTs: '2026-07-26T08:00:01.000Z',
    mtime: 0,
    ago: 0,
    live: options.live || false,
    size: 1,
    todos: null,
    skills: [],
    milestones: [],
    current: null,
    files: [],
    commands: [],
    finalText: '',
    subAgents: 0,
    subRunning: 0,
    subErrors: options.errors || 0,
    subTools: 0,
    subFiles: {},
    subLast: '2026-07-26T08:00:01.000Z',
    subLive: options.live || false,
  }
}

const projects: ProjectRuns[] = [
  {
    id: '/repo',
    name: 'repo',
    roots: [
      run('claude-1', 'claude', 'Fix API'),
      run('codex:1', 'codex', 'Release dashboard', { detail: 'Codex Desktop' }),
      run('copilot:1', 'copilot', 'Repair extension', { detail: 'VS Code Insiders · agent' }),
    ],
  },
  {
    id: '__unassigned__',
    name: 'Unassigned',
    roots: [run('codex:2', 'codex', 'Research notes', { detail: 'codex-tui', live: true })],
  },
]

describe('combined session filters', () => {
  it('combines source, project, and text filters', () => {
    const filtered = filterSessionProjects(projects, {
      query: 'release',
      source: 'codex',
      project: '/repo',
      liveOnly: false,
      attentionOnly: false,
      hideIdle: true,
    })
    assert.strictEqual(filtered.length, 1)
    assert.deepStrictEqual(filtered[0]?.roots.map(root => root.key), ['codex:1'])
  })

  it('searches project names and producer details while respecting source', () => {
    const byProject = filterSessionProjects(projects, {
      query: 'repo',
      source: 'claude',
      project: 'all',
      liveOnly: false,
      attentionOnly: false,
      hideIdle: false,
    })
    assert.deepStrictEqual(byProject[0]?.roots.map(root => root.key), ['claude-1'])

    const byProducer = filterSessionProjects(projects, {
      query: 'desktop',
      source: 'all',
      project: 'all',
      liveOnly: false,
      attentionOnly: false,
      hideIdle: false,
    })
    assert.deepStrictEqual(byProducer.flatMap(project => project.roots.map(root => root.key)), ['codex:1'])
  })

  it('retains projectless sessions and composes live filtering with source filtering', () => {
    const filtered = filterSessionProjects(projects, {
      query: '',
      source: 'codex',
      project: '__unassigned__',
      liveOnly: true,
      attentionOnly: false,
      hideIdle: true,
    })
    assert.deepStrictEqual(filtered.map(project => project.name), ['Unassigned'])
    assert.deepStrictEqual(filtered[0]?.roots.map(root => root.key), ['codex:2'])
  })

  it('combines Copilot source, project, and text filtering', () => {
    const filtered = filterSessionProjects(projects, {
      query: 'extension',
      source: 'copilot',
      project: '/repo',
      liveOnly: false,
      attentionOnly: false,
      hideIdle: true,
    })
    assert.deepStrictEqual(filtered.flatMap(project => project.roots.map(root => root.key)), ['copilot:1'])
  })
})
