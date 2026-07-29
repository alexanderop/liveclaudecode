import { mountSuspended } from '@nuxt/test-utils/runtime'
import { describe, expect, it } from 'vitest'
import RunChanges from '~/components/RunChanges.vue'
import RunOverview from '~/components/RunOverview.vue'
import TranscriptMarkdownLink from '~/components/TranscriptMarkdownLink.vue'
import { runResponse } from '../fixtures/runs'

describe('dashboard supporting views', () => {
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

  it('renders the execution guide and emits the selected agent key', async () => {
    const run = runResponse()
    const component = await mountSuspended(RunOverview, {
      props: { run, selectedKey: run.key },
    })

    expect(component.text()).toContain('1 agent across 2m0s')
    expect(component.text()).toContain('1 of 2 complete')
    expect(component.text()).toContain('Latest: Validation')
    expect(component.text()).toContain('Session narrative')
    expect(component.text()).toContain('The dashboard is ready for review.')
    expect(component.get('.lane').attributes('aria-current')).toBe('true')

    await component.get('.lane').trigger('click')
    expect(component.emitted('select')).toEqual([[run.key]])
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
