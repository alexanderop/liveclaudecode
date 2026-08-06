import { mockComponent } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import IndexPage from '~/pages/index.vue'
import { mockLiveApi, urlParam } from '../fixtures/live-api'
import { mountWithAtoms, type MountedAtoms } from '../fixtures/mount-atoms'
import { eventsResponse, runNode, runResponse, timelineLane, treeResponse } from '../fixtures/runs'
import { servingTree } from '../fixtures/stub-api'

// The page mounts the canvas lazily, and a `stubs` entry cannot intercept an
// async component by name — it has no name until its module resolves. Replacing
// the module itself is what stands in for the real Vue Flow canvas here.
mockComponent('RunCanvas', {
  name: 'RunCanvasStub',
  props: ['run', 'selectedKey'],
  emits: ['select', 'deselect'],
  template: `
    <div class="canvas-stub">
      <slot name="actions" />
      <button class="canvas-node" type="button" @click="$emit('select', 'review')">Review</button>
      <button class="canvas-empty" type="button" @click="$emit('deselect')">Empty space</button>
    </div>
  `,
})

let mounted: MountedAtoms | null = null

afterEach(() => {
  mounted?.wrapper.unmount()
  mounted?.registry.dispose()
  mounted = null
  window.localStorage.clear()
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 })
})

function canvasFixtures() {
  const child = runNode({
    key: 'review',
    label: 'Review agent',
    agentType: 'reviewer',
    kind: 'subagent',
    spawnDepth: 1,
    errors: 0,
    subErrors: 0,
    mtime: 1,
    subLast: '2026-07-28T10:02:00.000Z',
  })
  const root = runNode({
    key: 'root',
    label: 'Canvas session',
    records: 4,
    errors: 0,
    subErrors: 0,
    mtime: 1,
    subLast: '2026-07-28T10:02:00.000Z',
    children: [child],
  })
  const run = runResponse({
    key: root.key,
    lanes: [
      timelineLane({
        key: root.key,
        label: root.label,
        kind: 'session',
        depth: 0,
        firstTs: null,
        lastTs: null,
        errors: 0,
        tools: 1,
        spawnState: '',
        files: 0,
      }),
      timelineLane({
        key: child.key,
        label: child.label,
        agentType: child.agentType,
        kind: 'subagent',
        depth: 1,
        firstTs: null,
        lastTs: null,
        errors: 0,
        tools: 2,
        files: 0,
      }),
    ],
    files: [],
    phases: [],
    node: root,
    root,
  })
  return { root, child, run }
}

function mockCanvasApi({ root, child, run }: ReturnType<typeof canvasFixtures>) {
  return mockLiveApi(root, {
    run: () => run,
    events: url => urlParam(url, 'key') === child.key
      ? eventsResponse(child.key, ['Reviewing the requested flow.'], { node: child })
      : eventsResponse(root.key, [], { node: root }),
  })
}

const InspectorStub = defineComponent({
  props: ['selected', 'selectedKey', 'events', 'eventsLoading'],
  emits: ['select', 'close'],
  template: `
    <aside class="inspector-stub">
      {{ selected?.label }}
      <button class="close-inspector" type="button" @click="$emit('close')">Close</button>
    </aside>
  `,
})

async function mountCanvasPage(root: ReturnType<typeof canvasFixtures>['root']) {
  mounted = await mountWithAtoms(IndexPage, {
    api: servingTree(treeResponse(root)),
    global: {
      stubs: {
        EventFeed: true,
        RunChanges: true,
        RunDiagnostics: true,
        RunHero: true,
        RunInspector: InspectorStub,
        RunOverview: true,
        RunSidebar: true,
      },
    },
  })
  return mounted.wrapper
}

// The canvas is mounted lazily, so it resolves a tick after the click that
// selects it.
async function openMap(wrapper: VueWrapper): Promise<void> {
  await vi.waitFor(() => expect(wrapper.get('[data-destination="map"]').attributes('disabled')).toBeUndefined())
  await wrapper.get('[data-destination="map"]').trigger('click')
  await vi.waitFor(() => expect(wrapper.find('.canvas-stub').exists()).toBe(true))
}

describe('persistent session canvas', () => {
  it('resizes and remembers both docked sidebars', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 })
    const fixtures = canvasFixtures()
    mockCanvasApi(fixtures)
    const wrapper = await mountCanvasPage(fixtures.root)

    const sidebarHandle = wrapper.get('button[aria-label="Resize session browser"]')
    expect(sidebarHandle.attributes('aria-valuenow')).toBe('272')

    await sidebarHandle.trigger('pointerdown', { button: 0, clientX: 272 })
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 332 }))
    window.dispatchEvent(new PointerEvent('pointerup'))
    await nextTick()

    expect(sidebarHandle.attributes('aria-valuenow')).toBe('332')
    expect(window.localStorage.getItem('liveclaudecode:sidebar-width')).toBe('332')

    await sidebarHandle.trigger('dblclick')
    await openMap(wrapper)
    await wrapper.get('.canvas-node').trigger('click')
    const panelHandle = wrapper.get('button[aria-label="Resize context panel"]')
    expect(panelHandle.attributes('aria-valuenow')).toBe('380')

    await panelHandle.trigger('keydown', { key: 'ArrowLeft' })
    expect(panelHandle.attributes('aria-valuenow')).toBe('392')
    expect(window.localStorage.getItem('liveclaudecode:panel-width')).toBe('392')

    await panelHandle.trigger('dblclick')
    expect(panelHandle.attributes('aria-valuenow')).toBe('380')
  })

  it('keeps the canvas mounted while node details open and empty space closes them', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 })
    const fixtures = canvasFixtures()
    const fetch = mockCanvasApi(fixtures)
    const wrapper = await mountCanvasPage(fixtures.root)
    await flushPromises()
    await openMap(wrapper)

    const originalCanvas = wrapper.get('.canvas-stub').element
    await wrapper.get('.canvas-node').trigger('click')
    await flushPromises()

    const inspector = wrapper.getComponent(InspectorStub)
    expect(inspector.props('selectedKey')).toBe('review')
    expect(inspector.props('selected')).toMatchObject({ label: 'Review agent' })
    expect(inspector.props('events')).toHaveLength(1)
    expect(inspector.props('eventsLoading')).toBe(false)
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('key=review'),
      { signal: expect.any(AbortSignal) },
    )
    expect(wrapper.get('.canvas-stub').element).toBe(originalCanvas)

    await wrapper.get('.canvas-empty').trigger('click')

    expect(wrapper.findComponent(InspectorStub).exists()).toBe(false)
    expect(wrapper.get('.canvas-stub').element).toBe(originalCanvas)
    expect(wrapper.getComponent({ name: 'RunCanvasStub' }).props('selectedKey')).toBeFalsy()
  })

  it('shows one primary workspace and restores the same canvas after an Activity round trip', async () => {
    const fixtures = canvasFixtures()
    mockCanvasApi(fixtures)
    const wrapper = await mountCanvasPage(fixtures.root)
    await openMap(wrapper)
    const originalCanvas = wrapper.get('.canvas-stub').element

    await wrapper.get('[data-destination="activity"]').trigger('click')

    expect(wrapper.get('[data-workspace-heading]').text()).toBe('Activity')
    expect(wrapper.find('.canvas-stub').exists()).toBe(false)

    await wrapper.get('[data-destination="map"]').trigger('click')

    expect(wrapper.get('.canvas-stub').element).toBe(originalCanvas)
  })
})
