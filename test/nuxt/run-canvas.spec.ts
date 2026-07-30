import { mountSuspended } from '@nuxt/test-utils/runtime'
import { describe, expect, it } from 'vitest'
import RunCanvas from '~/components/RunCanvas.client.vue'
import type { RunResponse, TimelineLane } from '#shared/types/run'

function lane(key: string, depth: number): TimelineLane {
  return {
    key,
    depth,
    label: key,
    agentType: depth === 2 ? 'Explore' : depth === 1 ? 'general-purpose' : '',
    kind: depth ? 'subagent' : 'session',
    firstTs: null,
    lastTs: null,
    live: false,
    errors: 0,
    tools: depth,
    spawnState: depth ? 'returned' : '',
    files: 0,
  }
}

const run = {
  key: 'root',
  lanes: [
    lane('root', 0),
    lane('outer', 1),
    lane('inner', 2),
  ],
} as RunResponse

describe('run canvas', () => {
  it('shows every nested agent by default', async () => {
    const component = await mountSuspended(RunCanvas, {
      props: {
        run,
        selectedKey: null,
      },
    })

    expect(component.find('.canvas-options').exists()).toBe(false)
    await component.get('button[aria-controls="canvas-display-options"]').trigger('click')

    const overview = component.get('button[title="Group nested agents into readable workstreams"]')
    const allAgents = component.get('button[title="Show every individual agent"]')

    expect(overview.attributes('aria-pressed')).toBe('false')
    expect(allAgents.attributes('aria-pressed')).toBe('true')
    expect(component.get('.canvas-title').text()).toContain('3 agents')
    expect(component.get('.canvas-title').text()).not.toContain('workstreams')
  })

  it('starts a dense nested run in expandable workstream overview', async () => {
    const denseRun = {
      key: 'root',
      lanes: [
        lane('root', 0),
        lane('outer', 1),
        ...Array.from({ length: 11 }, (_, index) => lane(`nested-${index}`, 2)),
      ],
    } as RunResponse
    const component = await mountSuspended(RunCanvas, {
      props: {
        run: denseRun,
        selectedKey: null,
      },
    })

    await component.get('button[aria-controls="canvas-display-options"]').trigger('click')

    expect(component.get('button[title="Group nested agents into readable workstreams"]')
      .attributes('aria-pressed')).toBe('true')
    expect(component.get('button[title="Show every individual agent"]')
      .attributes('aria-pressed')).toBe('false')
    expect(component.get('.canvas-title').text()).toContain('13 agents · 2 visible')
  })
})
