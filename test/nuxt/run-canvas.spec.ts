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

    const overview = component.get('button[title="Group nested agents into readable workstreams"]')
    const allAgents = component.get('button[title="Show every individual agent"]')

    expect(overview.attributes('aria-pressed')).toBe('false')
    expect(allAgents.attributes('aria-pressed')).toBe('true')
    expect(component.get('.canvas-title').text()).toContain('3 agents')
    expect(component.get('.canvas-title').text()).not.toContain('workstreams')
  })
})
