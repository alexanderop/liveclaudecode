import { mountSuspended } from '@nuxt/test-utils/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RunHero from '~/components/RunHero.vue'
import { runNode } from '../fixtures/runs'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('RunHero', () => {
  it('offers a compact restore control when the sidebar is hidden', async () => {
    const component = await mountSuspended(RunHero, {
      props: {
        root: null,
        selected: null,
        fileCount: 0,
        transcriptPath: '',
        sidebarVisible: false,
        followActive: true,
      },
    })
    const showSidebar = component.get('button[aria-label="Show sidebar"]')

    expect(showSidebar.attributes('aria-keyshortcuts')).toBe('Meta+B Control+B')
    expect(component.get('.session-kicker').text()).toBe('Local session')
    expect(component.text()).not.toContain('Copilot session')
    await showSidebar.trigger('click')
    expect(component.emitted('showSidebar')).toEqual([[]])
  })

  it('shows the selected JSONL location and copies the full path', async () => {
    const transcriptPath = '/Users/me/.claude/projects/repo/session.jsonl'
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const root = runNode()
    const component = await mountSuspended(RunHero, {
      props: {
        root,
        selected: root,
        fileCount: 0,
        transcriptPath,
        sidebarVisible: true,
        followActive: false,
      },
    })

    expect(component.get('.transcript-location code').text()).toBe(transcriptPath)
    const copy = component.get('button[aria-label="Copy JSONL file path"]')
    await copy.trigger('click')

    expect(writeText).toHaveBeenCalledWith(transcriptPath)
    expect(copy.text()).toContain('Copied')
    expect(copy.attributes('aria-label')).toBe('JSONL file path copied')
  })
})
