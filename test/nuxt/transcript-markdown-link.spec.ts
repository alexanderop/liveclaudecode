import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import TranscriptMarkdownLink from '~/components/TranscriptMarkdownLink.vue'

let component: VueWrapper | null = null

afterEach(() => {
  component?.unmount()
  component = null
})

describe('TranscriptMarkdownLink', () => {
  it.each([
    ['https://example.com/docs', '_blank'],
    ['mailto:team@example.com', undefined],
    ['#diagnostics', undefined],
  ])('renders the safe destination %s', async (href, target) => {
    const wrapper = component = await mountSuspended(TranscriptMarkdownLink, {
      props: { href },
      slots: { default: 'Documentation' },
    })

    expect(wrapper.get('a').attributes('href')).toBe(href)
    expect(wrapper.get('a').attributes('target')).toBe(target)
  })

  it.each(['javascript:alert(1)', 'data:text/html,unsafe', '/relative/path', undefined])(
    'renders the unsafe or unsupported destination %s as inert text',
    async (href) => {
      const wrapper = component = await mountSuspended(TranscriptMarkdownLink, {
        props: { href },
        slots: { default: 'Untrusted link' },
      })

      expect(wrapper.find('a').exists()).toBe(false)
      expect(wrapper.get('.markdown-inert-link').text()).toBe('Untrusted link')
    },
  )
})
