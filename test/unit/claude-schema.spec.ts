import { describe, expect, it } from 'vitest'
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

    expect(parsed.success).toBe(true)
    if (!parsed.success || parsed.record.kind !== 'assistant') return
    expect(parsed.record.data.attributionSkill).toBe('frontend-design')
    // The schema is lenient and preserves unknown fields at runtime, but they
    // are (intentionally) absent from the decoded static type.
    expect((parsed.record.data as unknown as Record<string, unknown>).futureTopLevelField)
      .toEqual({ enabled: true })
    expect((parsed.record.data.message.usage as Record<string, unknown> | undefined)?.futureUsageField)
      .toBe(3)
    expect(parsed.record.data.message.usage?.cache_creation).toEqual({
      ephemeral_5m_input_tokens: 4,
      ephemeral_1h_input_tokens: 8,
    })
    expect(parsed.record.data.message.usage?.server_tool_use?.web_search_requests).toBe(2)
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

    expect(parsed.success).toBe(true)
    if (!parsed.success || parsed.record.kind !== 'assistant') return
    expect(parsed.record.data.message.usage?.service_tier).toBe(null)
    expect(parsed.record.data.message.usage?.inference_geo).toBe(null)
    expect(parsed.record.data.message.usage?.speed).toBe(null)
  })

  it('rejects a malformed record of a known type', () => {
    const parsed = parseClaudeRecord({ type: 'assistant', message: { content: 42 } })
    expect(parsed.success).toBe(false)
  })

  it('preserves a future top-level record as an unknown envelope', () => {
    const parsed = parseClaudeRecord({
      type: 'future-session-event',
      payload: { anything: true },
    })

    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.record).toMatchObject({
      kind: 'unknown',
      data: { type: 'future-session-event', payload: { anything: true } },
    })
  })

  it('distinguishes known and future content blocks', () => {
    expect(parseClaudeAssistantBlock({
      type: 'tool_use',
      id: 'tool-1',
      name: 'Skill',
      input: { skill: 'documents' },
      caller: { type: 'direct' },
    })).toMatchObject({ kind: 'tool_use', data: { name: 'Skill' } })

    expect(parseClaudeAssistantBlock({
      type: 'future_assistant_block',
      payload: true,
    })).toMatchObject({ kind: 'unknown', data: { payload: true } })

    expect(parseClaudeUserBlock({
      type: 'tool_result',
      tool_use_id: 'tool-1',
      content: 'loaded',
      is_error: false,
    })).toMatchObject({ kind: 'tool_result', data: { tool_use_id: 'tool-1' } })
  })

  it('parses auxiliary session state and workflow journal records', () => {
    expect(parseClaudeRecord({
      type: 'permission-mode',
      sessionId: 'session-1',
      permissionMode: 'default',
    })).toMatchObject({ success: true, record: { kind: 'session_state' } })

    expect(parseClaudeRecord({
      type: 'started',
      agentId: 'worker-1',
      key: 'workflow-key',
    })).toMatchObject({ success: true, record: { kind: 'workflow_started' } })

    expect(parseClaudeRecord({
      type: 'result',
      agentId: 'worker-1',
      key: 'workflow-key',
      result: { status: 'accurate' },
    })).toMatchObject({ success: true, record: { kind: 'workflow_result' } })
  })

  it('parses an IDE diagnostics attachment', () => {
    expect(parseClaudeAttachment({
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
    })).toMatchObject({
      type: 'diagnostics',
      isNew: true,
      files: [{
        uri: 'file:///repo/server/api/run.get.ts',
        diagnostics: [{ severity: 'Error', code: '2552', range: { start: { line: 10 } } }],
      }],
    })
  })

  it('degrades a malformed diagnostic entry instead of rejecting the record', () => {
    const parsed = parseClaudeAttachment({
      type: 'diagnostics',
      files: [{ uri: 'file:///repo/a.ts', diagnostics: [{ severity: 42, range: 'nowhere' }] }],
    })

    expect(parsed).toMatchObject({ type: 'diagnostics' })
    if (!parsed || parsed.type !== 'diagnostics') return
    // The entry survives as an empty one; the file and the record are kept.
    expect(parsed.files?.[0]?.diagnostics).toEqual([{}])
  })

  it('parses hook success and budget attachments', () => {
    expect(parseClaudeAttachment({
      type: 'hook_success',
      hookName: 'SessionStart:startup',
      hookEvent: 'SessionStart',
      toolUseID: 'hook-1',
      exitCode: 0,
      durationMs: 54,
      command: 'node hook.mjs',
      stdout: 'context',
      stderr: '',
    })).toMatchObject({
      type: 'hook_success',
      hookName: 'SessionStart:startup',
      durationMs: 54,
    })

    expect(parseClaudeAttachment({
      type: 'budget_usd',
      used: 0.724246,
      total: 1.5,
      remaining: 0.775754,
    })).toMatchObject({ type: 'budget_usd', used: 0.724246, total: 1.5 })
  })

  it('parses the Bash fields of a tool-use result', () => {
    expect(parseClaudeToolUseResult({
      stdout: 'nothing here',
      stderr: '',
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
      returnCodeInterpretation: 'No matches found',
    })).toMatchObject({
      stdout: 'nothing here',
      interrupted: false,
      returnCodeInterpretation: 'No matches found',
    })

    // A field of the wrong type drops out rather than failing the payload.
    const lenient = parseClaudeToolUseResult({ stdout: 12, stderr: 'boom', interrupted: 'yes' })
    expect(lenient).toMatchObject({ stderr: 'boom' })
    expect(lenient?.stdout).toBeUndefined()
    expect(lenient?.interrupted).toBeUndefined()
  })

  it('validates subagent metadata while allowing future fields', () => {
    expect(parseClaudeSubagentMeta({
      agentType: 'implementation-worker',
      description: 'Implement parser',
      spawnDepth: 2,
      toolUseId: 'tool-1',
      parentAgentId: 'agent-parent',
      futureMeta: 'kept',
    })).toMatchObject({
      agentType: 'implementation-worker',
      spawnDepth: 2,
      futureMeta: 'kept',
    })

    expect(parseClaudeSubagentMeta({ description: 'Missing agent type' })).toBeNull()
    expect(parseClaudeSubagentMeta({ agentType: 'worker', spawnDepth: -1 })).toBeNull()
  })
})
