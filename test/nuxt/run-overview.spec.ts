import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import RunOverview from '~/components/RunOverview.vue'
import { runResponse } from '../fixtures/runs'

let component: VueWrapper | null = null

afterEach(() => {
  component?.unmount()
  component = null
})

describe('RunOverview', () => {
  it('renders a task-led Overview with clickable metrics, agents, and technical details', async () => {
    const run = runResponse()
    const wrapper = component = await mountSuspended(RunOverview, {
      props: { run, selectedKey: run.key },
    })

    expect(wrapper.get('[data-workspace-heading]').text()).toBe('Ship the dashboard')
    expect(wrapper.get('.overview-status-pill').text()).toBe('Completed with warnings')
    expect(wrapper.get('.overview-outcome').text()).toContain('The dashboard is ready for review.')
    expect(wrapper.findAll('.overview-metrics button')).toHaveLength(5)
    expect(wrapper.get('.overview-metrics').text()).toContain('$0.01Estimated cost')
    expect(wrapper.get('.overview-agent-row').text()).toContain('Main session')
    expect(wrapper.findAll('.overview-actions button')).toHaveLength(2)
    expect(wrapper.get('.run-details').attributes('open')).toBeUndefined()
    expect(wrapper.get('.run-details-content').text()).toContain('Output tokens')
    expect(wrapper.get('.run-details-content').text()).toContain(run.transcriptPath)

    await wrapper.findAll('.overview-metrics button')[1]!.trigger('click')
    expect(wrapper.emitted('open')).toEqual([['activity']])
  })
})
