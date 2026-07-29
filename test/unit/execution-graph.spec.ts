import { describe, expect, it } from 'vitest'
import type { TimelineLane } from '../../shared/types/run'
import { buildExecutionGraph } from '../../app/utils/execution-graph'
import { runNode } from '../fixtures/runs'

function lane(
  key: string,
  depth: number,
  options: Partial<TimelineLane> = {},
): TimelineLane {
  return {
    key,
    depth,
    label: key,
    agentType: '',
    kind: depth ? 'subagent' : 'session',
    firstTs: null,
    lastTs: null,
    live: false,
    errors: 0,
    tools: 0,
    spawnState: '',
    files: 0,
    ...options,
  }
}

describe('execution graph layout', () => {
  it('connects each nested lane to its nearest parent', () => {
    const graph = buildExecutionGraph([
      lane('root', 0),
      lane('research', 1),
      lane('source-check', 2),
      lane('implementation', 1),
    ])

    expect(graph.edges.map(edge => [edge.source, edge.target])).toEqual([
      ['research', 'source-check'],
      ['root', 'research'],
      ['root', 'implementation'],
    ])
    expect(graph.nodes.find(node => node.id === 'source-check')?.position.x).toBe(600)
  })

  it('surfaces active, blocked, failed, completed, and inactive states', () => {
    const graph = buildExecutionGraph([
      lane('root', 0),
      lane('live', 1, { live: true }),
      lane('blocked', 1, { spawnState: 'running' }),
      lane('failed', 1, { errors: 2 }),
      lane('completed', 1, { firstTs: '2026-07-28T10:00:00.000Z' }),
      lane('inactive', 1),
    ])

    expect(graph.nodes.find(node => node.id === 'live')?.data?.state).toBe('active')
    expect(graph.nodes.find(node => node.id === 'blocked')?.data?.state).toBe('blocked')
    expect(graph.nodes.find(node => node.id === 'failed')?.data?.state).toBe('failed')
    expect(graph.nodes.find(node => node.id === 'completed')?.data?.state).toBe('completed')
    expect(graph.nodes.find(node => node.id === 'inactive')?.data?.state).toBe('inactive')
    expect(graph.edges.find(edge => edge.target === 'live')?.animated).toBe(true)
  })

  it('shows a recovered tool failure as completed with warnings without double counting it', () => {
    const child = runNode({
      key: 'worker',
      kind: 'subagent',
      errors: 1,
      subErrors: 1,
      finalText: 'Recovered and returned a result.',
      children: [],
    })
    const root = runNode({ key: 'root', errors: 0, subErrors: 1, children: [child] })
    const graph = buildExecutionGraph(
      [lane('root', 0), lane('worker', 1, { errors: 1, tools: 3 })],
      new Map(),
      'left-to-right',
      'all-agents',
      {
        root,
        diagnostics: {
          incidents: [{
            id: 'tool-error',
            severity: 'error',
            category: 'tool',
            title: 'Bash failed',
            detail: 'Recovered later',
            ts: null,
            line: 3,
            key: 'worker',
          }],
          turns: [],
          compactions: [],
          outcomes: [],
          changes: [],
          git: [],
          agents: [],
          environment: { cwd: '', gitBranch: '', version: '', entrypoint: '', permissionMode: '' },
          causal: { records: 0, recordsWithUuid: 0, branchPoints: 0, sidechainRecords: 0, interruptions: 0 },
          usage: { in: 0, out: 0, cr: 0, cw: 0 },
        },
      },
    )

    expect(graph.nodes.find(node => node.id === 'worker')?.data).toMatchObject({
      state: 'completed',
      displayState: 'warning',
      issues: 1,
    })
  })

  it('preserves positions after a user drags an agent', () => {
    const graph = buildExecutionGraph(
      [lane('root', 0), lane('worker', 1)],
      new Map([['worker', { x: 42, y: 84 }]]),
    )

    expect(graph.nodes.find(node => node.id === 'worker')?.position).toEqual({ x: 42, y: 84 })
  })

  it('preserves existing positions when live activity adds a lane', () => {
    const updated = buildExecutionGraph(
      [
        lane('root', 0, { live: true }),
        lane('worker', 1, { live: true, tools: 4 }),
        lane('new-reviewer', 1, { spawnState: 'running' }),
      ],
      new Map([
        ['root', { x: 18, y: 28 }],
        ['worker', { x: 412, y: 96 }],
      ]),
    )

    expect(updated.nodes.find(node => node.id === 'root')?.position).toEqual({ x: 18, y: 28 })
    expect(updated.nodes.find(node => node.id === 'worker')?.position).toEqual({ x: 412, y: 96 })
    expect(updated.nodes.find(node => node.id === 'new-reviewer')?.data?.state).toBe('blocked')
  })

  it('can arrange the graph from top to bottom', () => {
    const graph = buildExecutionGraph(
      [lane('root', 0), lane('research', 1), lane('source-check', 2), lane('implementation', 1)],
      new Map(),
      'top-to-bottom',
    )

    expect(graph.nodes.find(node => node.id === 'root')?.position.y).toBe(0)
    expect(graph.nodes.find(node => node.id === 'research')?.position.y).toBe(180)
    expect(graph.nodes.find(node => node.id === 'source-check')?.position.y).toBe(360)
    expect(graph.nodes.find(node => node.id === 'implementation')?.position.x).toBeGreaterThan(
      graph.nodes.find(node => node.id === 'research')?.position.x || 0,
    )
  })

  it('collapses nested agents into readable workstreams for overview mode', () => {
    const graph = buildExecutionGraph(
      [
        lane('root', 0, { tools: 5 }),
        lane('implementation', 1, { tools: 10 }),
        lane('research', 2, { tools: 7, errors: 1 }),
        lane('qa', 1, { tools: 4 }),
      ],
      new Map(),
      'left-to-right',
      'overview',
    )

    expect(graph.nodes.map(node => node.id).sort()).toEqual(['implementation', 'qa', 'root'])
    expect(graph.edges.map(edge => [edge.source, edge.target])).toEqual([
      ['root', 'implementation'],
      ['root', 'qa'],
    ])
    expect(graph.nodes.find(node => node.id === 'implementation')?.data).toMatchObject({
      agents: 2,
      errors: 1,
      overview: true,
      state: 'failed',
      tools: 17,
      workstream: 1,
    })
    expect(graph.nodes.find(node => node.id === 'qa')?.position.x).toBeGreaterThan(
      graph.nodes.find(node => node.id === 'implementation')?.position.x || 0,
    )
  })

  it('keeps a nested selection visible on its collapsed overview workstream', () => {
    const graph = buildExecutionGraph(
      [
        lane('root', 0),
        lane('implementation', 1, { tools: 3 }),
        lane('review', 2, { tools: 2 }),
      ],
      new Map(),
      'left-to-right',
      'overview',
    )

    expect(graph.nodes.find(node => node.id === 'implementation')?.data?.memberKeys)
      .toEqual(['implementation', 'review'])
    expect(graph.nodes.find(node => node.id === 'root')?.data).toMatchObject({
      memberKeys: ['root'],
    })
  })

  it('puts causal spawn and return timing on edges', () => {
    const graph = buildExecutionGraph([
      lane('root', 0),
      lane('worker', 1, {
        tools: 2,
        files: 1,
        firstTs: '2026-07-28T10:00:00.000Z',
        lastTs: '2026-07-28T10:00:05.000Z',
        spawnState: 'returned',
      }),
      lane('silent', 1),
    ])

    expect(graph.edges.find(edge => edge.target === 'worker')).toMatchObject({
      interactionWidth: 40,
      data: { durationMs: 5_000, relation: 'returned' },
    })
    expect(graph.edges.find(edge => edge.target === 'worker')?.label).toContain('returned 5s')
    expect(graph.edges.find(edge => edge.target === 'silent')?.label).toBe('')
  })

  it('replays the graph at a historical cursor and hides future agents', () => {
    const graph = buildExecutionGraph(
      [
        lane('root', 0, { firstTs: '2026-07-28T10:00:00.000Z', lastTs: '2026-07-28T10:01:00.000Z' }),
        lane('active-then', 1, { firstTs: '2026-07-28T10:00:05.000Z', lastTs: '2026-07-28T10:00:30.000Z' }),
        lane('future', 1, { firstTs: '2026-07-28T10:00:40.000Z', lastTs: '2026-07-28T10:00:50.000Z' }),
      ],
      new Map(),
      'left-to-right',
      'all-agents',
      { asOf: Date.parse('2026-07-28T10:00:15.000Z') },
    )

    expect(graph.nodes.map(node => node.id)).toEqual(['active-then', 'root'])
    expect(graph.nodes.find(node => node.id === 'active-then')?.data?.state).toBe('active')
    expect(graph.edges.find(edge => edge.target === 'active-then')?.data?.relation).toBe('running')
  })

  it('dims non-matching agents while retaining their ancestors for investigation context', () => {
    const graph = buildExecutionGraph(
      [lane('root', 0), lane('healthy', 1, { tools: 2 }), lane('failed', 1, { errors: 1 })],
      new Map(),
      'left-to-right',
      'all-agents',
      { lens: 'problems' },
    )

    expect(graph.nodes.find(node => node.id === 'root')?.data?.muted).toBe(false)
    expect(graph.nodes.find(node => node.id === 'failed')?.data?.muted).toBe(false)
    expect(graph.nodes.find(node => node.id === 'healthy')?.data?.muted).toBe(true)
  })

  it('highlights the selected causal branch in both directions', () => {
    const graph = buildExecutionGraph(
      [lane('root', 0), lane('parent', 1), lane('selected', 2), lane('child', 3), lane('sibling', 1)],
      new Map(),
      'left-to-right',
      'all-agents',
      { selectedKey: 'selected' },
    )

    expect(graph.nodes.filter(node => node.data?.onPath).map(node => node.id)).toEqual([
      'child',
      'selected',
      'parent',
      'root',
    ])
    expect(graph.edges.filter(edge => edge.data?.onPath).map(edge => edge.id)).toEqual([
      'selected->child',
      'parent->selected',
      'root->parent',
    ])
  })

  it('collapses a subtree into a rollup card and preserves all member keys', () => {
    const graph = buildExecutionGraph(
      [lane('root', 0), lane('group', 1, { tools: 2 }), lane('worker', 2, { tools: 4 }), lane('sibling', 1)],
      new Map(),
      'left-to-right',
      'all-agents',
      { collapsedKeys: new Set(['group']) },
    )

    expect(graph.nodes.map(node => node.id)).toEqual(['group', 'sibling', 'root'])
    expect(graph.nodes.find(node => node.id === 'group')?.data).toMatchObject({
      agents: 2,
      collapsed: true,
      memberKeys: ['group', 'worker'],
      tools: 6,
    })
  })
})
