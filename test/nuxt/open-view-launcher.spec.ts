import { mountSuspended } from '@nuxt/test-utils/runtime'
import { describe, expect, it } from 'vitest'
import OpenViewLauncher from '~/components/OpenViewLauncher.vue'

describe('OpenViewLauncher', () => {
  it('renders persistent session navigation with useful destination counts', async () => {
    const component = await mountSuspended(OpenViewLauncher, {
      props: {
        current: 'activity',
        agentCount: 3,
        activityCount: 18,
        changeCount: 2,
        attentionCount: 1,
        askActive: false,
      },
    })

    expect(component.get('nav').attributes('aria-label')).toBe('Session views')
    expect(component.findAll('.session-view-tabs button')).toHaveLength(5)
    expect(component.get('[data-destination="activity"]').attributes('aria-current')).toBe('page')
    expect(component.get('[data-destination="map"] .session-view-count').text()).toBe('3')
    expect(component.get('[data-destination="changes"] .session-view-count').text()).toBe('2')
    expect(component.get('[data-destination="diagnostics"] .session-view-count').text()).toBe('1')

    await component.get('[data-destination="changes"]').trigger('click')
    expect(component.emitted('select')).toEqual([['changes']])
  })

  it('keeps Ask separate from inspection views and exposes its active state', async () => {
    const component = await mountSuspended(OpenViewLauncher, {
      props: {
        current: 'overview',
        agentCount: 1,
        activityCount: 9,
        changeCount: 0,
        attentionCount: 0,
        askActive: true,
      },
    })

    expect(component.get('.session-ask-action').attributes('aria-pressed')).toBe('true')
    expect(component.get('.session-ask-indicator').attributes('aria-label')).toBe('Ask conversation active')

    await component.get('.session-ask-action').trigger('click')
    expect(component.emitted('select')).toEqual([['ask']])
  })
})
