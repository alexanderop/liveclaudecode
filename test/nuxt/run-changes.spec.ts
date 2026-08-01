import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import RunChanges from '~/components/RunChanges.vue'
import { runResponse } from '../fixtures/runs'

let component: VueWrapper | null = null

afterEach(() => {
  component?.unmount()
  component = null
})

describe('RunChanges', () => {
  it('renders changes, command outcomes, patch provenance, and safe Git links', async () => {
    const wrapper = component = await mountSuspended(RunChanges, {
      props: { run: runResponse() },
    })

    expect(wrapper.text()).toContain('Dashboard.vue')
    expect(wrapper.text()).toContain('1Passed')
    expect(wrapper.text()).toContain('1Failed')
    expect(wrapper.findAll('.command-row').map(row => row.text())).toEqual([
      expect.stringContaining('pnpm test:nuxt'),
      expect.stringContaining('pnpm test:unit'),
    ])
    expect(wrapper.get('.patch-row').text()).toContain('+12-3')
    expect(wrapper.get('.git-event-row a').attributes()).toMatchObject({
      href: 'https://example.com/pull/1',
      target: '_blank',
      rel: 'noopener noreferrer',
    })
  })
})
