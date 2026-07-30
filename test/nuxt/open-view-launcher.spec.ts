import { mountSuspended } from '@nuxt/test-utils/runtime'
import { describe, expect, it } from 'vitest'
import OpenViewLauncher from '~/components/OpenViewLauncher.vue'

describe('OpenViewLauncher', () => {
  it('uses the accessible menu pattern and scopes destination mnemonics to the launcher', async () => {
    const component = await mountSuspended(OpenViewLauncher, {
      props: {
        state: { kind: 'compact' },
        current: 'activity',
        attentionCount: 2,
        askActive: false,
      },
      attachTo: document.body,
    })

    const trigger = component.get('.open-view-trigger')
    expect(trigger.attributes()).toMatchObject({
      'aria-haspopup': 'menu',
      'aria-expanded': 'true',
      'aria-controls': 'open-view-menu',
    })
    expect(component.get('[role="menu"]').attributes('aria-label')).toBe('Open a session view')
    expect(component.get('[data-destination="activity"]').attributes('aria-current')).toBe('page')
    expect(component.get('[data-destination="diagnostics"] .launcher-attention').text()).toBe('2')

    await component.get('[role="menu"]').trigger('keydown', { key: 'd' })
    expect(component.emitted('select')).toEqual([['changes']])

    component.unmount()
  })

  it('renders expanded mode as workspace navigation rather than a modal', async () => {
    const component = await mountSuspended(OpenViewLauncher, {
      props: {
        state: {
          kind: 'expanded',
          previousWorkspace: 'map',
          suspendedContext: { kind: 'closed' },
        },
        current: 'map',
        attentionCount: 0,
        askActive: true,
      },
    })

    expect(component.get('nav').attributes('aria-labelledby')).toBe('open-view-heading')
    expect(component.find('[role="dialog"]').exists()).toBe(false)
    expect(component.find('[aria-modal]').exists()).toBe(false)
    expect(component.findAll('.expanded-launcher-list button')).toHaveLength(6)
    expect(component.get('[data-destination="ask"]').text()).toContain('Active')

    await component.get('.launcher-back').trigger('click')
    expect(component.emitted('back')).toEqual([[]])
  })
})
