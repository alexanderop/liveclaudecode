import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import EventFeed from '~/components/EventFeed.vue'
import { transcriptEvent } from '../fixtures/runs'

let component: VueWrapper | null = null

afterEach(() => {
  component?.unmount()
  component = null
})

describe('EventFeed', () => {
  it('renders assistant Markdown as formatted prose', async () => {
    const wrapper = component = await mountSuspended(EventFeed, {
      props: {
        events: [transcriptEvent('## Result\n\nThis is **ready**.\n\n- One\n- Two')],
        density: 'normal',
        errorsOnly: false,
        followOutput: false,
      },
    })
    await flushPromises()

    expect(wrapper.get('.markdown-body h2').text()).toBe('Result')
    expect(wrapper.get('.markdown-body strong').text()).toBe('ready')
    expect(wrapper.findAll('.markdown-body li').map(item => item.text())).toEqual(['One', 'Two'])
  })

  it('syntax highlights fenced code in assistant Markdown', async () => {
    const wrapper = component = await mountSuspended(EventFeed, {
      props: {
        events: [transcriptEvent('Here is the fix:\n\n```ts\nconst answer = 42\n```\n')],
        density: 'normal',
        errorsOnly: false,
        followOutput: false,
      },
    })
    await vi.waitFor(() => expect(wrapper.find('.markdown-body .code-block-body').exists()).toBe(true))

    const shiki = wrapper.get('.markdown-body .code-block-body pre')
    expect(shiki.classes()).toContain('shiki')
    expect(shiki.text()).toBe('const answer = 42')
    expect(shiki.findAll('span[style]').length).toBeGreaterThan(1)
  })

  it('renders a fence with no language as plain text', async () => {
    const wrapper = component = await mountSuspended(EventFeed, {
      props: {
        events: [transcriptEvent('```\njust some output\n```\n')],
        density: 'normal',
        errorsOnly: false,
        followOutput: false,
      },
    })
    await vi.waitFor(() => expect(wrapper.find('.markdown-body .code-block-body').exists()).toBe(true))

    expect(wrapper.get('.markdown-body .code-block-body').text()).toBe('just some output')
  })

  it('renders an edit tool call as a diff of the edited file', async () => {
    const wrapper = component = await mountSuspended(EventFeed, {
      props: {
        events: [transcriptEvent('', {
          kind: 'tool_use',
          tool: 'Edit',
          summary: 'app/utils/format.ts',
          input: JSON.stringify(
            { file_path: 'app/utils/format.ts', old_string: 'const a = 1', new_string: 'const a = 2' },
            null,
            2,
          ),
        })],
        density: 'normal',
        errorsOnly: false,
        followOutput: false,
      },
    })
    await flushPromises()

    const details = wrapper.get('details').element as HTMLDetailsElement
    details.open = true
    await wrapper.get('details').trigger('toggle')
    await vi.waitFor(() => expect(wrapper.find('.code-block-body').exists()).toBe(true))

    expect(wrapper.get('.line-remove').text()).toBe('const a = 1')
    expect(wrapper.get('.line-add').text()).toBe('const a = 2')
  })

  it('keeps dangerous Markdown links inert', async () => {
    const wrapper = component = await mountSuspended(EventFeed, {
      props: {
        events: [transcriptEvent('[unsafe](javascript:alert(1))')],
        density: 'normal',
        errorsOnly: false,
        followOutput: false,
      },
    })
    await flushPromises()

    expect(wrapper.find('.markdown-body a').exists()).toBe(false)
    expect(wrapper.get('.markdown-body').text()).toContain('[unsafe]')
  })

  it('does not route transcript file references through the dashboard', async () => {
    const wrapper = component = await mountSuspended(EventFeed, {
      props: {
        events: [transcriptEvent(
          '[local file](src/components/Panel.vue) [web page](https://example.com/docs) [section](#result)',
        )],
        density: 'normal',
        errorsOnly: false,
        followOutput: false,
      },
    })
    await flushPromises()

    const links = wrapper.findAll('.markdown-body a')
    expect(links.map(link => link.text())).toEqual(['web page', 'section'])
    expect(links[0]?.attributes()).toMatchObject({
      href: 'https://example.com/docs',
      target: '_blank',
      rel: 'noopener noreferrer',
    })
    expect(links[1]?.attributes('href')).toBe('#result')
    expect(wrapper.get('.markdown-inert-link').text()).toBe('local file')
  })

  it('explains when the error filter has no matching events', async () => {
    const wrapper = component = await mountSuspended(EventFeed, {
      props: {
        events: [transcriptEvent('Everything passed.')],
        density: 'normal',
        errorsOnly: true,
        followOutput: false,
      },
    })

    expect(wrapper.get('.feed-empty h2').text()).toBe('No errors found')
    expect(wrapper.get('.feed-empty').text()).toContain('no recorded error events')
    expect(wrapper.find('.event').exists()).toBe(false)
  })

  it('centers a selected transaction when the feed mounts after selection', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('feed')) {
        return { top: 100, bottom: 400, left: 0, right: 400, width: 400, height: 300, x: 0, y: 100, toJSON: () => ({}) }
      }
      if (this.dataset.eventLine === '2') {
        return { top: 600, bottom: 640, left: 0, right: 400, width: 400, height: 40, x: 0, y: 600, toJSON: () => ({}) }
      }
      return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }
    })
    const scrollSpy = vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(() => undefined)

    component = await mountSuspended(EventFeed, {
      props: {
        events: [transcriptEvent('First event'), transcriptEvent('Selected event', { line: 2 })],
        density: 'normal',
        errorsOnly: false,
        followOutput: false,
        selectedLine: 2,
      },
    })
    await flushPromises()

    expect(scrollSpy).toHaveBeenCalledWith({ top: 370, behavior: 'smooth' })
  })

  it('jumps to the newest activity when following is enabled', async () => {
    const wrapper = component = await mountSuspended(EventFeed, {
      props: {
        events: [transcriptEvent('First event')],
        density: 'normal',
        errorsOnly: false,
        followOutput: false,
      },
    })
    const feed = wrapper.get('.feed').element as HTMLElement
    Object.defineProperty(feed, 'scrollHeight', { configurable: true, value: 1_000 })

    feed.scrollTop = 100
    await wrapper.setProps({ followOutput: true })
    await flushPromises()
    expect(feed.scrollTop).toBe(1_000)
  })

  it('pauses following while the reader is scrolled up and resumes at the bottom', async () => {
    const wrapper = component = await mountSuspended(EventFeed, {
      props: {
        events: [transcriptEvent('First event')],
        density: 'normal',
        errorsOnly: false,
        followOutput: true,
      },
    })
    const feed = wrapper.get('.feed')
    const feedElement = feed.element as HTMLElement
    let scrollHeight = 1_000
    Object.defineProperty(feedElement, 'scrollHeight', { configurable: true, get: () => scrollHeight })
    Object.defineProperty(feedElement, 'clientHeight', { configurable: true, value: 300 })

    feedElement.scrollTop = 200
    await feed.trigger('scroll')
    await wrapper.setProps({ events: [transcriptEvent('First event'), transcriptEvent('Second event')] })
    await flushPromises()
    expect(feedElement.scrollTop).toBe(200)

    feedElement.scrollTop = 700
    await feed.trigger('scroll')
    scrollHeight = 1_200
    await wrapper.setProps({
      events: [transcriptEvent('First event'), transcriptEvent('Second event'), transcriptEvent('Newest event')],
    })
    await flushPromises()
    expect(feedElement.scrollTop).toBe(1_200)
  })

  it('treats a small gap from the bottom as still following', async () => {
    const wrapper = component = await mountSuspended(EventFeed, {
      props: {
        events: [transcriptEvent('First event')],
        density: 'normal',
        errorsOnly: false,
        followOutput: true,
      },
    })
    const feed = wrapper.get('.feed')
    const feedElement = feed.element as HTMLElement
    Object.defineProperty(feedElement, 'scrollHeight', { configurable: true, value: 1_000 })
    Object.defineProperty(feedElement, 'clientHeight', { configurable: true, value: 300 })

    feedElement.scrollTop = 680
    await feed.trigger('scroll')
    await wrapper.setProps({ events: [transcriptEvent('First event'), transcriptEvent('Newest event')] })
    await flushPromises()
    expect(feedElement.scrollTop).toBe(1_000)
  })

  it('identifies and opens the responsible agent in a session-wide stream', async () => {
    const wrapper = component = await mountSuspended(EventFeed, {
      props: {
        events: [transcriptEvent('Worker result', {
          agentKey: 'worker',
          agentLabel: 'Timeline audit',
          agentType: 'Explore',
        })],
        density: 'normal',
        errorsOnly: false,
        followOutput: false,
        sessionWide: true,
      },
    })

    expect(wrapper.get('.event-agent').text()).toContain('Timeline audit')
    await wrapper.get('.event-agent').trigger('click')
    expect(wrapper.emitted('select')).toEqual([['worker']])
  })

  it('keeps synthesized diagnostic incidents visible in the error filter', async () => {
    const wrapper = component = await mountSuspended(EventFeed, {
      props: {
        events: [transcriptEvent('The user denied this operation.', {
          role: 'system',
          kind: 'system',
          line: 7,
          summary: 'Permission denied',
          error: true,
        })],
        density: 'normal',
        errorsOnly: true,
        followOutput: false,
      },
    })

    expect(wrapper.get('.event').text()).toContain('Permission denied')
  })
})
