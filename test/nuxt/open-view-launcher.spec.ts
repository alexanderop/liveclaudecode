import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import OpenViewLauncher from '~/components/OpenViewLauncher.vue'

let component: VueWrapper | null = null

afterEach(() => {
  component?.unmount()
  component = null
})

describe('OpenViewLauncher', () => {
  it('renders persistent session navigation with useful destination counts', async () => {
    const wrapper = component = await mountSuspended(OpenViewLauncher, {
      props: {
        current: 'activity',
        agentCount: 3,
        activityCount: 18,
        changeCount: 2,
        attentionCount: 1,
        askActive: false,
      },
    })

    expect(wrapper.get('nav').attributes('aria-label')).toBe('Session views')
    expect(wrapper.findAll('.session-view-tabs button')).toHaveLength(5)
    expect(wrapper.get('[data-destination="activity"]').attributes('aria-current')).toBe('page')
    expect(wrapper.get('[data-destination="map"] .session-view-count').text()).toBe('3')
    expect(wrapper.get('[data-destination="changes"] .session-view-count').text()).toBe('2')
    expect(wrapper.get('[data-destination="diagnostics"] .session-view-count').text()).toBe('1')

    await wrapper.get('[data-destination="changes"]').trigger('click')
    expect(wrapper.emitted('select')).toEqual([['changes']])
  })

  it('keeps Ask separate from inspection views and exposes its active state', async () => {
    const wrapper = component = await mountSuspended(OpenViewLauncher, {
      props: {
        current: 'overview',
        agentCount: 1,
        activityCount: 9,
        changeCount: 0,
        attentionCount: 0,
        askActive: true,
      },
    })

    expect(wrapper.get('.session-ask-action').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('.session-ask-indicator').attributes('aria-label')).toBe('Ask conversation active')

    await wrapper.get('.session-ask-action').trigger('click')
    expect(wrapper.emitted('select')).toEqual([['ask']])
  })
})
