import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import RunSidebar from '~/components/RunSidebar.vue'
import type { RunNode } from '#shared/types/run'
import { DEFAULT_HOURS, PROJECT_ID, runNode } from '../fixtures/runs'

let component: VueWrapper | null = null

afterEach(() => {
  component?.unmount()
  component = null
  // Select and organize menus teleport into document.body.
  document.body.innerHTML = ''
})

function sidebarRun(overrides: Partial<RunNode> = {}): RunNode {
  return runNode({
    label: 'Test server for bugs',
    errors: 0,
    subErrors: 0,
    spawnState: '',
    ...overrides,
  })
}

const degradedSources = [
  { source: 'claude', state: 'ready', sessions: 0, malformed: 0, message: '' },
  {
    source: 'codex',
    state: 'degraded',
    sessions: 1,
    malformed: 2,
    message: '2 malformed records skipped',
  },
] as const

async function mountSidebar(overrides: Record<string, unknown> = {}) {
  const wrapper = await mountSuspended(RunSidebar, {
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
      sourceFilter: 'all',
      projectFilter: 'all',
      liveOnly: false,
      attentionOnly: false,
      hideIdle: true,
      minimumSubagents: 0,
      sessionSort: 'updated',
      hours: DEFAULT_HOURS,
      ...overrides,
    },
  })
  component = wrapper
  return wrapper
}

function menuEntry(role: string, text: string): HTMLElement | undefined {
  return [...document.body.querySelectorAll<HTMLElement>(`[role="${role}"]`)]
    .find(entry => entry.textContent?.includes(text))
}

describe('RunSidebar', () => {
  it('groups sessions under the current project by default and can flatten the list', async () => {
    const root = sidebarRun()
    const wrapper = await mountSidebar({
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
        coverageHours: DEFAULT_HOURS,
        pricedRequests: 12,
        unpricedRequests: 0,
        estimated: true,
      },
      projectOptions: [{ id: 'workout', name: 'workoutTracker' }],
    })
    const project = wrapper.get('.project-row')

    expect(project.text()).toContain('workoutTracker')
    expect(project.attributes('aria-expanded')).toBe('true')
    expect(wrapper.text()).toContain('Test server for bugs')
    expect(wrapper.get('.sidebar-cost-summary').text()).toContain('Today$1.23')
    expect(wrapper.get('.sidebar-cost-summary').text()).toContain('Last 7 days$4.70')
    expect(wrapper.get('.sidebar-cost-summary').text()).toContain(
      'Transcript-only estimate; excludes hidden helper calls and plan billing.',
    )
    // The scope filters are toggles; the Costs and Debug links are not.
    expect(wrapper.findAll('.primary-nav-item').map(item => item.attributes('aria-pressed'))).toEqual([
      'true',
      'false',
      'false',
      undefined,
      undefined,
    ])
    expect(wrapper.get('a[href="/costs"]').text()).toContain('Costs')
    expect(wrapper.get('a[href="/debug"]').text()).toContain('Debug')

    await wrapper.get('button[aria-label="Hide sidebar"]').trigger('click')
    expect(wrapper.emitted('collapse')).toEqual([[]])

    await project.trigger('click')
    expect(project.attributes('aria-expanded')).toBe('false')
    expect(wrapper.get('.project-runs').attributes('style')).toContain('display: none')

    await wrapper.get('button[aria-label="Organize sidebar"]').trigger('click')
    const listOption = menuEntry('menuitem', 'In one list')
    expect(listOption).toBeDefined()
    listOption!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.project-row').exists()).toBe(false)
    expect(wrapper.text()).toContain('Recent sessions')
    expect(wrapper.text()).toContain('Test server for bugs')

    await wrapper.findAll('.primary-nav-item')[1]!.trigger('click')
    expect(wrapper.emitted('update:liveOnly')).toContainEqual([true])
  })

  it('renders every discovered project and selects a run with its project id', async () => {
    const first = sidebarRun()
    const second = sidebarRun({ key: 'second-session', sid: 'second-session', label: 'Other run' })
    const projects = [
      { id: 'workout', name: 'workoutTracker', roots: [first] },
      { id: 'other', name: 'other-project', roots: [second] },
    ]
    const wrapper = await mountSidebar({
      projects,
      allProjects: projects,
      sources: [
        { source: 'claude', state: 'ready', sessions: 2, malformed: 0, message: '' },
        { source: 'codex', state: 'ready', sessions: 0, malformed: 0, message: '' },
      ],
      projectOptions: [
        { id: 'workout', name: 'workoutTracker' },
        { id: 'other', name: 'other-project' },
      ],
    })

    expect(wrapper.findAll('.project-row').map(row => row.text())).toEqual([
      expect.stringContaining('workoutTracker'),
      expect.stringContaining('other-project'),
    ])
    await wrapper.findAll('.tree-node')[1]!.trigger('click')
    expect(wrapper.emitted('select')).toContainEqual(['other', 'second-session'])
  })

  it('hides source health while loading and reveals degraded details in the filters', async () => {
    const wrapper = await mountSidebar({ sources: degradedSources, loading: true })

    expect(wrapper.text()).toContain('Loading local sessions')
    expect(wrapper.find('.source-statuses').exists()).toBe(false)

    await wrapper.get('.sidebar-filter-toggle').trigger('click')
    expect(wrapper.get('.source-statuses').text()).toContain('Codex')
    expect(wrapper.get('.source-statuses').text()).toContain('2 malformed records skipped')
  })

  it('emits provider filter updates for each source button', async () => {
    const wrapper = await mountSidebar({ sources: degradedSources })
    await wrapper.get('.sidebar-filter-toggle').trigger('click')

    const codexButton = wrapper.findAll('.source-filters button')
      .find(button => button.text() === 'Codex')
    expect(codexButton).toBeDefined()
    await codexButton!.trigger('click')
    expect(wrapper.emitted('update:sourceFilter')).toContainEqual(['codex'])

    const copilotButton = wrapper.findAll('.source-filters button')
      .find(button => button.text() === 'Copilot')
    expect(copilotButton).toBeDefined()
    await copilotButton!.trigger('click')
    expect(wrapper.emitted('update:sourceFilter')).toContainEqual(['copilot'])
  })

  it('emits project filter updates from the project select', async () => {
    const wrapper = await mountSidebar({
      sources: degradedSources,
      projectOptions: [{ id: PROJECT_ID, name: 'repo' }],
    })
    await wrapper.get('.sidebar-filter-toggle').trigger('click')

    await wrapper.get('[aria-label="Filter by project"]').trigger('click')
    const projectOption = menuEntry('option', 'repo')
    expect(projectOption).toBeDefined()
    projectOption!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('update:projectFilter')).toContainEqual([PROJECT_ID])
  })

  it('emits minimum subagent filter updates', async () => {
    const wrapper = await mountSidebar({ sources: degradedSources })
    await wrapper.get('.sidebar-filter-toggle').trigger('click')

    await wrapper.get('[aria-label="Filter by minimum subagents"]').trigger('click')
    const minimumOption = menuEntry('option', '5 or more')
    expect(minimumOption).toBeDefined()
    minimumOption!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('update:minimumSubagents')).toContainEqual([5])
  })

  it('emits session sort updates', async () => {
    const wrapper = await mountSidebar({ sources: degradedSources })
    await wrapper.get('.sidebar-filter-toggle').trigger('click')

    await wrapper.get('[aria-label="Sort sessions"]').trigger('click')
    const sortOption = menuEntry('option', 'Most subagents')
    expect(sortOption).toBeDefined()
    sortOption!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('update:sessionSort')).toContainEqual(['subagents'])
  })

  it('distinguishes the empty state from loading once results settle', async () => {
    const wrapper = await mountSidebar({ sources: degradedSources, loading: true })
    expect(wrapper.text()).toContain('Loading local sessions')

    await wrapper.setProps({ loading: false })
    expect(wrapper.text()).not.toContain('Loading local sessions')
    expect(wrapper.text()).toContain('No matching sessions')
  })

  it('selects a date range and explains empty Copilot results in that range', async () => {
    const wrapper = await mountSidebar({ sourceFilter: 'copilot', hours: 24 })

    expect(wrapper.text()).toContain('No Copilot chats were found for last 24 hours')
    expect(wrapper.text()).toContain('Try a longer date range')

    await wrapper.get('.sidebar-filter-toggle').trigger('click')
    await wrapper.get('[aria-label="Filter by date range"]').trigger('click')
    const allTimeOption = menuEntry('option', 'All time')
    expect(allTimeOption).toBeDefined()
    allTimeOption!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('update:hours')).toContainEqual([0])
  })
})
