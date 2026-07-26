import { mountSuspended } from '@nuxt/test-utils/runtime'
import { describe, expect, it } from 'vitest'
import RunHero from '~/components/RunHero.vue'

describe('RunHero', () => {
  it('offers a compact restore control when the sidebar is hidden', async () => {
    const component = await mountSuspended(RunHero, {
      props: {
        root: null,
        selected: null,
        fileCount: 0,
        sidebarVisible: false,
        followActive: true,
      },
    })
    const showSidebar = component.get('button[aria-label="Show sidebar"]')

    expect(showSidebar.attributes('aria-keyshortcuts')).toBe('Meta+B Control+B')
    await showSidebar.trigger('click')
    expect(component.emitted('showSidebar')).toEqual([[]])
  })
})
