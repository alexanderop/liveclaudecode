import { Effect } from 'effect'
import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ParseHealthResponse } from '#shared/types/run'
import DebugPage from '~/pages/debug.vue'
import { mountWithAtoms, type MountedAtoms } from '../fixtures/mount-atoms'
import { parseHealthResponse, sessionParseHealth } from '../fixtures/runs'

let mounted: MountedAtoms | null = null

afterEach(() => {
  mounted?.wrapper.unmount()
  mounted?.registry.dispose()
  mounted = null
})

/**
 * Mounts the page against a stub `Api` rather than `registerEndpoint`.
 *
 * The page reads an atom now, so the seam is the service: an endpoint the test
 * does not script is a named defect instead of a plausible default, and the
 * request never has to be matched by URL.
 */
async function mountDebug(response: ParseHealthResponse = parseHealthResponse()) {
  mounted = await mountWithAtoms(DebugPage, {
    api: { parseHealth: () => Effect.succeed(response) },
  })
  // The atom's poll runs in a forked fiber; one flush is what lets its first
  // value reach the render.
  await flushPromises()
  return mounted.wrapper
}

describe('debug page', () => {
  it('splits the tally by cause so the reader knows who can fix it', async () => {
    const wrapper = await mountDebug(parseHealthResponse([
      sessionParseHealth({ counts: { invalidJson: 4, schemaMismatch: 0, unsupportedShape: 0 } }),
      sessionParseHealth({
        key: 'other',
        label: 'Codex run',
        source: 'codex',
        counts: { invalidJson: 0, schemaMismatch: 9, unsupportedShape: 2 },
      }),
    ]))

    const summary = wrapper.get('.summary-grid').text()
    expect(summary).toContain('15')
    expect(summary).toContain('Unreadable lines')
    expect(summary).toContain('Shapes we do not model')
    // Every cause present is explained, including who is expected to act.
    expect(wrapper.findAll('.reason-legend li')).toHaveLength(3)
    const legend = wrapper.get('.reason-legend').text()
    expect(legend).toContain('damaged transcript file')
    expect(legend).toContain('liveclaudecode has not caught up')

    // Server order is preserved; ranking is the endpoint's contract.
    const names = wrapper.findAll('.session-name strong').map(item => item.text())
    expect(names).toEqual(['Ship the dashboard', 'Codex run'])
  })

  it('reveals the file, line, reason, and excerpt for a session on demand', async () => {
    const wrapper = await mountDebug()

    expect(wrapper.find('.session-body').exists()).toBe(false)
    await wrapper.get('.session-head').trigger('click')

    const body = wrapper.get('.session-body')
    expect(body.text()).toContain('/claude/projects/repo/session.jsonl')
    expect(body.text()).toContain('Unexpected shape')
    expect(body.text()).toContain('assistant')
    // Lines are shown one-based, as an editor addresses them.
    expect(body.get('.issue-location').text()).toContain('line 412')
    expect(body.get('.issue-detail').text()).toContain('Missing key')
    expect(body.get('.issue-excerpt').text()).toContain('"type":"assistant"')

    // The excerpt is a raw record, so it is highlighted as JSON to be read at a glance.
    await vi.waitFor(() => expect(body.find('.issue-excerpt .code-block-body').exists()).toBe(true))
    expect(body.get('.issue-excerpt .code-block-body pre').classes()).toContain('shiki')
    expect(body.findAll('.issue-excerpt .code-block-body span[style]').length).toBeGreaterThan(1)
  })

  it('says how many skipped records went unsampled', async () => {
    const wrapper = await mountDebug(parseHealthResponse([
      sessionParseHealth({ counts: { invalidJson: 0, schemaMismatch: 30, unsupportedShape: 0 } }),
    ]))
    await wrapper.get('.session-head').trigger('click')

    expect(wrapper.get('.issue-more').text()).toContain('29 further skipped records not sampled')
  })

  it('confirms a clean scan rather than showing an empty table', async () => {
    const wrapper = await mountDebug(parseHealthResponse([]))

    expect(wrapper.text()).toContain('Every record parsed cleanly')
    expect(wrapper.find('.session-list').exists()).toBe(false)
    expect(wrapper.find('.reason-legend').exists()).toBe(false)
  })
})
