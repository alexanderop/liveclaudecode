import { mountSuspended } from '@nuxt/test-utils/runtime'
import { describe, expect, it } from 'vitest'
import RunHero from '~/components/RunHero.vue'
import { runNode } from '../fixtures/runs'

describe('RunHero', () => {
  it('keeps search, session status, and color mode in the compact global header', async () => {
    const component = await mountSuspended(RunHero, {
      props: {
        root: null,
        sidebarVisible: true,
        followActive: true,
      },
    })

    expect(component.get('[aria-label="Color mode"]').attributes('aria-label')).toBe('Color mode')
    expect(component.get('.header-session-status').text()).toContain('No session')
    expect(component.get('.dashboard-search-button').text()).toContain('Search')
  })

  it('offers a compact restore control when the sidebar is hidden', async () => {
    const component = await mountSuspended(RunHero, {
      props: {
        root: null,
        sidebarVisible: false,
        followActive: true,
      },
    })
    const showSidebar = component.get('button[aria-label="Show session browser"]')

    expect(showSidebar.attributes('aria-keyshortcuts')).toBe('Meta+B Control+B')
    expect(component.get('.breadcrumbs').text()).toContain('Local sessions')
    await showSidebar.trigger('click')
    expect(component.emitted('showSidebar')).toEqual([[]])
  })

  it('shows the selected provider, session, and concise status', async () => {
    const root = runNode({ finalText: 'The requested audit is complete.', errors: 2, subErrors: 2 })
    const component = await mountSuspended(RunHero, {
      props: {
        root,
        sidebarVisible: true,
        followActive: false,
      },
    })

    expect(component.get('.breadcrumbs').text()).toContain('Claude')
    expect(component.get('.breadcrumbs').text()).toContain('Ship the dashboard')
    expect(component.get('.header-session-status').text()).toContain('Warnings')
  })

  it('shows Follow active only in monitoring workspaces', async () => {
    const root = runNode()
    const component = await mountSuspended(RunHero, {
      props: {
        root,
        sidebarVisible: true,
        followActive: false,
        workspace: 'changes',
      },
    })

    expect(component.find('.follow-active').exists()).toBe(false)
    await component.setProps({ workspace: 'activity' })
    expect(component.get('.follow-active').text()).toContain('Follow active')
  })
})
