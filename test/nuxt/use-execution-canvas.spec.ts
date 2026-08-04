import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, shallowRef } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionCanvasContext } from '~/composables/useExecutionCanvas'
import { provideExecutionCanvas, useExecutionCanvas } from '~/composables/useExecutionCanvas'

const Probe = defineComponent({
  setup() {
    return { context: useExecutionCanvas() }
  },
  template: '<div />',
})

let component: VueWrapper | null = null

afterEach(() => {
  component?.unmount()
  component = null
})

describe('useExecutionCanvas', () => {
  it('hands the provided context to descendant nodes', () => {
    const selectNode = vi.fn()
    const context: ExecutionCanvasContext = {
      layoutDirection: shallowRef('left-to-right'),
      selectNode,
      toggleNode: vi.fn(),
    }
    const Canvas = defineComponent({
      components: { Probe },
      setup() {
        provideExecutionCanvas(context)
        return {}
      },
      template: '<Probe />',
    })

    component = mount(Canvas)
    const probe = component.findComponent(Probe)
    probe.vm.context.selectNode('agent-key')

    expect(probe.vm.context.layoutDirection.value).toBe('left-to-right')
    expect(selectNode).toHaveBeenCalledWith('agent-key')
  })

  it('throws when rendered outside a RunCanvas subtree', () => {
    expect(() => mount(Probe)).toThrowError(
      'ExecutionAgentNode must be rendered inside RunCanvas',
    )
  })
})
