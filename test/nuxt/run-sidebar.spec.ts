import { mountSuspended } from '@nuxt/test-utils/runtime'
import { describe, expect, it } from 'vitest'
import RunSidebar from '~/components/RunSidebar.vue'
import type { RunNode } from '#shared/types/run'

function run(): RunNode {
  return {
    source: 'claude',
    sourceDetail: 'Claude Code',
    key: 'session',
    kind: 'session',
    sid: 'session',
    label: 'Test server for bugs',
    agentType: '',
    toolUseId: null,
    model: '',
    spawnDepth: null,
    parentAgentId: null,
    stoppedByUser: false,
    spawnState: '',
    children: [],
    records: 1,
    tools: 2,
    toolCounts: { Bash: 2 },
    reads: 0,
    errors: 0,
    tokensOut: 10,
    firstTs: '2026-07-25T18:00:00.000Z',
    lastTs: '2026-07-25T18:00:02.000Z',
    mtime: 0,
    ago: 0,
    live: false,
    size: 10,
    todos: null,
    skills: [],
    milestones: [],
    current: null,
    files: [],
    commands: [],
    finalText: '',
    subAgents: 0,
    subRunning: 0,
    subErrors: 0,
    subTools: 2,
    subFiles: {},
    subLast: '2026-07-25T18:00:02.000Z',
    subLive: false,
  }
}

describe('RunSidebar', () => {
  it('groups sessions under the current project by default and can flatten the list', async () => {
    const root = run()
    const component = await mountSuspended(RunSidebar, {
      props: {
        projects: [{ id: 'workout', name: 'workoutTracker', roots: [root] }],
        allProjects: [{ id: 'workout', name: 'workoutTracker', roots: [root] }],
        sources: [
          { source: 'claude', state: 'ready', sessions: 1, malformed: 0, message: '' },
          { source: 'codex', state: 'ready', sessions: 0, malformed: 0, message: '' },
        ],
        projectOptions: [{ id: 'workout', name: 'workoutTracker' }],
        loading: false,
        selectedProject: null,
        selectedKey: null,
        query: '',
        sourceFilter: 'all',
        projectFilter: 'all',
        liveOnly: false,
        attentionOnly: false,
        hideIdle: true,
      },
    })
    const project = component.get('.project-row')

    expect(project.text()).toContain('workoutTracker')
    expect(project.attributes('aria-expanded')).toBe('true')
    expect(component.text()).toContain('Test server for bugs')
    expect(component.findAll('.primary-nav-item').map(item => item.attributes('aria-pressed'))).toEqual([
      'true',
      'false',
      'false',
    ])

    await component.get('button[aria-label="Hide sidebar"]').trigger('click')
    expect(component.emitted('collapse')).toEqual([[]])

    await project.trigger('click')
    expect(project.attributes('aria-expanded')).toBe('false')
    expect(component.get('.project-runs').attributes('style')).toContain('display: none')

    const listOption = component.findAll('.organize-popover button')
      .find(button => button.text().includes('In one list'))
    expect(listOption).toBeDefined()
    await listOption!.trigger('click')

    expect(component.find('.project-row').exists()).toBe(false)
    expect(component.text()).toContain('Recent sessions')
    expect(component.text()).toContain('Test server for bugs')

    await component.findAll('.primary-nav-item')[1]!.trigger('click')
    expect(component.emitted('update:liveOnly')).toContainEqual([true])
  })

  it('renders every discovered project and selects a run with its project id', async () => {
    const first = run()
    const second = { ...run(), key: 'second-session', sid: 'second-session', label: 'Other run' }
    const component = await mountSuspended(RunSidebar, {
      props: {
        projects: [
          { id: 'workout', name: 'workoutTracker', roots: [first] },
          { id: 'other', name: 'other-project', roots: [second] },
        ],
        allProjects: [
          { id: 'workout', name: 'workoutTracker', roots: [first] },
          { id: 'other', name: 'other-project', roots: [second] },
        ],
        sources: [
          { source: 'claude', state: 'ready', sessions: 2, malformed: 0, message: '' },
          { source: 'codex', state: 'ready', sessions: 0, malformed: 0, message: '' },
        ],
        projectOptions: [
          { id: 'workout', name: 'workoutTracker' },
          { id: 'other', name: 'other-project' },
        ],
        loading: false,
        selectedProject: null,
        selectedKey: null,
        query: '',
        sourceFilter: 'all',
        projectFilter: 'all',
        liveOnly: false,
        attentionOnly: false,
        hideIdle: true,
      },
    })

    expect(component.findAll('.project-row').map(row => row.text())).toEqual([
      expect.stringContaining('workoutTracker'),
      expect.stringContaining('other-project'),
    ])
    await component.findAll('.tree-node')[1]!.trigger('click')
    expect(component.emitted('select')).toContainEqual(['other', 'second-session'])
  })

  it('updates provider/project filters and distinguishes loading, empty, and degraded states', async () => {
    const component = await mountSuspended(RunSidebar, {
      props: {
        projects: [],
        allProjects: [],
        sources: [
          { source: 'claude', state: 'ready', sessions: 0, malformed: 0, message: '' },
          {
            source: 'codex',
            state: 'degraded',
            sessions: 1,
            malformed: 2,
            message: '2 malformed records skipped',
          },
        ],
        projectOptions: [{ id: '/repo', name: 'repo' }],
        loading: true,
        selectedProject: null,
        selectedKey: null,
        query: '',
        sourceFilter: 'all',
        projectFilter: 'all',
        liveOnly: false,
        attentionOnly: false,
        hideIdle: true,
      },
    })

    expect(component.text()).toContain('Loading local sessions')
    expect(component.text()).toContain('Codex 2 malformed records skipped')

    const codexButton = component.findAll('.source-filters button')
      .find(button => button.text() === 'Codex')
    expect(codexButton).toBeDefined()
    await codexButton!.trigger('click')
    expect(component.emitted('update:sourceFilter')).toContainEqual(['codex'])

    const copilotButton = component.findAll('.source-filters button')
      .find(button => button.text() === 'Copilot')
    expect(copilotButton).toBeDefined()
    await copilotButton!.trigger('click')
    expect(component.emitted('update:sourceFilter')).toContainEqual(['copilot'])

    await component.get('select[aria-label="Filter by project"]').setValue('/repo')
    expect(component.emitted('update:projectFilter')).toContainEqual(['/repo'])

    await component.setProps({ loading: false })
    expect(component.text()).not.toContain('Loading local sessions')
    expect(component.text()).toContain('No matching sessions')
  })
})
