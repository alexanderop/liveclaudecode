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
      global: { stubs: { UTooltip: { template: '<slot />' } } },
      props: {
        projects: [{ id: 'workout', name: 'workoutTracker', roots: [root] }],
        allProjects: [{ id: 'workout', name: 'workoutTracker', roots: [root] }],
        sources: [
          { source: 'claude', state: 'ready', sessions: 1, malformed: 0, message: '' },
          { source: 'codex', state: 'ready', sessions: 0, malformed: 0, message: '' },
        ],
        costs: {
          currency: 'USD',
          usd: 4.7,
          todayUsd: 1.23,
          last7DaysUsd: 4.7,
          coverageHours: 168,
          pricedRequests: 12,
          unpricedRequests: 0,
          estimated: true,
        },
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
        minimumSubagents: 0,
        sessionSort: 'updated',
        hours: 168,
      },
    })
    const project = component.get('.project-row')

    expect(project.text()).toContain('workoutTracker')
    expect(project.attributes('aria-expanded')).toBe('true')
    expect(component.text()).toContain('Test server for bugs')
    expect(component.get('.sidebar-cost-summary').text()).toContain('Today$1.23')
    expect(component.get('.sidebar-cost-summary').text()).toContain('Last 7 days$4.70')
    expect(component.get('.sidebar-cost-summary').text()).toContain(
      'Transcript-only estimate; excludes hidden helper calls and plan billing.',
    )
    expect(component.findAll('.primary-nav-item').map(item => item.attributes('aria-pressed'))).toEqual([
      'true',
      'false',
      'false',
      undefined,
    ])
    expect(component.get('a[href="/costs"]').text()).toContain('Costs')

    await component.get('button[aria-label="Hide sidebar"]').trigger('click')
    expect(component.emitted('collapse')).toEqual([[]])

    await project.trigger('click')
    expect(project.attributes('aria-expanded')).toBe('false')
    expect(component.get('.project-runs').attributes('style')).toContain('display: none')

    await component.get('button[aria-label="Organize sidebar"]').trigger('click')
    const listOption = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find(button => button.textContent?.includes('In one list'))
    expect(listOption).toBeDefined()
    listOption!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await component.vm.$nextTick()

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
      global: { stubs: { UTooltip: { template: '<slot />' } } },
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
        minimumSubagents: 0,
        sessionSort: 'updated',
        hours: 168,
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
      global: { stubs: { UTooltip: { template: '<slot />' } } },
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
        minimumSubagents: 0,
        sessionSort: 'updated',
        hours: 168,
      },
    })

    expect(component.text()).toContain('Loading local sessions')
    expect(component.find('.source-statuses').exists()).toBe(false)
    await component.get('.sidebar-filter-toggle').trigger('click')
    expect(component.text()).toContain('Codex')
    expect(component.text()).toContain('2 malformed records skipped')

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

    await component.get('[aria-label="Filter by project"]').trigger('click')
    const projectOption = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
      .find(option => option.textContent?.includes('repo'))
    expect(projectOption).toBeDefined()
    projectOption!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await component.vm.$nextTick()
    expect(component.emitted('update:projectFilter')).toContainEqual(['/repo'])

    await component.get('[aria-label="Filter by minimum subagents"]').trigger('click')
    const minimumOption = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
      .find(option => option.textContent?.includes('5 or more'))
    expect(minimumOption).toBeDefined()
    minimumOption!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await component.vm.$nextTick()
    expect(component.emitted('update:minimumSubagents')).toContainEqual([5])

    await component.get('[aria-label="Sort sessions"]').trigger('click')
    const sortOption = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
      .find(option => option.textContent?.includes('Most subagents'))
    expect(sortOption).toBeDefined()
    sortOption!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await component.vm.$nextTick()
    expect(component.emitted('update:sessionSort')).toContainEqual(['subagents'])

    await component.setProps({ loading: false })
    expect(component.text()).not.toContain('Loading local sessions')
    expect(component.text()).toContain('No matching sessions')
  })

  it('selects a date range and explains empty Copilot results in that range', async () => {
    const component = await mountSuspended(RunSidebar, {
      global: { stubs: { UTooltip: { template: '<slot />' } } },
      props: {
        projects: [],
        allProjects: [],
        sources: [],
        projectOptions: [],
        loading: false,
        selectedProject: null,
        selectedKey: null,
        query: '',
        sourceFilter: 'copilot',
        projectFilter: 'all',
        liveOnly: false,
        attentionOnly: false,
        hideIdle: true,
        minimumSubagents: 0,
        sessionSort: 'updated',
        hours: 24,
      },
    })

    expect(component.text()).toContain('No Copilot chats were found for last 24 hours')
    expect(component.text()).toContain('Try a longer date range')

    await component.get('.sidebar-filter-toggle').trigger('click')
    await component.get('[aria-label="Filter by date range"]').trigger('click')
    const allTimeOption = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
      .find(option => option.textContent?.includes('All time'))
    expect(allTimeOption).toBeDefined()
    allTimeOption!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await component.vm.$nextTick()

    expect(component.emitted('update:hours')).toContainEqual([0])
  })
})
