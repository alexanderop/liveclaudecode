import type { VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import IndexPage from '~/pages/index.vue'
import { mountWithAtoms, type MountedAtoms } from '../fixtures/mount-atoms'
import { runNode, treeResponse } from '../fixtures/runs'
import { servingTree } from '../fixtures/stub-api'

let mounted: MountedAtoms | null = null

afterEach(() => {
  mounted?.wrapper.unmount()
  mounted?.registry.dispose()
  mounted = null
})

describe('session view controls', () => {
  it('exposes and updates the selected event density', async () => {
    const root = runNode({ subErrors: 0, errors: 0 })
    mounted = await mountWithAtoms(IndexPage, {
      api: servingTree(treeResponse(root)),
      global: {
        stubs: {
          EventFeed: true,
          RunChanges: true,
          RunDiagnostics: true,
          RunHero: true,
          RunInspector: true,
          RunOverview: true,
          RunSidebar: true,
        },
      },
    })
    const wrapper = mounted.wrapper
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

describe('focus view', () => {
  async function mountDashboard(): Promise<VueWrapper> {
    const root = runNode({ subErrors: 0, errors: 0 })
    mounted = await mountWithAtoms(IndexPage, {
      api: servingTree(treeResponse(root)),
      global: {
        stubs: {
          EventFeed: true,
          RunChanges: true,
          RunDiagnostics: true,
          RunHero: true,
          RunInspector: true,
          RunOverview: true,
          RunSidebar: true,
        },
      },
    })
    const wrapper = mounted.wrapper
    await vi.waitFor(() => expect(wrapper.get('[data-destination="activity"]').attributes('disabled')).toBeUndefined())
    return wrapper
  }

  function press(key: string): Promise<void> {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true }))
    return nextTick()
  }

  it('hides the browser and view tabs on F and restores them on Escape', async () => {
    const wrapper = await mountDashboard()

    await press('f')

    expect(wrapper.get('.shell').classes()).toContain('focus-mode')
    expect(wrapper.find('.session-view-tabs').exists()).toBe(false)
    expect(wrapper.get('.focus-exit').text()).toContain('Ship the dashboard')

    await press('Escape')

    expect(wrapper.get('.shell').classes()).not.toContain('focus-mode')
    expect(wrapper.find('.focus-exit').exists()).toBe(false)
    expect(wrapper.find('.session-view-tabs').exists()).toBe(true)
  })

  it('leaves focus view with the exit control', async () => {
    const wrapper = await mountDashboard()
    await press('f')

    await wrapper.get('button[aria-label="Exit focus view"]').trigger('click')

    expect(wrapper.get('.shell').classes()).not.toContain('focus-mode')
  })

  it('ignores F while typing so session filters keep working', async () => {
    const wrapper = await mountDashboard()
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true, cancelable: true }))
    await nextTick()
    input.remove()

    expect(wrapper.get('.shell').classes()).not.toContain('focus-mode')
  })
})
