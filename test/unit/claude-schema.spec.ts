import { describe, expect, it } from 'vitest'
import {
  parseClaudeAssistantBlock,
  parseClaudeRecord,
  parseClaudeSubagentMeta,
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
        usage: { output_tokens: 12, futureUsageField: 3 },
      },
    })

    expect(parsed.success).toBe(true)
    if (!parsed.success || parsed.record.kind !== 'assistant') return
    expect(parsed.record.data.attributionSkill).toBe('frontend-design')
    expect(parsed.record.data.futureTopLevelField).toEqual({ enabled: true })
    expect(parsed.record.data.message.usage?.futureUsageField).toBe(3)
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
