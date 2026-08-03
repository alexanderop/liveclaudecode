import type { VueWrapper } from '@vue/test-utils'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CodeBlock from '~/components/CodeBlock.vue'

let component: VueWrapper | null = null

afterEach(() => {
  component?.unmount()
  component = null
})

/** Highlighting resolves through a dynamic grammar import, not just a tick. */
const highlighted = (wrapper: VueWrapper) =>
  vi.waitFor(() => expect(wrapper.find('.code-block-body').exists()).toBe(true))

describe('CodeBlock', () => {
  it('highlights the code it is given', async () => {
    const wrapper = component = await mountSuspended(CodeBlock, {
      props: { code: 'const answer = 42', language: 'ts' },
    })
    await highlighted(wrapper)

    const shiki = wrapper.get('.code-block-body pre')
    expect(shiki.classes()).toContain('shiki')
    expect(shiki.text()).toBe('const answer = 42')
    // Tokenized rather than dumped as one string.
    expect(shiki.findAll('span[style]').length).toBeGreaterThan(1)
  })

  it('reads the source out of a Comark fence node', async () => {
    const wrapper = component = await mountSuspended(CodeBlock, {
      props: {
        __node: ['pre', { language: 'json' }, ['code', {}, '{ "a": 1 }']],
        language: 'json',
      },
    })
    await highlighted(wrapper)

    expect(wrapper.get('.code-block-body').text()).toBe('{ "a": 1 }')
  })

  it('marks added and removed lines and flags itself as a diff', async () => {
    const wrapper = component = await mountSuspended(CodeBlock, {
      props: { code: 'let a = 1\nlet a = 2', language: 'ts', removed: [1], added: [2] },
    })
    await highlighted(wrapper)

    expect(wrapper.classes()).toContain('is-diff')
    expect(wrapper.get('.line-remove').text()).toBe('let a = 1')
    expect(wrapper.get('.line-add').text()).toBe('let a = 2')
  })

  it('labels the block with its file path', async () => {
    const wrapper = component = await mountSuspended(CodeBlock, {
      props: { code: 'x', language: 'text', path: 'app/utils/format.ts' },
    })
    await flushPromises()

    expect(wrapper.get('.code-block-name').text()).toBe('app/utils/format.ts')
  })

  it('shows unhighlighted text while deferred', async () => {
    const wrapper = component = await mountSuspended(CodeBlock, {
      props: { code: 'const answer = 42', language: 'ts', defer: true },
    })
    await flushPromises()

    expect(wrapper.find('.code-block-body').exists()).toBe(false)
    expect(wrapper.get('.code-block-plain').text()).toBe('const answer = 42')
  })

  it('renders an unknown language as plain text rather than failing', async () => {
    const wrapper = component = await mountSuspended(CodeBlock, {
      props: { code: 'whatever this is', language: 'brainfuck' },
    })
    await highlighted(wrapper)

    expect(wrapper.get('.code-block-body').text()).toBe('whatever this is')
  })
})
