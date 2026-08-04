import { assert, describe, it } from '@effect/vitest'
import { Result } from 'effect'
import {
  parseInboundMessage,
  parseInitializeResult,
  parseNewSessionResult,
  parsePermissionRequest,
  parsePromptResult,
  parseSessionNotification,
} from '#shared/schemas/acp'

describe('ACP inbound messages', () => {
  it('keeps the three dispatch shapes distinguishable', () => {
    const request = parseInboundMessage({
      jsonrpc: '2.0',
      id: 7,
      method: 'session/request_permission',
      params: { sessionId: 'session-1' },
    })
    assert.isTrue(Result.isSuccess(request))
    if (!Result.isSuccess(request)) return
    assert.strictEqual(request.success.id, 7)
    assert.strictEqual(request.success.method, 'session/request_permission')

    const notification = parseInboundMessage({ jsonrpc: '2.0', method: 'session/update', params: {} })
    assert.isTrue(Result.isSuccess(notification))
    if (!Result.isSuccess(notification)) return
    assert.isUndefined(notification.success.id)

    const response = parseInboundMessage({ jsonrpc: '2.0', id: 7, result: { stopReason: 'end_turn' } })
    assert.isTrue(Result.isSuccess(response))
    if (!Result.isSuccess(response)) return
    assert.isUndefined(response.success.method)
  })

  it('accepts a numeric id echoed back as its string spelling', () => {
    const parsed = parseInboundMessage({ jsonrpc: '2.0', id: '7', result: null })
    assert.isTrue(Result.isSuccess(parsed))
    if (!Result.isSuccess(parsed)) return
    assert.strictEqual(parsed.success.id, '7')
  })

  it('reads a JSON-RPC error with either field missing', () => {
    const full = parseInboundMessage({ id: 1, error: { code: -32601, message: 'Method not found' } })
    assert.isTrue(Result.isSuccess(full))
    if (!Result.isSuccess(full)) return
    assert.strictEqual(full.success.error?.message, 'Method not found')
    assert.strictEqual(full.success.error?.code, -32601)

    const codeOnly = parseInboundMessage({ id: 1, error: { code: -32000 } })
    assert.isTrue(Result.isSuccess(codeOnly))
    if (!Result.isSuccess(codeOnly)) return
    assert.isUndefined(codeOnly.success.error?.message)
  })

  it('rejects a line whose typed fields are the wrong shape', () => {
    assert.isTrue(Result.isFailure(parseInboundMessage({ method: 42 })))
    assert.isTrue(Result.isFailure(parseInboundMessage({ id: { nested: true } })))
    assert.isTrue(Result.isFailure(parseInboundMessage({ error: 'boom' })))
    assert.isTrue(Result.isFailure(parseInboundMessage('not an object')))
    assert.isTrue(Result.isFailure(parseInboundMessage(null)))
  })
})

describe('ACP request results', () => {
  it('decodes the results of the three requests the connection sends', () => {
    const initialize = parseInitializeResult({ protocolVersion: 1, agentCapabilities: { future: true } })
    assert.isTrue(Result.isSuccess(initialize))
    if (!Result.isSuccess(initialize)) return
    assert.strictEqual(initialize.success.protocolVersion, 1)

    const session = parseNewSessionResult({ sessionId: 'session-1', modes: { current: 'agent' } })
    assert.isTrue(Result.isSuccess(session))
    if (!Result.isSuccess(session)) return
    assert.strictEqual(session.success.sessionId, 'session-1')

    const prompt = parsePromptResult({ stopReason: 'end_turn' })
    assert.isTrue(Result.isSuccess(prompt))
    if (!Result.isSuccess(prompt)) return
    assert.strictEqual(prompt.success.stopReason, 'end_turn')
  })

  it('fails when a required field is absent or mistyped', () => {
    // A non-finite protocol version is exactly what a JSON `null` decodes to.
    assert.isTrue(Result.isFailure(parseInitializeResult({ protocolVersion: null })))
    assert.isTrue(Result.isFailure(parseInitializeResult({})))
    assert.isTrue(Result.isFailure(parseNewSessionResult({ sessionId: 42 })))
    assert.isTrue(Result.isFailure(parsePromptResult({})))
  })
})

describe('ACP permission requests', () => {
  it('decodes options and the optional tool call', () => {
    const parsed = parsePermissionRequest({
      sessionId: 'session-1',
      toolCall: { toolCallId: 'call-1', title: 'Edit file', kind: 'edit' },
      options: [
        { optionId: 'a', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'r', kind: 'reject_once' },
      ],
    })

    assert.isTrue(Result.isSuccess(parsed))
    if (!Result.isSuccess(parsed)) return
    assert.strictEqual(parsed.success.toolCall?.title, 'Edit file')
    assert.deepStrictEqual(parsed.success.options.map(option => option.kind), [
      'allow_once',
      'reject_once',
    ])
    assert.isUndefined(parsed.success.options[1]?.name)
  })

  it('accepts an empty option list, which the connection answers as cancelled', () => {
    const parsed = parsePermissionRequest({ sessionId: 'session-1', options: [] })
    assert.isTrue(Result.isSuccess(parsed))
    if (!Result.isSuccess(parsed)) return
    assert.strictEqual(parsed.success.options.length, 0)
  })

  it('fails when the request cannot be answered at all', () => {
    assert.isTrue(Result.isFailure(parsePermissionRequest({ sessionId: 'session-1' })))
    assert.isTrue(Result.isFailure(parsePermissionRequest({ options: [] })))
    // An option without an id names nothing the client could select.
    assert.isTrue(Result.isFailure(parsePermissionRequest({
      sessionId: 'session-1',
      options: [{ kind: 'allow_once' }],
    })))
  })
})

describe('ACP session notifications', () => {
  it('decodes each known update variant under its own tag', () => {
    for (const variant of ['agent_message_chunk', 'agent_thought_chunk', 'user_message_chunk']) {
      const parsed = parseSessionNotification({
        sessionId: 'session-1',
        update: { sessionUpdate: variant, content: { type: 'text', text: 'Hello' } },
      })
      assert.isTrue(Result.isSuccess(parsed))
      if (!Result.isSuccess(parsed)) return
      assert.strictEqual(parsed.success.update.kind, 'known')
      if (parsed.success.update.kind !== 'known') return
      const update = parsed.success.update.data
      assert.strictEqual(update.sessionUpdate, variant)
      if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') return
      assert.strictEqual(update.content.text, 'Hello')
    }

    const toolCall = parseSessionNotification({
      sessionId: 'session-1',
      update: { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Read', status: 'pending' },
    })
    assert.isTrue(Result.isSuccess(toolCall))
    if (!Result.isSuccess(toolCall) || toolCall.success.update.kind !== 'known') return
    const update = toolCall.success.update.data
    assert.strictEqual(update.sessionUpdate, 'tool_call')
    if (update.sessionUpdate !== 'tool_call') return
    assert.strictEqual(update.toolCallId, 'call-1')
    assert.strictEqual(update.status, 'pending')
  })

  it('keeps a content block with no text, which chat treats as nothing to append', () => {
    const parsed = parseSessionNotification({
      sessionId: 'session-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image' } },
    })
    assert.isTrue(Result.isSuccess(parsed))
    if (!Result.isSuccess(parsed) || parsed.success.update.kind !== 'known') return
    const update = parsed.success.update.data
    if (update.sessionUpdate !== 'agent_message_chunk') return
    assert.isUndefined(update.content.text)
  })

  it('degrades an update variant it does not model yet instead of failing', () => {
    const parsed = parseSessionNotification({
      sessionId: 'session-1',
      update: { sessionUpdate: 'plan', entries: [{ content: 'Ship it' }] },
    })

    assert.isTrue(Result.isSuccess(parsed))
    if (!Result.isSuccess(parsed)) return
    assert.strictEqual(parsed.success.sessionId, 'session-1')
    assert.strictEqual(parsed.success.update.kind, 'unknown')
    if (parsed.success.update.kind !== 'unknown') return
    assert.strictEqual(parsed.success.update.data.sessionUpdate, 'plan')
  })

  it('fails a malformed *known* variant rather than degrading it to unknown', () => {
    // The tag is one we model, so a bad payload is a real decode failure — not
    // a future variant to pass through.
    const parsed = parseSessionNotification({
      sessionId: 'session-1',
      update: { sessionUpdate: 'agent_message_chunk', content: 42 },
    })
    assert.isTrue(Result.isFailure(parsed))
  })

  it('fails when the envelope itself is unusable', () => {
    assert.isTrue(Result.isFailure(parseSessionNotification({ update: { sessionUpdate: 'plan' } })))
    assert.isTrue(Result.isFailure(parseSessionNotification({ sessionId: 'session-1' })))
    assert.isTrue(Result.isFailure(parseSessionNotification({
      sessionId: 'session-1',
      update: { sessionUpdate: 42 },
    })))
    assert.isTrue(Result.isFailure(parseSessionNotification(null)))
  })
})
