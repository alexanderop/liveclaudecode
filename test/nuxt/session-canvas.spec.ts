import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import IndexPage from '~/pages/index.vue'
import type { RunNode, RunResponse } from '#shared/types/run'

afterEach(() => {
  window.localStorage.clear()
  vi.unstubAllGlobals()
})

const root = {
  key: 'root',
  label: 'Canvas session',
  agentType: '',
  source: 'claude',
  sourceDetail: 'Claude Code',
  kind: 'session',
  children: [],
  records: 4,
  subLive: false,
  subErrors: 0,
  live: false,
  mtime: 1,
  subLast: '2026-07-28T10:02:00.000Z',
} as unknown as RunNode

const child = {
  ...root,
  key: 'review',
  label: 'Review agent',
  agentType: 'reviewer',
  kind: 'subagent',
  children: [],
  spawnDepth: 1,
} as RunNode

root.children = [child]

const run = {
  key: root.key,
  lanes: [
    {
      key: root.key,
      label: root.label,
      agentType: '',
      kind: 'session',
      depth: 0,
      firstTs: null,
      lastTs: null,
      live: false,
      errors: 0,
      tools: 1,
      spawnState: '',
      files: 0,
    },
    {
      key: child.key,
      label: child.label,
      agentType: child.agentType,
      kind: 'subagent',
      depth: 1,
      firstTs: null,
      lastTs: null,
      live: false,
      errors: 0,
      tools: 2,
      spawnState: 'returned',
      files: 0,
    },
  ],
  files: [],
  phases: [],
  node: root,
  root,
  diagnostics: {
    incidents: [],
    turns: [],
    compactions: [],
    outcomes: [],
    changes: [],
    git: [],
    agents: [],
    environment: {},
    causal: {},
    usage: {},
  },
} as unknown as RunResponse

const CanvasStub = defineComponent({
  props: ['run', 'selectedKey'],
  emits: ['select', 'deselect'],
  template: `
    <div class="canvas-stub" :data-selected="selectedKey || ''">
      <slot name="actions" />
      <button class="canvas-node" type="button" @click="$emit('select', 'review')">Review</button>
      <button class="canvas-empty" type="button" @click="$emit('deselect')">Empty space</button>
    </div>
  `,
})

const InspectorStub = defineComponent({
  props: ['selected', 'selectedKey', 'events', 'eventsLoading'],
  emits: ['select', 'close'],
  template: `
    <aside
      class="inspector-stub"
      :data-selected="selectedKey"
      :data-event-count="events.length"
      :data-events-loading="String(eventsLoading)"
    >
      {{ selected?.label }}
      <button class="close-inspector" type="button" @click="$emit('close')">Close</button>
    </aside>
  `,
})

describe('persistent session canvas', () => {
  it('resizes and remembers both docked sidebars', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({
      projects: [],
      sources: [],
      now: 0,
    }))
    const component = await mountSuspended(IndexPage, {
      global: {
        stubs: {
          EventFeed: true,
          RunCanvas: CanvasStub,
          RunChanges: true,
          RunDiagnostics: true,
          RunHero: true,
          RunInspector: InspectorStub,
          RunOverview: true,
          RunSidebar: true,
        },
      },
    })

    const sidebarHandle = component.get('button[aria-label="Resize session browser"]')
    expect(sidebarHandle.attributes('aria-valuenow')).toBe('272')

    await sidebarHandle.trigger('pointerdown', { button: 0, clientX: 272 })
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 332 }))
    window.dispatchEvent(new PointerEvent('pointerup'))
    await nextTick()

    expect(sidebarHandle.attributes('aria-valuenow')).toBe('332')
    expect(window.localStorage.getItem('liveclaudecode:sidebar-width')).toBe('332')

    await sidebarHandle.trigger('dblclick')
    await component.get('.view-actions button[aria-pressed]').trigger('click')
    const panelHandle = component.get('button[aria-label="Resize details panel"]')
    expect(panelHandle.attributes('aria-valuenow')).toBe('380')

    await panelHandle.trigger('keydown', { key: 'ArrowLeft' })
    expect(panelHandle.attributes('aria-valuenow')).toBe('392')
    expect(window.localStorage.getItem('liveclaudecode:panel-width')).toBe('392')

    await panelHandle.trigger('dblclick')
    expect(panelHandle.attributes('aria-valuenow')).toBe('380')
  })

  it('keeps the canvas mounted while node details open and empty space closes them', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url === '/api/tree') {
        return {
          projects: [{ id: '/workspace', name: 'workspace', roots: [root] }],
          sources: [],
          now: 0,
        }
      }
      if (url.startsWith('/api/run')) return run
      if (url.includes('key=review')) {
        return {
          key: child.key,
          events: [{
            role: 'assistant',
            kind: 'text',
            ts: '2026-07-28T10:01:00.000Z',
            line: 1,
            body: 'Reviewing the requested flow.',
          }],
          next: 1,
          revision: 1,
          reset: false,
          node: child,
        }
      }
      return {
        key: root.key,
        events: [],
        next: 0,
        revision: 1,
        reset: false,
        node: root,
      }
    })
    vi.stubGlobal('$fetch', fetch)

    const component = await mountSuspended(IndexPage, {
      global: {
        stubs: {
          EventFeed: true,
          RunCanvas: CanvasStub,
          RunChanges: true,
          RunDiagnostics: true,
          RunHero: true,
          RunInspector: InspectorStub,
          RunOverview: true,
          RunSidebar: true,
        },
      },
    })
    await flushPromises()

    const originalCanvas = component.get('.canvas-stub').element
    await component.get('.canvas-node').trigger('click')

    expect(component.get('.inspector-stub').attributes('data-selected')).toBe('review')
    expect(component.get('.inspector-stub').text()).toContain('Review agent')
    expect(component.get('.inspector-stub').attributes('data-event-count')).toBe('1')
    expect(component.get('.inspector-stub').attributes('data-events-loading')).toBe('false')
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('key=review'))
    expect(component.get('.canvas-stub').element).toBe(originalCanvas)

    await component.get('.canvas-empty').trigger('click')

    expect(component.find('.inspector-stub').exists()).toBe(false)
    expect(component.get('.canvas-stub').element).toBe(originalCanvas)
    expect(component.get('.canvas-stub').attributes('data-selected')).toBe('')
  })

  it('opens supporting views alongside the same canvas', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({
      projects: [],
      sources: [],
      now: 0,
    }))
    const component = await mountSuspended(IndexPage, {
      global: {
        stubs: {
          EventFeed: true,
          RunCanvas: CanvasStub,
          RunChanges: true,
          RunDiagnostics: true,
          RunHero: true,
          RunInspector: InspectorStub,
          RunOverview: true,
          RunSidebar: true,
        },
      },
    })
    const originalCanvas = component.get('.canvas-stub').element

    await component.get('.view-actions button[aria-pressed]').trigger('click')

    expect(component.get('.session-panel').attributes('aria-label')).toBe('Activity panel')
    expect(component.get('.canvas-stub').element).toBe(originalCanvas)
  })
})
