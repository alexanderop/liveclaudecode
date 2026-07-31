import { mountSuspended } from '@nuxt/test-utils/runtime'
import { describe, expect, it } from 'vitest'
import ActiveAgentsOverview from '~/components/ActiveAgentsOverview.vue'
import RunChanges from '~/components/RunChanges.vue'
import RunOverview from '~/components/RunOverview.vue'
import TranscriptMarkdownLink from '~/components/TranscriptMarkdownLink.vue'
import { runNode, runResponse } from '../fixtures/runs'

describe('dashboard supporting views', () => {
  it('shows every active agent across projects and opens the selected agent', async () => {
    const exploring = runNode({
      key: 'exploring',
      sid: 'first',
      kind: 'subagent',
      label: 'Explore the dashboard',
      agentType: 'Explore',
      live: true,
      spawnState: 'running',
      current: { tool: 'Read', summary: 'Inspecting the agent components', ts: '2026-07-25T18:03:00.000Z' },
      children: [],
    })
    const waiting = runNode({
      key: 'waiting',
      sid: 'first',
      kind: 'subagent',
      label: 'Review the tests',
      agentType: 'Review',
      live: false,
      spawnState: 'running',
      current: null,
      children: [],
    })
    const first = runNode({
      key: 'first',
      sid: 'first',
      label: 'Improve the agent overview',
      live: false,
      spawnState: 'returned',
      children: [exploring, waiting],
    })
    const second = runNode({
      source: 'codex',
      sourceDetail: 'Codex',
      key: 'second',
      sid: 'second',
      label: 'Polish the mobile layout',
      live: true,
      spawnState: 'running',
      current: null,
      children: [],
    })
    const component = await mountSuspended(ActiveAgentsOverview, {
      props: {
        projects: [
          { id: '/dashboard', name: 'liveclaudecode', roots: [first] },
          { id: '/mobile', name: 'mobile-app', roots: [second] },
        ],
      },
    })

    expect(component.get('.active-agents-total').text()).toBe('3')
    expect(component.get('.active-agents-header').text()).toContain('2 active sessions across 2 projects')
    expect(component.findAll('.active-agent-card')).toHaveLength(3)
    expect(component.findAll('.active-agent-card')[0]!.text()).toContain('Explore the dashboard')
    expect(component.text()).toContain('Inspecting the agent components')
    expect(component.text()).toContain('mobile-app')

    await component.findAll('.active-agent-card')[0]!.trigger('click')
    expect(component.emitted('select')).toEqual([['/dashboard', 'exploring']])
  })

  it('renders changes, command outcomes, patch provenance, and safe Git links', async () => {
    const component = await mountSuspended(RunChanges, {
      props: { run: runResponse() },
    })

    expect(component.text()).toContain('Dashboard.vue')
    expect(component.text()).toContain('1Passed')
    expect(component.text()).toContain('1Failed')
    expect(component.findAll('.command-row').map(row => row.text())).toEqual([
      expect.stringContaining('pnpm test:nuxt'),
      expect.stringContaining('pnpm test:unit'),
    ])
    expect(component.get('.patch-row').text()).toContain('+12-3')
    expect(component.get('.git-event-row a').attributes()).toMatchObject({
      href: 'https://example.com/pull/1',
      target: '_blank',
      rel: 'noopener noreferrer',
    })
  })

  it('renders a task-led Overview with clickable metrics, agents, and technical details', async () => {
    const run = runResponse()
    const component = await mountSuspended(RunOverview, {
      props: { run, selectedKey: run.key },
    })

    expect(component.get('[data-workspace-heading]').text()).toBe('Ship the dashboard')
    expect(component.get('.overview-status-pill').text()).toBe('Completed with warnings')
    expect(component.text()).toContain('The dashboard is ready for review.')
    expect(component.findAll('.overview-metrics button')).toHaveLength(5)
    expect(component.get('.overview-metrics').text()).toContain('$0.01Estimated cost')
    expect(component.get('.overview-agent-row').text()).toContain('Main session')
    expect(component.findAll('.overview-actions button')).toHaveLength(2)
    expect(component.get('.run-details').attributes('open')).toBeUndefined()
    expect(component.get('.run-details-content').text()).toContain('Output tokens')
    expect(component.get('.run-details-content').text()).toContain(run.transcriptPath)

    await component.findAll('.overview-metrics button')[1]!.trigger('click')
    expect(component.emitted('open')).toEqual([['activity']])
  })
})

describe('TranscriptMarkdownLink', () => {
  it.each([
    ['https://example.com/docs', '_blank'],
    ['mailto:team@example.com', undefined],
    ['#diagnostics', undefined],
  ])('renders the safe destination %s', async (href, target) => {
    const component = await mountSuspended(TranscriptMarkdownLink, {
      props: { href },
      slots: { default: 'Documentation' },
    })

    expect(component.get('a').attributes('href')).toBe(href)
    expect(component.get('a').attributes('target')).toBe(target)
  })

  it.each(['javascript:alert(1)', 'data:text/html,unsafe', '/relative/path', undefined])(
    'renders the unsafe or unsupported destination %s as inert text',
    async (href) => {
      const component = await mountSuspended(TranscriptMarkdownLink, {
        props: { href },
        slots: { default: 'Untrusted link' },
      })

      expect(component.find('a').exists()).toBe(false)
      expect(component.get('.markdown-inert-link').text()).toBe('Untrusted link')
    },
  )
})
