import { assert, describe, it } from '@effect/vitest'
import {
  parseCodexRecord,
  parseCodexSessionSource,
  parseCodexTextContent,
} from '#shared/schemas/codex'
import * as fixture from '../fixtures/codex'

describe('Codex rollout schemas', () => {
  it('decodes session metadata and structured subagent sources', () => {
    const parsed = parseCodexRecord(fixture.sessionMeta('parent', {
      cwd: '/repo',
      source: fixture.subagentSource('root', { nickname: 'Ada', role: 'worker' }),
    }))
    assert.isTrue(parsed.success)
    if (!parsed.success || parsed.record.kind !== 'session_meta') return
    assert.strictEqual(parsed.record.data.id, 'parent')
    assert.strictEqual(parsed.record.data.cwd, '/repo')

    const source = parseCodexSessionSource(parsed.record.data.source)
    assert.isNotNull(source)
    if (!source || typeof source === 'string' || typeof source.subagent === 'string') return
    assert.strictEqual(source.subagent.thread_spawn.parent_thread_id, 'root')
    assert.strictEqual(source.subagent.thread_spawn.agent_nickname, 'Ada')
  })

  it('decodes known response items and text blocks', () => {
    const parsed = parseCodexRecord(fixture.message('assistant', 'Finished'))
    assert.isTrue(parsed.success)
    if (!parsed.success || parsed.record.kind !== 'response_item') return
    assert.strictEqual(parsed.record.data.type, 'message')
    if (parsed.record.data.type !== 'message') return
    const content = parseCodexTextContent(parsed.record.data.content[0])
    assert.deepStrictEqual(content, { type: 'output_text', text: 'Finished' })
  })

  it('keeps unknown event types supportable without accepting malformed known events', () => {
    const unknown = parseCodexRecord(fixture.event('future_event', { added_later: true }))
    assert.isTrue(unknown.success)
    if (unknown.success && unknown.record.kind === 'event_msg') {
      assert.strictEqual(unknown.record.known, false)
      assert.strictEqual(unknown.record.data.type, 'future_event')
    }

    const malformed = parseCodexRecord({
      timestamp: fixture.C0(),
      type: 'event_msg',
      payload: { type: 'agent_message', message: 42 },
    })
    assert.deepStrictEqual(malformed, { success: false, known: true })
  })

  it('keeps unknown response item types supportable without accepting malformed known items', () => {
    const unknown = parseCodexRecord({
      timestamp: fixture.C0(),
      type: 'response_item',
      payload: { type: 'future_tool_call', added_later: true },
    })
    assert.deepStrictEqual(unknown, {
      success: true,
      record: {
        kind: 'unknown',
        timestamp: fixture.C0(),
        type: 'response_item:future_tool_call',
      },
    })

    const malformed = parseCodexRecord({
      timestamp: fixture.C0(),
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: 'not-an-array' },
    })
    assert.deepStrictEqual(malformed, { success: false, known: true })
  })

  it('rejects records without a valid outer envelope', () => {
    assert.deepStrictEqual(parseCodexRecord({ payload: {} }), { success: false, known: false })
  })
})
