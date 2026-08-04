import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RunInspector from '~/components/RunInspector.vue'
import type { RunNode, RunResponse } from '#shared/types/run'
import { chatActionResponse, chatEventsResponse } from '../fixtures/chat'
import { mockLiveApi } from '../fixtures/live-api'
import { runNode, runResponse, timelineLane, transcriptEvent } from '../fixtures/runs'

let component: VueWrapper | null = null

afterEach(() => {
  component?.unmount()
  component = null
  vi.unstubAllGlobals()
})

const ASK_TAB = 5

/** Requests the chat poll made, so a test can watch polling start and stop. */
function chatPolls(fetch: ReturnType<typeof mockLiveApi>): number {
  return fetch.mock.calls.filter(([url, options]) =>
    String(url).startsWith('/api/chat') && options?.method !== 'POST').length
}

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
        project: '/repo',
        hours: 720,
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

  it('renders the subagent prompt and result as highlighted Markdown', async () => {
    const child = inspectorNode('review', {
      label: 'Review accessibility',
      finalText: '## Findings\n\nUse the helper:\n\n```ts\nconst answer = 42\n```\n',
    })
    const root = inspectorNode('root', { children: [child] })
    const wrapper = component = await mountSuspended(RunInspector, {
      props: {
        run: inspectorRun(root, child),
        root,
        selected: child,
        selectedKey: child.key,
        project: '/repo',
        hours: 720,
        events: [transcriptEvent('Audit the **focus order**', { role: 'user', kind: 'prompt' })],
        eventsLoading: false,
        density: 'normal',
        errorsOnly: false,
        followOutput: false,
      },
    })

    await wrapper.findAll('[role="tab"]')[4]!.trigger('mousedown', { button: 0 })
    await flushPromises()

    await vi.waitFor(() => {
      const sections = wrapper.findAll('.inspector-result .result-copy')
      expect(sections).toHaveLength(2)
      expect(sections[0]!.get('strong').text()).toBe('focus order')
      expect(sections[1]!.get('h2').text()).toBe('Findings')
      expect(wrapper.find('.inspector-result .code-block-body').exists()).toBe(true)
    })
    const shiki = wrapper.get('.inspector-result .code-block-body pre')
    expect(shiki.classes()).toContain('shiki')
    expect(shiki.text()).toBe('const answer = 42')
    expect(shiki.findAll('span[style]').length).toBeGreaterThan(1)
  })

  it('falls back to plain copy when the result tab has nothing recorded', async () => {
    const child = inspectorNode('review', { label: 'Review accessibility' })
    const root = inspectorNode('root', { children: [child] })
    const wrapper = component = await mountSuspended(RunInspector, {
      props: {
        run: inspectorRun(root, child),
        root,
        selected: child,
        selectedKey: child.key,
        project: '/repo',
        hours: 720,
        events: [],
        eventsLoading: false,
        density: 'normal',
        errorsOnly: false,
        followOutput: false,
      },
    })

    await wrapper.findAll('[role="tab"]')[4]!.trigger('mousedown', { button: 0 })
    await flushPromises()

    expect(wrapper.findAll('.inspector-result .result-empty').map(copy => copy.text())).toEqual([
      'No prompt event was recorded.',
      'No final result was recorded.',
    ])
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
        project: '/repo',
        hours: 720,
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

  it('scopes the Ask tab to the inspected subagent', async () => {
    const child = inspectorNode('root/review', { label: 'Review accessibility' })
    const root = inspectorNode('root', { children: [child] })
    const fetch = mockLiveApi(root, {
      chat: () => chatEventsResponse(),
      chatAction: () => chatActionResponse(),
    })
    const wrapper = component = await mountSuspended(RunInspector, {
      props: {
        run: inspectorRun(root, child),
        root,
        selected: child,
        selectedKey: child.key,
        project: '/repo',
        hours: 720,
        events: [],
        eventsLoading: false,
        density: 'normal',
        errorsOnly: false,
        followOutput: false,
      },
    })

    await wrapper.findAll('[role="tab"]')[ASK_TAB]!.trigger('mousedown', { button: 0 })
    await flushPromises()

    expect(wrapper.get('.chat-empty').text()).toContain('Ask about this subagent')
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/chat?project=%2Frepo&key=root%2Freview&since=0&revision=0&hours=720'),
      { signal: expect.any(AbortSignal) },
    )

    await wrapper.get('textarea').setValue('What did this agent change?')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    const post = fetch.mock.calls.find(([, options]) => options?.method === 'POST')
    expect(post?.[1]?.body).toEqual({
      action: 'send',
      project: '/repo',
      key: 'root/review',
      agent: 'claude',
      text: 'What did this agent change?',
    })
  })

  it('stops polling the subagent chat once another tab is opened', async () => {
    const child = inspectorNode('root/review', { label: 'Review accessibility' })
    const root = inspectorNode('root', { children: [child] })
    const fetch = mockLiveApi(root, { chat: () => chatEventsResponse() })
    const wrapper = component = await mountSuspended(RunInspector, {
      props: {
        run: inspectorRun(root, child),
        root,
        selected: child,
        selectedKey: child.key,
        project: '/repo',
        hours: 720,
        events: [],
        eventsLoading: false,
        density: 'normal',
        errorsOnly: false,
        followOutput: false,
      },
    })

    vi.useFakeTimers()
    try {
      await wrapper.findAll('[role="tab"]')[ASK_TAB]!.trigger('mousedown', { button: 0 })
      await flushPromises()
      const opened = chatPolls(fetch)
      await vi.advanceTimersByTimeAsync(2_400)
      expect(chatPolls(fetch)).toBeGreaterThan(opened)

      await wrapper.findAll('[role="tab"]')[0]!.trigger('mousedown', { button: 0 })
      await flushPromises()
      const closed = chatPolls(fetch)
      await vi.advanceTimersByTimeAsync(2_400)

      expect(wrapper.find('.chat-panel').exists()).toBe(false)
      expect(chatPolls(fetch)).toBe(closed)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves the Ask tab when another agent is selected', async () => {
    const child = inspectorNode('root/review', { label: 'Review accessibility' })
    const sibling = inspectorNode('root/audit', { label: 'Audit the styles' })
    const root = inspectorNode('root', { children: [child, sibling] })
    mockLiveApi(root, { chat: () => chatEventsResponse() })
    const wrapper = component = await mountSuspended(RunInspector, {
      props: {
        run: inspectorRun(root, child),
        root,
        selected: child,
        selectedKey: child.key,
        project: '/repo',
        hours: 720,
        events: [],
        eventsLoading: false,
        density: 'normal',
        errorsOnly: false,
        followOutput: false,
      },
    })

    await wrapper.findAll('[role="tab"]')[ASK_TAB]!.trigger('mousedown', { button: 0 })
    await flushPromises()
    expect(wrapper.find('.chat-panel').exists()).toBe(true)

    await wrapper.setProps({ selected: sibling, selectedKey: sibling.key })
    await flushPromises()

    expect(wrapper.get('[role="tab"][aria-selected="true"]').text()).toContain('Summary')
    expect(wrapper.find('.chat-panel').exists()).toBe(false)
  })
})
