import { assert, describe, it } from '@effect/vitest'
import {
  parseClaudeAssistantBlock,
  parseClaudeAttachment,
  parseClaudeRecord,
  parseClaudeSubagentMeta,
  parseClaudeToolUseResult,
  parseClaudeUserBlock,
} from '#shared/schemas/claude'

describe('Claude on-disk schemas', () => {
  it('parses an attributed assistant record and preserves new fields', () => {
    const parsed = parseClaudeRecord({
      type: 'assistant',
      timestamp: '2026-07-25T18:00:00.000Z',
      attributionSkill: 'frontend-design',
      futureTopLevelField: { enabled: true },
      message: {
        id: 'msg-1',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{
          type: 'tool_use',
          id: 'tool-1',
          name: 'FutureTool',
          input: { value: 1 },
        }],
        usage: {
          output_tokens: 12,
          cache_creation: {
            ephemeral_5m_input_tokens: 4,
            ephemeral_1h_input_tokens: 8,
          },
          server_tool_use: { web_search_requests: 2 },
          service_tier: 'standard',
          inference_geo: 'not_available',
          speed: 'standard',
          futureUsageField: 3,
        },
      },
    })

    assert.isTrue(parsed.success)
    if (!parsed.success || parsed.record.kind !== 'assistant') return
    assert.strictEqual(parsed.record.data.attributionSkill, 'frontend-design')
    // The schema is lenient and preserves unknown fields at runtime, but they
    // are (intentionally) absent from the decoded static type.
    assert.deepStrictEqual(
      (parsed.record.data as unknown as Record<string, unknown>).futureTopLevelField,
      { enabled: true },
    )
    assert.strictEqual(
      (parsed.record.data.message.usage as Record<string, unknown> | undefined)?.futureUsageField,
      3,
    )
    assert.deepStrictEqual(parsed.record.data.message.usage?.cache_creation, {
      ephemeral_5m_input_tokens: 4,
      ephemeral_1h_input_tokens: 8,
    })
    assert.strictEqual(parsed.record.data.message.usage?.server_tool_use?.web_search_requests, 2)
  })

  it('parses a synthetic assistant record with null usage descriptors', () => {
    const parsed = parseClaudeRecord({
      type: 'assistant',
      timestamp: '2026-07-29T20:06:01.280Z',
      message: {
        id: 'msg-synthetic',
        role: 'assistant',
        model: '<synthetic>',
        stop_reason: 'stop_sequence',
        content: [{ type: 'text', text: 'API Error' }],
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
          cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
          service_tier: null,
          inference_geo: null,
          iterations: null,
          speed: null,
        },
      },
    })

    assert.isTrue(parsed.success)
    if (!parsed.success || parsed.record.kind !== 'assistant') return
    assert.strictEqual(parsed.record.data.message.usage?.service_tier, null)
    assert.strictEqual(parsed.record.data.message.usage?.inference_geo, null)
    assert.strictEqual(parsed.record.data.message.usage?.speed, null)
  })

  it('rejects a malformed record of a known type', () => {
    const parsed = parseClaudeRecord({ type: 'assistant', message: { content: 42 } })
    assert.strictEqual(parsed.success, false)
  })

  it('preserves a future top-level record as an unknown envelope', () => {
    const parsed = parseClaudeRecord({
      type: 'future-session-event',
      payload: { anything: true },
    })

    assert.isTrue(parsed.success)
    if (!parsed.success || parsed.record.kind !== 'unknown') return
    assert.strictEqual(parsed.record.data.type, 'future-session-event')
    assert.deepStrictEqual(
      (parsed.record.data as unknown as Record<string, unknown>).payload,
      { anything: true },
    )
  })

  it('distinguishes known and future content blocks', () => {
    const toolUse = parseClaudeAssistantBlock({
      type: 'tool_use',
      id: 'tool-1',
      name: 'Skill',
      input: { skill: 'documents' },
      caller: { type: 'direct' },
    })
    assert.strictEqual(toolUse?.kind, 'tool_use')
    if (toolUse?.kind !== 'tool_use') return
    assert.strictEqual(toolUse.data.name, 'Skill')

    const future = parseClaudeAssistantBlock({
      type: 'future_assistant_block',
      payload: true,
    })
    assert.strictEqual(future?.kind, 'unknown')
    if (future?.kind !== 'unknown') return
    assert.strictEqual((future.data as unknown as Record<string, unknown>).payload, true)

    const toolResult = parseClaudeUserBlock({
      type: 'tool_result',
      tool_use_id: 'tool-1',
      content: 'loaded',
      is_error: false,
    })
    assert.strictEqual(toolResult?.kind, 'tool_result')
    if (toolResult?.kind !== 'tool_result') return
    assert.strictEqual(toolResult.data.tool_use_id, 'tool-1')
  })

  it('parses auxiliary session state and workflow journal records', () => {
    const sessionState = parseClaudeRecord({
      type: 'permission-mode',
      sessionId: 'session-1',
      permissionMode: 'default',
    })
    assert.isTrue(sessionState.success)
    assert.strictEqual(sessionState.success && sessionState.record.kind, 'session_state')

    const started = parseClaudeRecord({
      type: 'started',
      agentId: 'worker-1',
      key: 'workflow-key',
    })
    assert.isTrue(started.success)
    assert.strictEqual(started.success && started.record.kind, 'workflow_started')

    const result = parseClaudeRecord({
      type: 'result',
      agentId: 'worker-1',
      key: 'workflow-key',
      result: { status: 'accurate' },
    })
    assert.isTrue(result.success)
    assert.strictEqual(result.success && result.record.kind, 'workflow_result')
  })

  it('parses an IDE diagnostics attachment', () => {
    const parsed = parseClaudeAttachment({
      type: 'diagnostics',
      isNew: true,
      files: [{
        uri: 'file:///repo/server/api/run.get.ts',
        diagnostics: [{
          message: "Cannot find name 'runRequest'.",
          severity: 'Error',
          range: { start: { line: 10, character: 9 }, end: { line: 10, character: 19 } },
          source: 'ts',
          code: '2552',
        }],
      }],
    })

    assert.strictEqual(parsed?.type, 'diagnostics')
    if (parsed?.type !== 'diagnostics') return
    assert.strictEqual(parsed.isNew, true)
    const file = parsed.files?.[0]
    assert.strictEqual(file?.uri, 'file:///repo/server/api/run.get.ts')
    const diagnostic = file?.diagnostics?.[0]
    assert.strictEqual(diagnostic?.severity, 'Error')
    assert.strictEqual(diagnostic?.code, '2552')
    assert.strictEqual(diagnostic?.range?.start?.line, 10)
  })

  it('degrades a malformed diagnostic entry instead of rejecting the record', () => {
    const parsed = parseClaudeAttachment({
      type: 'diagnostics',
      files: [{ uri: 'file:///repo/a.ts', diagnostics: [{ severity: 42, range: 'nowhere' }] }],
    })

    assert.strictEqual(parsed?.type, 'diagnostics')
    if (parsed?.type !== 'diagnostics') return
    // The entry survives as an empty one; the file and the record are kept.
    assert.deepStrictEqual(parsed.files?.[0]?.diagnostics, [{}])
  })

  it('parses hook success and budget attachments', () => {
    const hook = parseClaudeAttachment({
      type: 'hook_success',
      hookName: 'SessionStart:startup',
      hookEvent: 'SessionStart',
      toolUseID: 'hook-1',
      exitCode: 0,
      durationMs: 54,
      command: 'node hook.mjs',
      stdout: 'context',
      stderr: '',
    })
    assert.strictEqual(hook?.type, 'hook_success')
    if (hook?.type !== 'hook_success') return
    assert.strictEqual(hook.hookName, 'SessionStart:startup')
    assert.strictEqual(hook.durationMs, 54)

    const budget = parseClaudeAttachment({
      type: 'budget_usd',
      used: 0.724246,
      total: 1.5,
      remaining: 0.775754,
    })
    assert.strictEqual(budget?.type, 'budget_usd')
    if (budget?.type !== 'budget_usd') return
    assert.strictEqual(budget.used, 0.724246)
    assert.strictEqual(budget.total, 1.5)
  })

  it('parses the Bash fields of a tool-use result', () => {
    const parsed = parseClaudeToolUseResult({
      stdout: 'nothing here',
      stderr: '',
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
      returnCodeInterpretation: 'No matches found',
    })
    assert.strictEqual(parsed?.stdout, 'nothing here')
    assert.strictEqual(parsed?.interrupted, false)
    assert.strictEqual(parsed?.returnCodeInterpretation, 'No matches found')

    // A field of the wrong type drops out rather than failing the payload.
    const lenient = parseClaudeToolUseResult({ stdout: 12, stderr: 'boom', interrupted: 'yes' })
    assert.strictEqual(lenient?.stderr, 'boom')
    assert.isUndefined(lenient?.stdout)
    assert.isUndefined(lenient?.interrupted)
  })

  it('validates subagent metadata while allowing future fields', () => {
    const parsed = parseClaudeSubagentMeta({
      agentType: 'implementation-worker',
      description: 'Implement parser',
      spawnDepth: 2,
      toolUseId: 'tool-1',
      parentAgentId: 'agent-parent',
      futureMeta: 'kept',
    })
    assert.strictEqual(parsed?.agentType, 'implementation-worker')
    assert.strictEqual(parsed?.spawnDepth, 2)
    assert.strictEqual((parsed as unknown as Record<string, unknown> | null)?.futureMeta, 'kept')

    assert.isNull(parseClaudeSubagentMeta({ description: 'Missing agent type' }))
    assert.isNull(parseClaudeSubagentMeta({ agentType: 'worker', spawnDepth: -1 }))
  })
})
