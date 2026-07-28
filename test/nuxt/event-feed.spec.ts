import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import EventFeed from '~/components/EventFeed.vue'
import type { TranscriptEvent } from '#shared/types/run'

function textEvent(body: string): TranscriptEvent {
  return {
    role: 'assistant',
    kind: 'text',
    ts: '2026-07-25T18:00:00.000Z',
    line: 1,
    body,
  }
}

describe('EventFeed', () => {
  it('renders assistant Markdown as formatted prose', async () => {
    const component = await mountSuspended(EventFeed, {
      props: {
        events: [textEvent('## Result\n\nThis is **ready**.\n\n- One\n- Two')],
        density: 'normal',
        errorsOnly: false,
        followOutput: false,
      },
    })
    await flushPromises()

    expect(component.get('.markdown-body h2').text()).toBe('Result')
    expect(component.get('.markdown-body strong').text()).toBe('ready')
    expect(component.findAll('.markdown-body li').map(item => item.text())).toEqual(['One', 'Two'])
  })

  it('keeps dangerous Markdown links inert', async () => {
    const component = await mountSuspended(EventFeed, {
      props: {
        events: [textEvent('[unsafe](javascript:alert(1))')],
        density: 'normal',
        errorsOnly: false,
        followOutput: false,
      },
    })
    await flushPromises()

    expect(component.find('.markdown-body a').exists()).toBe(false)
    expect(component.get('.markdown-body').text()).toContain('[unsafe]')
  })

  it('does not route transcript file references through the dashboard', async () => {
    const component = await mountSuspended(EventFeed, {
      props: {
        events: [textEvent(
          '[local file](src/components/Panel.vue) [web page](https://example.com/docs) [section](#result)',
        )],
        density: 'normal',
        errorsOnly: false,
        followOutput: false,
      },
    })
    await flushPromises()

    const links = component.findAll('.markdown-body a')
    expect(links.map(link => link.text())).toEqual(['web page', 'section'])
    expect(links[0]?.attributes()).toMatchObject({
      href: 'https://example.com/docs',
      target: '_blank',
      rel: 'noopener noreferrer',
    })
    expect(links[1]?.attributes('href')).toBe('#result')
    expect(component.get('.markdown-inert-link').text()).toBe('local file')
  })

  it('explains when the error filter has no matching events', async () => {
    const component = await mountSuspended(EventFeed, {
      props: {
        events: [textEvent('Everything passed.')],
        density: 'normal',
        errorsOnly: true,
        followOutput: false,
      },
    })

    expect(component.get('.feed-empty h2').text()).toBe('No errors found')
    expect(component.get('.feed-empty').text()).toContain('no recorded error events')
    expect(component.find('.event').exists()).toBe(false)
  })

  it('jumps to and follows the newest activity when following is enabled', async () => {
    const component = await mountSuspended(EventFeed, {
      props: {
        events: [textEvent('First event')],
        density: 'normal',
        errorsOnly: false,
        followOutput: false,
      },
    })
    const feed = component.get('.feed').element as HTMLElement
    Object.defineProperty(feed, 'scrollHeight', { configurable: true, value: 1_000 })

    feed.scrollTop = 100
    await component.setProps({ followOutput: true })
    await flushPromises()
    expect(feed.scrollTop).toBe(1_000)

    feed.scrollTop = 200
    await component.setProps({ events: [textEvent('First event'), textEvent('Newest event')] })
    await flushPromises()
    expect(feed.scrollTop).toBe(1_000)
  })
})
