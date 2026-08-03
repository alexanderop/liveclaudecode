import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import RunOverview from '~/components/RunOverview.vue'
import { runNode, runResponse } from '../fixtures/runs'

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

  it('heads the session with its recorded title and keeps the opening prompt below', async () => {
    const root = runNode({
      label: 'Highlight transcript code with Shiki',
      title: 'Highlight transcript code with Shiki',
      openingPrompt: 'can we make the code blocks look nicer',
    })
    const wrapper = component = await mountSuspended(RunOverview, {
      props: { root, run: runResponse(), selectedKey: root.key },
    })

    expect(wrapper.get('[data-workspace-heading]').text()).toBe('Highlight transcript code with Shiki')
    expect(wrapper.get('.overview-opening').text()).toContain('can we make the code blocks look nicer')
  })

  it('does not repeat the opening prompt when it is already the heading', async () => {
    const wrapper = component = await mountSuspended(RunOverview, {
      props: { run: runResponse(), selectedKey: 'session' },
    })

    expect(wrapper.find('.overview-opening').exists()).toBe(false)
  })

  it('flags a permission mode that skipped review', async () => {
    const run = runResponse()
    run.diagnostics.environment = {
      ...run.diagnostics.environment,
      mode: 'plan',
      permissionMode: 'bypassPermissions',
    }
    const wrapper = component = await mountSuspended(RunOverview, {
      props: { run, selectedKey: run.key },
    })

    const chips = wrapper.findAll('.overview-mode-chip')
    expect(chips.map(chip => chip.text())).toEqual(['plan', 'bypassPermissions'])
    expect(chips[0]!.classes()).not.toContain('risky')
    expect(chips[1]!.classes()).toContain('risky')
  })
})
