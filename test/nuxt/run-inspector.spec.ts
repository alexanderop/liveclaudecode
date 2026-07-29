import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import RunInspector from '~/components/RunInspector.vue'
import type { RunNode, RunResponse } from '#shared/types/run'

function node(key: string, options: Partial<RunNode> = {}): RunNode {
  return {
    key,
    label: key,
    agentType: key === 'root' ? '' : 'reviewer',
    source: 'claude',
    sourceDetail: '',
    kind: key === 'root' ? 'session' : 'subagent',
    sid: key,
    toolUseId: null,
    model: '',
    spawnDepth: key === 'root' ? 0 : 1,
    parentAgentId: key === 'root' ? null : 'root',
    stoppedByUser: false,
    spawnState: '',
    children: [],
    subAgents: 0,
    subRunning: 0,
    subErrors: 0,
    subTools: 0,
    subFiles: {},
    subLast: null,
    subLive: false,
    records: 1,
    tools: 0,
    toolCounts: {},
    reads: 0,
    errors: 0,
    tokensOut: 0,
    firstTs: null,
    lastTs: null,
    mtime: 0,
    ago: 0,
    live: false,
    size: 0,
    todos: null,
    skills: [],
    milestones: [],
    current: null,
    files: [],
    commands: [],
    finalText: '',
    ...options,
  }
}

function run(root: RunNode, selected: RunNode): RunResponse {
  return {
    key: root.key,
    transcriptPath: `/claude/projects/repo/${selected.key}.jsonl`,
    lanes: [
      {
        key: root.key,
        label: root.label,
        agentType: root.agentType,
        kind: root.kind,
        depth: 0,
        firstTs: root.firstTs,
        lastTs: root.lastTs,
        live: root.live,
        errors: root.errors,
        tools: root.tools,
        spawnState: root.spawnState,
        files: root.files.length,
      },
      {
        key: selected.key,
        label: selected.label,
        agentType: selected.agentType,
        kind: selected.kind,
        depth: 1,
        firstTs: selected.firstTs,
        lastTs: selected.lastTs,
        live: selected.live,
        errors: selected.errors,
        tools: selected.tools,
        spawnState: selected.spawnState,
        files: selected.files.length,
      },
    ],
    files: [],
    phases: [],
    diagnostics: {
      incidents: [],
      turns: [],
      compactions: [],
      outcomes: [],
      changes: [],
      git: [],
      agents: [],
      environment: {
        cwd: '',
        gitBranch: '',
        version: '',
        entrypoint: '',
        permissionMode: '',
      },
      causal: {
        records: 0,
        recordsWithUuid: 0,
        branchPoints: 0,
        sidechainRecords: 0,
        interruptions: 0,
      },
      usage: { in: 0, out: 0, cr: 0, cw: 0 },
    },
    node: selected,
    root,
  }
}

describe('run inspector', () => {
  it('describes the selected node and exposes close and agent-selection actions', async () => {
    const child = node('review', {
      label: 'Review accessibility',
      live: true,
      tools: 3,
      toolCounts: { Read: 2, Grep: 1 },
      firstTs: '2026-07-28T10:00:00.000Z',
    })
    const root = node('root', { children: [child] })
    const component = await mountSuspended(RunInspector, {
      props: {
        run: run(root, child),
        root,
        selected: child,
        selectedKey: child.key,
        events: [{
          role: 'assistant',
          kind: 'text',
          ts: '2026-07-28T10:00:01.000Z',
          line: 1,
          body: 'Reviewed the accessibility flow.',
        }],
        eventsLoading: false,
        density: 'normal',
        errorsOnly: false,
        followOutput: false,
      },
    })

    expect(component.get('.inspector-title').text()).toContain('Review accessibility')
    expect(component.get('[role="tab"][aria-selected="true"]').text()).toContain('Activity')
    expect(component.get('.event').text()).toContain('Reviewed the accessibility flow.')

    await component.findAll('[role="tab"]')[0]!.trigger('click')
    expect(component.get('.status-value').text()).toBe('Thinking')
    expect(component.text()).toContain('Claude')
    expect(component.text()).toContain('Read 2')

    await component.get('.inspector-close').trigger('click')
    expect(component.emitted('close')).toHaveLength(1)

    await component.findAll('.agent-row')[0]!.trigger('click')
    expect(component.emitted('select')?.[0]).toEqual(['root'])
  })

  it('shows a loading state while switching to another agent activity stream', async () => {
    const child = node('review', { label: 'Review accessibility' })
    const root = node('root', { children: [child] })
    const component = await mountSuspended(RunInspector, {
      props: {
        run: run(root, child),
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

    expect(component.get('.inspector-activity-loading').text()).toContain('Loading agent activity')
    expect(component.find('.feed').exists()).toBe(false)
  })
})
