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

  it('names the cause of skipped records and links to the debug page', async () => {
    const run = runResponse()
    run.diagnostics.parse = {
      skipped: 12,
      counts: { invalidJson: 0, schemaMismatch: 11, unsupportedShape: 1 },
    }
    const wrapper = component = await mountSuspended(RunOverview, {
      props: { run, selectedKey: run.key },
    })

    const attention = wrapper.get('.overview-attention')
    expect(attention.text()).toContain('12 records in this session could not be parsed')
    // The fix is ours, not the user's, so the wording must say so.
    expect(attention.text()).toContain('shape liveclaudecode does not model')
    expect(attention.attributes('href')).toBe('/debug')
  })

  it('distinguishes unreadable lines from shapes it cannot model', async () => {
    const run = runResponse()
    run.diagnostics.parse = {
      skipped: 3,
      counts: { invalidJson: 3, schemaMismatch: 0, unsupportedShape: 0 },
    }
    const wrapper = component = await mountSuspended(RunOverview, {
      props: { run, selectedKey: run.key },
    })

    expect(wrapper.get('.overview-attention').text()).toContain('were not valid JSON')
  })

  it('reports an unreadable source instead of a per-session parse count', async () => {
    const run = runResponse()
    const wrapper = component = await mountSuspended(RunOverview, {
      props: {
        run,
        selectedKey: run.key,
        sourceUnavailable: true,
        sourceMessage: 'Storage unavailable: SystemError',
      },
    })

    const attention = wrapper.get('.overview-attention')
    expect(attention.text()).toContain('could not be read')
    expect(attention.text()).toContain('Storage unavailable: SystemError')
    expect(attention.attributes('href')).toBeUndefined()
  })
})
