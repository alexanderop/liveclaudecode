import { mount } from '@vue/test-utils'
import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import ExecutionAgentNode from '~/components/ExecutionAgentNode.vue'
import { ExecutionCanvasKey } from '~/composables/useExecutionCanvas'
import type { ExecutionNodeData } from '~/utils/execution-graph'

const data: ExecutionNodeData = {
  label: 'Explore agent',
  agentType: 'Explore',
  tools: 3,
  files: 1,
  tokens: 1200,
  firstTs: null,
  lastTs: null,
  depth: 1,
  root: false,
  state: 'active',
  displayState: 'running',
  overview: false,
  agents: 1,
  errors: 0,
  incidents: 0,
  issues: 0,
  changes: 1,
  workstream: 1,
  memberKeys: ['explore'],
  summary: 'Running the focused test suite',
  currentTool: 'Bash',
  idleMs: 0,
  pendingChildren: 0,
  collapsed: false,
  collapsible: false,
  muted: false,
  onPath: true,
  collision: false,
  critical: true,
  bottleneck: false,
  focusedFile: false,
}

describe('execution agent node', () => {
  it('renders accessible selection state and delegates keyboard selection', async () => {
    const selectNode = vi.fn()
    const component = mount(ExecutionAgentNode, {
      props: {
        id: 'explore',
        data,
        selected: true,
      },
      global: {
        provide: {
          [ExecutionCanvasKey as symbol]: {
            layoutDirection: ref('left-to-right'),
            selectNode,
          },
        },
        stubs: {
          Handle: true,
          UIcon: true,
        },
      },
    })

    const node = component.get('.sketch-node')
    expect(node.classes()).toContain('active')
    expect(node.attributes('aria-current')).toBe('true')
    expect(node.attributes('aria-label')).toContain('Explore agent, Running')

    await node.trigger('keydown', { key: 'Enter' })
    expect(selectNode).toHaveBeenCalledWith('explore')
  })
})
