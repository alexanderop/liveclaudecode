import { assert, describe, it } from '@effect/vitest'
import {
  parseCopilotLogRecord,
  parseCopilotResponsePart,
  parseCopilotSnapshot,
} from '#shared/schemas/copilot'
import * as fixture from '../fixtures/copilot'

describe('Copilot schemas', () => {
  it('decodes version 3 snapshots and supported response parts', () => {
    const snapshot = parseCopilotSnapshot(fixture.snapshot({
      requests: [fixture.request('request-1', 'Ship it')],
    }))
    assert.strictEqual(snapshot?.version, 3)
    assert.strictEqual(snapshot?.requests[0]?.message.text, 'Ship it')
    assert.strictEqual(parseCopilotResponsePart(fixture.markdown('Done')).kind, 'markdown')
    assert.strictEqual(parseCopilotResponsePart(fixture.tool('run_in_terminal', 'tool-1')).kind, 'tool')
    assert.strictEqual(parseCopilotResponsePart(fixture.textEdit('/repo/src/a.ts')).kind, 'text_edit')
  })

  it('accepts current VS Code command line objects with optional display metadata', () => {
    const parsed = parseCopilotResponsePart(fixture.tool('run_in_terminal', 'tool-1', {
      command: {
        original: 'cd /repo && pnpm test',
        toolEdited: 'pnpm test',
        isSandboxWrapped: false,
      },
    }))
    assert.strictEqual(parsed.kind, 'tool')
  })

  it('treats unknown future records and response kinds as supported unknowns', () => {
    assert.deepStrictEqual(parseCopilotLogRecord(fixture.unknownRecord()), {
      success: true,
      record: { kind: 'unknown', recordKind: 99 },
    })
    assert.deepStrictEqual(parseCopilotResponsePart({ kind: 'futurePart', payload: {} }), {
      kind: 'unknown',
      type: 'futurePart',
    })
  })

  it('rejects malformed known records without accepting generic objects', () => {
    assert.deepStrictEqual(parseCopilotLogRecord({ kind: 2, k: 'not-a-path' }), {
      success: false,
      known: true,
    })
    assert.deepStrictEqual(parseCopilotLogRecord({ kind: 2, k: ['requests'], v: [], i: -1 }), {
      success: false,
      known: true,
    })
    assert.deepStrictEqual(parseCopilotLogRecord({ kind: 2, k: ['requests'], v: [], i: 1.5 }), {
      success: false,
      known: true,
    })
    assert.strictEqual(parseCopilotSnapshot({ version: 3 }), null)
  })
})
