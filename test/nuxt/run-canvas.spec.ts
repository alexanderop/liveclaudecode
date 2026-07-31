import { mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VueFlow } from '@vue-flow/core'
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

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

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

  it('assigns a distinct Vue Flow store id to every canvas instance', async () => {
    const component = await mountSuspended(defineComponent({
      components: { RunCanvas },
      setup: () => ({ run }),
      template: `
        <RunCanvas :run="run" :selected-key="null" />
        <RunCanvas :run="run" :selected-key="null" />
      `,
    }))

    const ids = component.findAllComponents(RunCanvas)
      .map(canvas => (canvas.vm as unknown as { canvasId: string }).canvasId)
    const renderedIds = component.findAllComponents(VueFlow)
      .map(flow => flow.props('id'))
    const storeIds = component.findAll('.canvas-view')
      .map(canvas => canvas.attributes('data-flow-store-id'))

    expect(ids).toHaveLength(2)
    expect(ids[0]).toMatch(/^execution-canvas-/)
    expect(ids[1]).toMatch(/^execution-canvas-/)
    expect(ids[0]).not.toBe(ids[1])
    expect(renderedIds).toEqual(ids)
    expect(storeIds).toEqual(ids)
  })

  it('keeps a single visibility listener across KeepAlive deactivation and removes it on unmount', async () => {
    const addListener = vi.spyOn(document, 'addEventListener')
    const removeListener = vi.spyOn(document, 'removeEventListener')
    const component = await mountSuspended(defineComponent({
      components: { RunCanvas },
      data: () => ({ run, visible: true }),
      template: `
        <button type="button" @click="visible = !visible">Toggle canvas</button>
        <KeepAlive>
          <RunCanvas v-if="visible" :run="run" :selected-key="null" />
        </KeepAlive>
      `,
    }))
    const visibilityAdds = () => addListener.mock.calls
      .filter(([event]) => event === 'visibilitychange')
    const visibilityRemoves = () => removeListener.mock.calls
      .filter(([event]) => event === 'visibilitychange')
    const initialAdds = visibilityAdds()
    expect(initialAdds).toHaveLength(1)
    const handler = initialAdds[0]![1]

    await component.get('button').trigger('click')
    await nextTick()
    await component.get('button').trigger('click')
    await nextTick()
    expect(visibilityAdds()).toHaveLength(1)
    expect(visibilityRemoves()).toHaveLength(0)

    component.unmount()
    expect(visibilityRemoves()).toHaveLength(1)
    expect(visibilityRemoves()[0]![1]).toBe(handler)
  })

  it('stops replay and minimap timers while a cached canvas is deactivated', async () => {
    vi.useFakeTimers()
    const replayRun = {
      ...run,
      diagnostics: { changes: [], incidents: [] },
      lanes: run.lanes.map((item, index) => ({
        ...item,
        firstTs: `2026-07-31T08:0${index}:00.000Z`,
        lastTs: `2026-07-31T08:0${index}:30.000Z`,
      })),
      phases: [],
    } as unknown as RunResponse
    const component = await mountSuspended(defineComponent({
      components: { RunCanvas },
      data: () => ({ focusUpdates: 0, replayRun, visible: true }),
      template: `
        <button class="toggle-canvas" type="button" @click="visible = !visible">Toggle canvas</button>
        <KeepAlive>
          <RunCanvas
            v-if="visible"
            :run="replayRun"
            :selected-key="null"
            @focus-time="focusUpdates += 1"
          />
        </KeepAlive>
      `,
    }))
    const canvas = component.findComponent(RunCanvas)
    const canvasState = canvas.vm as unknown as {
      minimapVisible: boolean
      playing: boolean
    }

    await canvas.get('button[aria-label="Play replay"]').trigger('click')
    canvas.findComponent(VueFlow).vm.$emit('viewport-change-start')
    canvas.findComponent(VueFlow).vm.$emit('viewport-change-end')
    await nextTick()

    expect(canvasState.playing).toBe(true)
    expect(canvasState.minimapVisible).toBe(true)
    const updatesBeforeDeactivation = component.vm.focusUpdates

    await component.get('.toggle-canvas').trigger('click')
    await nextTick()
    expect(canvasState.playing).toBe(false)
    expect(canvasState.minimapVisible).toBe(false)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(component.vm.focusUpdates).toBe(updatesBeforeDeactivation)
    expect(canvasState.minimapVisible).toBe(false)
  })
})
