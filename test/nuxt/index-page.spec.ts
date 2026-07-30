import { mountSuspended } from '@nuxt/test-utils/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import IndexPage from '~/pages/index.vue'
import { runNode, runResponse } from '../fixtures/runs'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('session view controls', () => {
  it('exposes and updates the selected event density', async () => {
    const root = runNode({ subErrors: 0, errors: 0 })
    vi.stubGlobal('$fetch', vi.fn(async (url: string) => {
      if (url === '/api/tree') return { projects: [{ id: '/repo', name: 'repo', roots: [root] }], sources: [], now: 0, hours: 168 }
      if (url.startsWith('/api/run')) return runResponse({ root, node: root })
      if (url.startsWith('/api/session-events')) return { key: root.key, events: [], total: 0, truncated: false }
      return { key: root.key, events: [], next: 0, revision: 1, reset: false, node: root }
    }))
    const component = await mountSuspended(IndexPage, {
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
    await vi.waitFor(() => expect(component.get('[data-destination="activity"]').attributes('disabled')).toBeUndefined())
    await component.get('[data-destination="activity"]').trigger('click')
    const density = component.get('[role="group"][aria-label="Event detail"]')
    const buttons = density.findAll('button')

    expect(buttons.map(button => button.attributes('aria-pressed'))).toEqual([
      'false',
      'true',
      'false',
    ])

    await buttons[0]!.trigger('click')

    expect(buttons.map(button => button.attributes('aria-pressed'))).toEqual([
      'true',
      'false',
      'false',
    ])
  })
})
