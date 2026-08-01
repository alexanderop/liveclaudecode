import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import RunHero from '~/components/RunHero.vue'
import { runNode } from '../fixtures/runs'

let component: VueWrapper | null = null

afterEach(() => {
  component?.unmount()
  component = null
})

describe('RunHero', () => {
  it('keeps search, session status, and color mode in the compact global header', async () => {
    const wrapper = component = await mountSuspended(RunHero, {
      props: {
        root: null,
        sidebarVisible: true,
        followActive: true,
      },
    })

    expect(wrapper.get('[aria-label="Color mode"]').attributes('aria-label')).toBe('Color mode')
    expect(wrapper.get('.header-session-status').text()).toContain('No session')
    expect(wrapper.get('.dashboard-search-button').text()).toContain('Search')
  })

  it('offers a compact restore control when the sidebar is hidden', async () => {
    const wrapper = component = await mountSuspended(RunHero, {
      props: {
        root: null,
        sidebarVisible: false,
        followActive: true,
      },
    })
    const showSidebar = wrapper.get('button[aria-label="Show session browser"]')

    expect(showSidebar.attributes('aria-keyshortcuts')).toBe('Meta+B Control+B')
    expect(wrapper.get('.breadcrumbs').text()).toContain('Local sessions')
    await showSidebar.trigger('click')
    expect(wrapper.emitted('showSidebar')).toEqual([[]])
  })

  it('shows the selected provider, session, and concise status', async () => {
    const root = runNode({ finalText: 'The requested audit is complete.', errors: 2, subErrors: 2 })
    const wrapper = component = await mountSuspended(RunHero, {
      props: {
        root,
        sidebarVisible: true,
        followActive: false,
      },
    })

    expect(wrapper.get('.breadcrumbs').text()).toContain('Claude')
    expect(wrapper.get('.breadcrumbs').text()).toContain('Ship the dashboard')
    expect(wrapper.get('.header-session-status').text()).toContain('Warnings')
  })

  it('shows Follow active only in monitoring workspaces', async () => {
    const root = runNode()
    const wrapper = component = await mountSuspended(RunHero, {
      props: {
        root,
        sidebarVisible: true,
        followActive: false,
        workspace: 'changes',
      },
    })

    expect(wrapper.find('.follow-active').exists()).toBe(false)
    await wrapper.setProps({ workspace: 'activity' })
    expect(wrapper.get('.follow-active').text()).toContain('Follow active')
  })
})
