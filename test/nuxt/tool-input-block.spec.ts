import type { VueWrapper } from '@vue/test-utils'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ToolInputBlock from '~/components/ToolInputBlock.vue'

let component: VueWrapper | null = null

afterEach(() => {
  component?.unmount()
  component = null
})

const payload = (value: unknown): string => JSON.stringify(value, null, 2)

async function open(wrapper: VueWrapper): Promise<void> {
  const details = wrapper.get('details').element as HTMLDetailsElement
  details.open = true
  await wrapper.get('details').trigger('toggle')
  await vi.waitFor(() => expect(wrapper.find('.code-block-body').exists()).toBe(true))
}

describe('ToolInputBlock', () => {
  it('does not parse the payload until the disclosure is opened', async () => {
    const wrapper = component = await mountSuspended(ToolInputBlock, {
      props: { tool: 'Edit', input: payload({ file_path: 'a.ts', old_string: 'a', new_string: 'b' }) },
    })
    await flushPromises()

    expect(wrapper.find('.code-block').exists()).toBe(false)
    expect(wrapper.get('summary').text()).toBe('Show tool input')
  })

  it('renders an edit as a highlighted diff of the edited file', async () => {
    const wrapper = component = await mountSuspended(ToolInputBlock, {
      props: {
        tool: 'Edit',
        input: payload({
          file_path: 'app/utils/format.ts',
          old_string: 'const a = 1',
          new_string: 'const a = 2',
        }),
      },
    })
    await open(wrapper)

    expect(wrapper.get('.code-block-name').text()).toBe('app/utils/format.ts')
    expect(wrapper.get('.line-remove').text()).toBe('const a = 1')
    expect(wrapper.get('.line-add').text()).toBe('const a = 2')
  })

  it('renders a non-editing tool as its highlighted JSON payload', async () => {
    const input = payload({ command: 'pnpm test', description: 'Run tests' })
    const wrapper = component = await mountSuspended(ToolInputBlock, {
      props: { tool: 'Bash', input },
    })
    await open(wrapper)

    expect(wrapper.find('.line-add').exists()).toBe(false)
    expect(wrapper.get('.code-block-body').text()).toBe(input)
  })

  it('shows the raw payload when it was clipped mid-string', async () => {
    const clipped = payload({ file_path: 'a.ts', old_string: 'const a = 1' }).slice(0, 40)
    const wrapper = component = await mountSuspended(ToolInputBlock, {
      props: { tool: 'Edit', input: clipped },
    })
    await open(wrapper)

    expect(wrapper.get('.code-block-body').text()).toBe(clipped)
  })
})
