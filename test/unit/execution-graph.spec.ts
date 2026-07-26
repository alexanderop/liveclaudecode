import { describe, expect, it } from 'vitest'
import type { TimelineLane } from '../../shared/types/run'
import { buildExecutionGraph } from '../../app/utils/execution-graph'

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
    ], null)

    expect(graph.edges.map(edge => [edge.source, edge.target])).toEqual([
      ['research', 'source-check'],
      ['root', 'research'],
      ['root', 'implementation'],
    ])
    expect(graph.nodes.find(node => node.id === 'source-check')?.position.x).toBe(600)
  })

  it('surfaces live, error, and selected states', () => {
    const graph = buildExecutionGraph([
      lane('root', 0),
      lane('live', 1, { live: true }),
      lane('failed', 1, { errors: 2 }),
    ], 'failed')

    expect(graph.nodes.find(node => node.id === 'live')?.data?.state).toBe('live')
    expect(graph.nodes.find(node => node.id === 'failed')?.data?.state).toBe('error')
    expect(graph.nodes.find(node => node.id === 'failed')?.data?.selected).toBe(true)
    expect(graph.edges.find(edge => edge.target === 'live')?.animated).toBe(true)
  })

  it('preserves positions after a user drags an agent', () => {
    const graph = buildExecutionGraph(
      [lane('root', 0), lane('worker', 1)],
      null,
      new Map([['worker', { x: 42, y: 84 }]]),
    )

    expect(graph.nodes.find(node => node.id === 'worker')?.position).toEqual({ x: 42, y: 84 })
  })

  it('can arrange the graph from top to bottom', () => {
    const graph = buildExecutionGraph(
      [lane('root', 0), lane('research', 1), lane('source-check', 2), lane('implementation', 1)],
      null,
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
      null,
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
      state: 'error',
      tools: 17,
      workstream: 1,
    })
    expect(graph.nodes.find(node => node.id === 'qa')?.position.x).toBeGreaterThan(
      graph.nodes.find(node => node.id === 'implementation')?.position.x || 0,
    )
  })
})
