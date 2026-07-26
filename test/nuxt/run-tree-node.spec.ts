import { mountSuspended } from '@nuxt/test-utils/runtime'
import { describe, expect, it } from 'vitest'
import RunTreeNode from '~/components/RunTreeNode.vue'
import type { RunNode } from '#shared/types/run'

function node(overrides: Partial<RunNode> = {}): RunNode {
  return {
    source: 'claude',
    sourceDetail: 'Claude Code',
    key: 'session',
    kind: 'session',
    sid: 'session',
    label: 'Ship the dashboard',
    agentType: '',
    toolUseId: null,
    model: '',
    spawnDepth: null,
    parentAgentId: null,
    stoppedByUser: false,
    spawnState: '',
    children: [],
    records: 1,
    tools: 2,
    toolCounts: { Bash: 2 },
    reads: 0,
    errors: 0,
    tokensOut: 10,
    firstTs: '2026-07-25T18:00:00.000Z',
    lastTs: '2026-07-25T18:00:02.000Z',
    mtime: 0,
    ago: 0,
    live: false,
    size: 10,
    todos: null,
    skills: [],
    milestones: [],
    current: null,
    files: [],
    commands: [],
    finalText: '',
    subAgents: 0,
    subRunning: 0,
    subErrors: 0,
    subTools: 2,
    subFiles: {},
    subLast: '2026-07-25T18:00:02.000Z',
    subLive: false,
    ...overrides,
  }
}

describe('RunTreeNode', () => {
  it('renders the run metadata and emits keyboard-accessible button clicks', async () => {
    const component = await mountSuspended(RunTreeNode, {
      props: { node: node(), depth: 0, selectedKey: 'session' },
    })
    expect(component.text()).toContain('Ship the dashboard')
    expect(component.text()).toContain('Claude')
    expect(component.text()).toContain('2 tools')
    expect(component.get('button').classes()).toContain('selected')
    await component.get('button').trigger('click')
    expect(component.emitted('select')).toEqual([['session']])
  })

  it('visibly tags Codex sessions and keeps their producer detail', async () => {
    const component = await mountSuspended(RunTreeNode, {
      props: {
        node: node({
          source: 'codex',
          sourceDetail: 'Codex Desktop',
          key: 'codex:session',
        }),
        depth: 0,
        selectedKey: null,
      },
    })

    expect(component.text()).toContain('Codex')
    expect(component.text()).toContain('Codex Desktop')
  })

  it('visibly tags Copilot sessions and keeps their VS Code mode detail', async () => {
    const component = await mountSuspended(RunTreeNode, {
      props: {
        node: node({
          source: 'copilot',
          sourceDetail: 'VS Code Insiders · agent',
          key: 'copilot:session',
        }),
        depth: 0,
        selectedKey: null,
      },
    })

    expect(component.text()).toContain('Copilot')
    expect(component.text()).toContain('VS Code Insiders · agent')
  })

  it('renders current activity for a live worker', async () => {
    const component = await mountSuspended(RunTreeNode, {
      props: {
        node: node({
          kind: 'subagent',
          agentType: 'implementation-worker',
          spawnState: 'running',
          current: { tool: 'Bash', summary: 'pnpm test', ts: '2026-07-25T18:00:02.000Z' },
        }),
        depth: 1,
        selectedKey: null,
      },
    })
    expect(component.text()).toContain('implementation-worker')
    expect(component.text()).toContain('running')
    expect(component.text()).toContain('Bash pnpm test')
  })

  it('toggles nested agents when a parent row is clicked', async () => {
    const child = node({
      key: 'child',
      kind: 'subagent',
      label: 'Nested worker',
      agentType: 'implementation-worker',
    })
    const component = await mountSuspended(RunTreeNode, {
      props: {
        node: node({ children: [child], subAgents: 1 }),
        depth: 0,
        selectedKey: null,
      },
    })
    const parent = component.findAll('button.tree-node')[0]!

    expect(parent.attributes('aria-expanded')).toBe('true')
    expect(component.get('.tree-children').isVisible()).toBe(true)

    await parent.trigger('click')
    expect(component.emitted('select')).toEqual([['session']])
    expect(parent.attributes('aria-expanded')).toBe('false')
    expect(component.get('.tree-children').attributes('style')).toContain('display: none')

    await parent.trigger('click')
    expect(parent.attributes('aria-expanded')).toBe('true')
    expect(component.get('.tree-children').attributes('style')).toBeUndefined()
  })
})
