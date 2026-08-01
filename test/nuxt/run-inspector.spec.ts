import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import RunInspector from '~/components/RunInspector.vue'
import type { RunNode, RunResponse } from '#shared/types/run'
import { runNode, runResponse, timelineLane, transcriptEvent } from '../fixtures/runs'

let component: VueWrapper | null = null

afterEach(() => {
  component?.unmount()
  component = null
})

function inspectorNode(key: string, overrides: Partial<RunNode> = {}): RunNode {
  return runNode({
    key,
    sid: key,
    label: key,
    kind: key === 'root' ? 'session' : 'subagent',
    agentType: key === 'root' ? '' : 'reviewer',
    sourceDetail: '',
    model: '',
    spawnDepth: key === 'root' ? 0 : 1,
    parentAgentId: key === 'root' ? null : 'root',
    spawnState: '',
    tools: 0,
    toolCounts: {},
    errors: 0,
    tokensOut: 0,
    firstTs: null,
    lastTs: null,
    todos: null,
    milestones: [],
    current: null,
    files: [],
    commands: [],
    finalText: '',
    subErrors: 0,
    subTools: 0,
    subFiles: {},
    subLast: null,
    ...overrides,
  })
}

function laneFor(node: RunNode, depth: number) {
  return timelineLane({
    key: node.key,
    label: node.label,
    agentType: node.agentType,
    kind: node.kind,
    depth,
    firstTs: node.firstTs,
    lastTs: node.lastTs,
    live: node.live,
    errors: node.errors,
    tools: node.tools,
    spawnState: node.spawnState,
    files: node.files.length,
  })
}

function inspectorRun(root: RunNode, selected: RunNode): RunResponse {
  return runResponse({
    key: root.key,
    transcriptPath: `/claude/projects/repo/${selected.key}.jsonl`,
    lanes: [laneFor(root, 0), laneFor(selected, 1)],
    files: [],
    phases: [],
    node: selected,
    root,
  })
}

describe('run inspector', () => {
  it('describes the selected node and exposes close and agent-selection actions', async () => {
    const child = inspectorNode('review', {
      label: 'Review accessibility',
      live: true,
      tools: 3,
      toolCounts: { Read: 2, Grep: 1 },
      firstTs: '2026-07-28T10:00:00.000Z',
    })
    const root = inspectorNode('root', { children: [child] })
    const wrapper = component = await mountSuspended(RunInspector, {
      props: {
        run: inspectorRun(root, child),
        root,
        selected: child,
        selectedKey: child.key,
        events: [transcriptEvent('Reviewed the accessibility flow.', {
          ts: '2026-07-28T10:00:01.000Z',
        })],
        eventsLoading: false,
        density: 'normal',
        errorsOnly: false,
        followOutput: false,
      },
    })

    expect(wrapper.get('.inspector-title').text()).toContain('Review accessibility')
    expect(wrapper.get('[role="tab"][aria-selected="true"]').text()).toContain('Summary')
    expect(wrapper.get('.status-value').text()).toBe('Thinking')
    expect(wrapper.findAll('.property-row').map(row => row.text()))
      .toContainEqual('ProviderClaude')
    expect(wrapper.findAll('.tool-chip').map(chip => chip.text()))
      .toContainEqual('Read 2')

    await wrapper.findAll('.agent-row')[0]!.trigger('click')
    expect(wrapper.emitted('select')?.[0]).toEqual(['root'])

    await wrapper.findAll('[role="tab"]')[1]!.trigger('mousedown', { button: 0 })
    await flushPromises()
    expect(wrapper.findAll('.event')).toHaveLength(1)

    await wrapper.get('.inspector-close').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('shows a loading state while switching to another agent activity stream', async () => {
    const child = inspectorNode('review', { label: 'Review accessibility' })
    const root = inspectorNode('root', { children: [child] })
    const wrapper = component = await mountSuspended(RunInspector, {
      props: {
        run: inspectorRun(root, child),
        root,
        selected: child,
        selectedKey: child.key,
        events: [],
        eventsLoading: true,
        density: 'compact',
        errorsOnly: false,
        followOutput: false,
      },
    })
    await flushPromises()

    await wrapper.findAll('[role="tab"]')[1]!.trigger('mousedown', { button: 0 })
    await flushPromises()
    expect(wrapper.get('.inspector-activity-loading').text()).toContain('Loading agent activity')
    expect(wrapper.find('.feed').exists()).toBe(false)
  })
})
