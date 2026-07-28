import { mountSuspended } from '@nuxt/test-utils/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import IndexPage from '~/pages/index.vue'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('session view controls', () => {
  it('exposes and updates the selected event density', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({
      projects: [],
      sources: [],
      now: 0,
    }))
    const component = await mountSuspended(IndexPage, {
      global: {
        stubs: {
          EventFeed: true,
          RunCanvas: true,
          RunChanges: true,
          RunDiagnostics: true,
          RunHero: true,
          RunInspector: true,
          RunOverview: true,
          RunSidebar: true,
        },
      },
    })
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
