import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import ActiveAgentsOverview from '~/components/ActiveAgentsOverview.vue'
import { runNode } from '../fixtures/runs'

let component: VueWrapper | null = null

afterEach(() => {
  component?.unmount()
  component = null
})

describe('ActiveAgentsOverview', () => {
  it('shows every active agent across projects and opens the selected agent', async () => {
    const exploring = runNode({
      key: 'exploring',
      sid: 'first',
      kind: 'subagent',
      label: 'Explore the dashboard',
      agentType: 'Explore',
      live: true,
      spawnState: 'running',
      current: { tool: 'Read', summary: 'Inspecting the agent components', ts: '2026-07-25T18:03:00.000Z' },
      children: [],
    })
    const waiting = runNode({
      key: 'waiting',
      sid: 'first',
      kind: 'subagent',
      label: 'Review the tests',
      agentType: 'Review',
      live: false,
      spawnState: 'running',
      current: null,
      children: [],
    })
    const first = runNode({
      key: 'first',
      sid: 'first',
      label: 'Improve the agent overview',
      live: false,
      spawnState: 'returned',
      children: [exploring, waiting],
    })
    const second = runNode({
      source: 'codex',
      sourceDetail: 'Codex',
      key: 'second',
      sid: 'second',
      label: 'Polish the mobile layout',
      live: true,
      spawnState: 'running',
      current: null,
      children: [],
    })
    const wrapper = component = await mountSuspended(ActiveAgentsOverview, {
      props: {
        projects: [
          { id: '/dashboard', name: 'liveclaudecode', roots: [first] },
          { id: '/mobile', name: 'mobile-app', roots: [second] },
        ],
      },
    })

    expect(wrapper.get('.active-agents-total').text()).toBe('3')
    expect(wrapper.get('.active-agents-header').text()).toContain('2 active sessions across 2 projects')
    const cards = wrapper.findAll('.active-agent-card')
    expect(cards).toHaveLength(3)
    expect(cards[0]!.text()).toContain('Explore the dashboard')
    expect(cards[0]!.get('.active-agent-current').text()).toContain('Inspecting the agent components')
    expect(cards.map(card => card.get('.active-agent-project').text()))
      .toContainEqual(expect.stringContaining('mobile-app'))

    await cards[0]!.trigger('click')
    expect(wrapper.emitted('select')).toEqual([['/dashboard', 'exploring']])
  })
})
