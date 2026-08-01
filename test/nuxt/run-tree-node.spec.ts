import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import RunTreeNode from '~/components/RunTreeNode.vue'
import { runNode } from '../fixtures/runs'

let component: VueWrapper | null = null

afterEach(() => {
  component?.unmount()
  component = null
})

describe('RunTreeNode', () => {
  it('renders a compact title and emits keyboard-accessible button clicks', async () => {
    const wrapper = component = await mountSuspended(RunTreeNode, {
      props: { node: runNode(), depth: 0, selectedKey: 'session' },
    })
    expect(wrapper.text()).toContain('Ship the dashboard')
    expect(wrapper.get('.tree-meta').text()).toContain('Claude')
    expect(wrapper.get('button').classes()).toContain('selected')
    expect(wrapper.get('button').attributes('aria-selected')).toBe('true')
    await wrapper.get('button').trigger('click')
    expect(wrapper.emitted('select')).toEqual([['session']])
  })

  it('identifies Codex sessions and includes scannable provider metadata', async () => {
    const wrapper = component = await mountSuspended(RunTreeNode, {
      props: {
        node: runNode({
          source: 'codex',
          sourceDetail: 'Codex Desktop',
          key: 'codex:session',
        }),
        depth: 0,
        selectedKey: null,
      },
    })

    expect(wrapper.get('.tree-status').classes()).toContain('codex')
    expect(wrapper.get('.tree-status').attributes('title')).toContain('Codex Desktop')
    expect(wrapper.get('.tree-meta').text()).toContain('Codex')
  })

  it('identifies Copilot sessions and includes scannable provider metadata', async () => {
    const wrapper = component = await mountSuspended(RunTreeNode, {
      props: {
        node: runNode({
          source: 'copilot',
          sourceDetail: 'VS Code Insiders · agent',
          key: 'copilot:session',
        }),
        depth: 0,
        selectedKey: null,
      },
    })

    expect(wrapper.get('.tree-status').classes()).toContain('copilot')
    expect(wrapper.get('.tree-status').attributes('title')).toContain('VS Code Insiders · agent')
    expect(wrapper.get('.tree-meta').text()).toContain('Copilot')
  })

  it('shows live worker status without exposing the current command', async () => {
    const wrapper = component = await mountSuspended(RunTreeNode, {
      props: {
        node: runNode({
          kind: 'subagent',
          agentType: 'implementation-worker',
          spawnState: 'running',
          current: { tool: 'Bash', summary: 'pnpm test', ts: '2026-07-25T18:00:02.000Z' },
        }),
        depth: 1,
        selectedKey: null,
      },
    })
    // The status badge carries only the state; the current command stays out
    // of the row entirely (title, metadata, and status are the only copy).
    expect(wrapper.get('.tree-end').text()).toBe('running')
    expect(wrapper.get('.tree-title').text()).toBe('Ship the dashboard')
    expect(wrapper.get('.tree-meta').text()).not.toContain('pnpm test')
    expect(wrapper.get('.tree-status').attributes('title')).toContain('implementation-worker')
  })

  it('toggles nested agents when a parent row is clicked', async () => {
    const child = runNode({
      key: 'child',
      kind: 'subagent',
      label: 'Nested worker',
      agentType: 'implementation-worker',
    })
    const wrapper = component = await mountSuspended(RunTreeNode, {
      props: {
        node: runNode({ children: [child], subAgents: 1 }),
        depth: 0,
        selectedKey: null,
      },
    })
    const parent = wrapper.findAll('button.tree-node')[0]!

    expect(parent.attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('.tree-children').isVisible()).toBe(true)

    await parent.trigger('click')
    expect(wrapper.emitted('select')).toEqual([['session']])
    expect(parent.attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('.tree-children').exists()).toBe(false)

    await parent.trigger('click')
    expect(parent.attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('.tree-children').attributes('style')).toBeUndefined()
  })
})
