import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ExecutionAgentNode from '~/components/ExecutionAgentNode.vue'
import { ExecutionCanvasKey } from '~/composables/useExecutionCanvas'
import { executionNodeData } from '../fixtures/execution'

let component: VueWrapper | null = null

afterEach(() => {
  component?.unmount()
  component = null
})

describe('execution agent node', () => {
  it('renders accessible selection state and delegates keyboard selection', async () => {
    const selectNode = vi.fn()
    const wrapper = component = mount(ExecutionAgentNode, {
      props: {
        id: 'explore',
        data: executionNodeData(),
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

    const node = wrapper.get('.sketch-node')
    expect(node.classes()).toContain('active')
    expect(node.attributes('aria-current')).toBe('true')
    expect(node.attributes('aria-label')).toContain('Explore agent, Running')

    await node.trigger('keydown', { key: 'Enter' })
    expect(selectNode).toHaveBeenCalledWith('explore')
  })

  it('shows a parent agent child count and exposes branch collapsing', async () => {
    const toggleNode = vi.fn()
    const wrapper = component = mount(ExecutionAgentNode, {
      props: {
        id: 'explore',
        data: executionNodeData({ childCount: 3, collapsible: true }),
        selected: false,
      },
      global: {
        provide: {
          [ExecutionCanvasKey as symbol]: {
            layoutDirection: ref('left-to-right'),
            selectNode: vi.fn(),
            toggleNode,
          },
        },
        stubs: {
          Handle: true,
          UIcon: true,
        },
      },
    })

    expect(wrapper.get('.sketch-child-count').text()).toContain('3 children')
    await wrapper.get('.sketch-collapse').trigger('click')
    expect(toggleNode).toHaveBeenCalledWith('explore')
  })
})
