import { assert, describe, it } from '@effect/vitest'
import type { DiagnosticIncident, TranscriptEvent } from '#shared/types/run'
import { mergeActivityEvents } from '~/utils/activity-feed'
import { transcriptEvent } from '../fixtures/runs'

function event(overrides: Partial<TranscriptEvent> = {}): TranscriptEvent {
  return transcriptEvent('body', {
    ts: '2026-07-25T18:00:00.000Z',
    agentKey: 'session',
    agentLabel: 'Main',
    agentType: 'Main session',
    ...overrides,
  })
}

function incident(overrides: Partial<DiagnosticIncident> = {}): DiagnosticIncident {
  return {
    id: 'incident-1',
    severity: 'error',
    category: 'tool',
    title: 'Tool failed',
    detail: 'The command exited non-zero.',
    ts: '2026-07-25T18:01:00.000Z',
    line: 9,
    key: 'session/worker',
    ...overrides,
  }
}

const agents = [
  { key: 'session', label: 'Main', agentType: '' },
  { key: 'session/worker', label: 'Worker', agentType: 'Explore' },
]

describe('mergeActivityEvents', () => {
  it('synthesizes labeled system events for unmatched warning and error incidents', () => {
    const merged = mergeActivityEvents({
      base: [event({ line: 1 })],
      incidents: [
        incident(),
        incident({ id: 'info', severity: 'info', line: 20 }),
      ],
      agents,
    })

    assert.deepStrictEqual(merged.map(item => item.line), [1, 9])
    assert.deepStrictEqual(merged[1], {
      role: 'system',
      kind: 'system',
      ts: '2026-07-25T18:01:00.000Z',
      line: 9,
      body: 'The command exited non-zero.',
      summary: 'Tool failed',
      tool: undefined,
      error: true,
      agentKey: 'session/worker',
      agentLabel: 'Worker',
      agentType: 'Explore',
    })
  })

  it('drops incidents whose error event already exists at the same agent and line', () => {
    const merged = mergeActivityEvents({
      base: [event({ line: 9, agentKey: 'session/worker', error: true })],
      incidents: [incident({ line: 9 })],
      agents,
    })

    assert.strictEqual(merged.length, 1)
    assert.strictEqual(merged[0]!.kind, 'text')
  })

  it('filters by agent and sorts by timestamp with the line as tiebreaker', () => {
    const merged = mergeActivityEvents({
      base: [
        event({ line: 5, ts: '2026-07-25T18:02:00.000Z', agentKey: 'session/worker' }),
        event({ line: 3, ts: '2026-07-25T18:02:00.000Z', agentKey: 'session/worker' }),
        event({ line: 2, ts: '2026-07-25T18:03:00.000Z', agentKey: 'session' }),
      ],
      incidents: [incident({ line: 9, ts: '2026-07-25T18:01:00.000Z' })],
      agents,
      agentKey: 'session/worker',
    })

    assert.deepStrictEqual(merged.map(item => item.line), [9, 3, 5])
    assert.strictEqual(merged.every(item => item.agentKey === 'session/worker'), true)
  })

  it('labels incidents without a known agent using who or a session fallback', () => {
    const [unknownAgent] = mergeActivityEvents({
      base: [],
      incidents: [incident({ key: 'ghost', who: 'compactor' })],
      agents,
    })
    const [anonymous] = mergeActivityEvents({
      base: [],
      incidents: [incident({ key: undefined, who: undefined })],
      agents,
    })

    assert.strictEqual(unknownAgent!.agentLabel, 'compactor')
    assert.strictEqual(unknownAgent!.agentType, 'Diagnostic incident')
    assert.strictEqual(anonymous!.agentLabel, 'Session')
  })
})
