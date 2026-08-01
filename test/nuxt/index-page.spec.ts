import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import IndexPage from '~/pages/index.vue'
import { mockLiveApi } from '../fixtures/live-api'
import { runNode } from '../fixtures/runs'

let component: VueWrapper | null = null

afterEach(() => {
  component?.unmount()
  component = null
})

describe('session view controls', () => {
  it('exposes and updates the selected event density', async () => {
    const root = runNode({ subErrors: 0, errors: 0 })
    mockLiveApi(root)
    const wrapper = component = await mountSuspended(IndexPage, {
      global: {
        stubs: {
          EventFeed: true,
          RunCanvas: { template: '<div><slot name="actions" /></div>' },
          RunChanges: true,
          RunDiagnostics: true,
          RunHero: true,
          RunInspector: true,
          RunOverview: true,
          RunSidebar: true,
        },
      },
    })
    await vi.waitFor(() => expect(wrapper.get('[data-destination="activity"]').attributes('disabled')).toBeUndefined())
    await wrapper.get('[data-destination="activity"]').trigger('click')
    const density = wrapper.get('[role="group"][aria-label="Event detail"]')
    const buttons = density.findAll('button')

    expect(buttons.map(button => button.attributes('aria-pressed'))).toEqual([
      'false',
      'true',
      'false',
    ])
    expect(wrapper.findComponent({ name: 'EventFeed' }).props('density')).toBe('normal')

    await buttons[0]!.trigger('click')

    expect(buttons.map(button => button.attributes('aria-pressed'))).toEqual([
      'true',
      'false',
      'false',
    ])
    expect(wrapper.findComponent({ name: 'EventFeed' }).props('density')).toBe('compact')
  })
})
