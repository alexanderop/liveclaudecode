import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import DebugPage from '~/pages/debug.vue'
import { parseHealthResponse, sessionParseHealth } from '../fixtures/runs'

let component: VueWrapper | null = null
let response = parseHealthResponse()

registerEndpoint('/api/debug', () => response)

afterEach(() => {
  component?.unmount()
  component = null
  response = parseHealthResponse()
})

describe('debug page', () => {
  it('splits the tally by cause so the reader knows who can fix it', async () => {
    response = parseHealthResponse([
      sessionParseHealth({ counts: { invalidJson: 4, schemaMismatch: 0, unsupportedShape: 0 } }),
      sessionParseHealth({
        key: 'other',
        label: 'Codex run',
        source: 'codex',
        counts: { invalidJson: 0, schemaMismatch: 9, unsupportedShape: 2 },
      }),
    ])
    const wrapper = component = await mountSuspended(DebugPage)

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
    const wrapper = component = await mountSuspended(DebugPage)

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
  })

  it('says how many skipped records went unsampled', async () => {
    response = parseHealthResponse([
      sessionParseHealth({ counts: { invalidJson: 0, schemaMismatch: 30, unsupportedShape: 0 } }),
    ])
    const wrapper = component = await mountSuspended(DebugPage)
    await wrapper.get('.session-head').trigger('click')

    expect(wrapper.get('.issue-more').text()).toContain('29 further skipped records not sampled')
  })

  it('confirms a clean scan rather than showing an empty table', async () => {
    response = parseHealthResponse([])
    const wrapper = component = await mountSuspended(DebugPage)

    expect(wrapper.text()).toContain('Every record parsed cleanly')
    expect(wrapper.find('.session-list').exists()).toBe(false)
    expect(wrapper.find('.reason-legend').exists()).toBe(false)
  })
})
