import { mountSuspended } from '@nuxt/test-utils/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RunHero from '~/components/RunHero.vue'
import { runNode } from '../fixtures/runs'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('RunHero', () => {
  it('offers the Nuxt UI system, light, and dark color-mode control', async () => {
    const component = await mountSuspended(RunHero, {
      props: {
        root: null,
        selected: null,
        fileCount: 0,
        transcriptPath: '',
        sidebarVisible: true,
        followActive: true,
      },
    })

    expect(component.get('[aria-label="Color mode"]').attributes('aria-label')).toBe('Color mode')
  })

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

  it('distinguishes a successful result with recovered tool errors from failure', async () => {
    const root = runNode({ finalText: 'The requested audit is complete.', errors: 2, subErrors: 2 })
    const component = await mountSuspended(RunHero, {
      props: {
        root,
        selected: root,
        fileCount: 0,
        transcriptPath: '',
        sidebarVisible: true,
        followActive: false,
      },
    })

    expect(component.get('.pill').text()).toContain('Complete with warnings')
    expect(component.get('.status-line').text()).toContain('completed with 2 recovered tool errors')
    expect(component.text()).not.toContain('Session ended with errors')
  })
})
