import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import IndexPage from '~/pages/index.vue'
import type { RunNode, RunResponse } from '#shared/types/run'

afterEach(() => {
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
      <button class="canvas-node" type="button" @click="$emit('select', 'review')">Review</button>
      <button class="canvas-empty" type="button" @click="$emit('deselect')">Empty space</button>
    </div>
  `,
})

const InspectorStub = defineComponent({
  props: ['selected', 'selectedKey'],
  emits: ['select', 'close'],
  template: `
    <aside class="inspector-stub" :data-selected="selectedKey">
      {{ selected?.label }}
      <button class="close-inspector" type="button" @click="$emit('close')">Close</button>
    </aside>
  `,
})

describe('persistent session canvas', () => {
  it('keeps the canvas mounted while node details open and empty space closes them', async () => {
    vi.stubGlobal('$fetch', vi.fn(async (url: string) => {
      if (url === '/api/tree') {
        return {
          projects: [{ id: '/workspace', name: 'workspace', roots: [root] }],
          sources: [],
          now: 0,
        }
      }
      if (url.startsWith('/api/run')) return run
      return {
        key: root.key,
        events: [],
        next: 0,
        revision: 1,
        reset: false,
        node: root,
      }
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
    await flushPromises()

    const originalCanvas = component.get('.canvas-stub').element
    await component.get('.canvas-node').trigger('click')

    expect(component.get('.inspector-stub').attributes('data-selected')).toBe('review')
    expect(component.get('.inspector-stub').text()).toContain('Review agent')
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

    await component.get('.view-tabs button').trigger('click')

    expect(component.get('.session-panel').attributes('aria-label')).toBe('Activity panel')
    expect(component.get('.canvas-stub').element).toBe(originalCanvas)
  })
})
