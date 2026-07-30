import { assert, describe, it } from '@effect/vitest'
import {
  parseCopilotCliEvent,
  parseCopilotCliToolRequest,
} from '#shared/schemas/copilot-cli'
import * as fixture from '../fixtures/copilot-cli'

describe('Copilot CLI event schemas', () => {
  it('decodes session, message, model, tool, and turn records', () => {
    const session = parseCopilotCliEvent(fixture.sessionStart())
    assert.isTrue(session.success)
    if (!session.success || session.event.kind !== 'session.start') return
    assert.strictEqual(session.event.data.sessionId, 'session-1')
    assert.strictEqual(session.event.data.context?.cwd, '/repo')

    const assistant = parseCopilotCliEvent(fixture.assistantMessage({
      content: 'Done',
      reasoning: 'Checking',
      toolRequests: [fixture.toolRequest('bash', 'tool-1', { command: 'pnpm test' })],
    }))
    assert.isTrue(assistant.success)
    if (!assistant.success || assistant.event.kind !== 'assistant.message') return
    assert.strictEqual(assistant.event.data.reasoningText, 'Checking')
    assert.strictEqual(
      parseCopilotCliToolRequest(assistant.event.data.toolRequests?.[0])?.name,
      'bash',
    )
    assert.isTrue(parseCopilotCliEvent(fixture.modelChange()).success)
    assert.isTrue(parseCopilotCliEvent(fixture.toolStart('bash', 'tool-1', {})).success)
    assert.isTrue(parseCopilotCliEvent(fixture.toolComplete('tool-1', { success: true })).success)
    assert.isTrue(parseCopilotCliEvent(fixture.turnStart()).success)
    assert.isTrue(parseCopilotCliEvent(fixture.turnEnd()).success)
  })

  it('accepts error-only tool completions used by current Copilot CLI logs', () => {
    const parsed = parseCopilotCliEvent(fixture.toolComplete('tool-1', { error: { message: 'failed' } }))
    assert.isTrue(parsed.success)
    if (!parsed.success || parsed.event.kind !== 'tool.execution_complete') return
    assert.deepStrictEqual(parsed.event.data.error, { message: 'failed' })
  })

  it('tolerates unknown event types but rejects malformed known events', () => {
    assert.deepStrictEqual(parseCopilotCliEvent(fixture.event('future.event', { addedLater: true })), {
      success: true,
      event: { kind: 'unknown', timestamp: fixture.T0(), type: 'future.event' },
    })
    assert.deepStrictEqual(parseCopilotCliEvent(fixture.event('user.message', { content: 42 })), {
      success: false,
      known: true,
    })
    assert.deepStrictEqual(parseCopilotCliEvent({ type: 'user.message', data: {} }), {
      success: false,
      known: false,
    })
  })
})
