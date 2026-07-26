import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  commandOk,
  findMilestones,
  shortPath,
  toolSummary,
  TranscriptScan,
} from '#server/utils/transcript'
import * as fixture from '../fixtures/transcripts'

describe('TranscriptScan', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'liveclaudecode-transcript-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  async function scan(records: Record<string, unknown>[], trailingPartial = false) {
    const path = fixture.writeTranscript(join(directory, 's.jsonl'), records, { trailingPartial })
    return new TranscriptScan(path).refresh()
  }

  it('pairs a tool call with its result', async () => {
    const result = await scan([
      fixture.assistant([fixture.text('looking'), fixture.tool('Read', 't1', { file_path: '/repo/a.ts' })]),
      fixture.userResult('t1', '1\tconst a = 1'),
    ])
    expect(result.events.map(event => event.kind)).toEqual(['text', 'tool_use', 'tool_result'])
    expect(result.events[1]?.summary).toBe('/repo/a.ts')
    expect(result.events[2]?.tool).toBe('Read')
    expect(result.errors).toBe(0)
  })

  it('reports an unanswered tool as current activity', async () => {
    const result = await scan([
      fixture.assistant([fixture.tool('Bash', 't1', { command: 'pnpm test' })]),
    ])
    expect(result.currentActivity()).toMatchObject({ tool: 'Bash', summary: 'pnpm test' })
  })

  it('clears current activity when the result arrives', async () => {
    const result = await scan([
      fixture.assistant([fixture.tool('Bash', 't1', { command: 'pnpm test' })]),
      fixture.userResult('t1', 'ok'),
    ])
    expect(result.currentActivity()).toBeNull()
  })

  it('counts and marks error results', async () => {
    const result = await scan([
      fixture.assistant([fixture.tool('Bash', 't1', { command: 'nope' })]),
      fixture.userResult('t1', 'Error: command not found', { isError: true }),
    ])
    expect(result.errors).toBe(1)
    expect(result.events.at(-1)?.error).toBe(true)
  })

  it('distinguishes system reminders from real prompts', async () => {
    const result = await scan([
      fixture.userText('<system-reminder>hi</system-reminder>'),
      fixture.userText('please fix the build'),
    ])
    expect(result.events.map(event => event.kind)).toEqual(['meta', 'prompt'])
  })

  it('waits for a trailing partial line', async () => {
    const path = fixture.writeTranscript(
      join(directory, 's.jsonl'),
      [fixture.assistant([fixture.text('one')])],
      { trailingPartial: true },
    )
    const result = await new TranscriptScan(path).refresh()
    expect(result.events).toHaveLength(1)

    const body = (await readFile(path, 'utf8')).split('\n').slice(0, -1).join('\n') + '\n'
    await writeFile(path, body)
    fixture.appendRecords(path, [fixture.assistant([fixture.text('two')])])
    await result.refresh()
    expect(result.events.map(event => event.body)).toEqual(['one', 'two'])
  })

  it('only ingests newly appended complete lines', async () => {
    const path = fixture.writeTranscript(join(directory, 's.jsonl'), [fixture.assistant([fixture.text('one')])])
    const result = await new TranscriptScan(path).refresh()
    expect(result.line).toBe(1)
    fixture.appendRecords(path, [fixture.assistant([fixture.text('two')])])
    await result.refresh()
    expect(result.line).toBe(2)
    expect(result.events).toHaveLength(2)
  })

  it('skips malformed lines without failing the scan', async () => {
    const path = join(directory, 's.jsonl')
    await writeFile(path, '{"type":"assistant""broken"}\n')
    fixture.appendRecords(path, [fixture.assistant([fixture.text('fine')])])
    const result = await new TranscriptScan(path).refresh()
    expect(result.events.map(event => event.body)).toEqual(['fine'])
  })

  it('collects edits relative to the run cwd', async () => {
    const result = await scan([
      fixture.assistant([fixture.tool('Edit', 't1', { file_path: '/repo/src/a.ts' })]),
      fixture.userResult('t1', 'ok'),
      fixture.assistant([fixture.tool('Write', 't2', { file_path: '/repo/src/a.ts' })]),
      fixture.userResult('t2', 'ok'),
    ])
    expect(result.files.get('src/a.ts')).toMatchObject({ ops: 2, tools: ['Edit', 'Write'] })
  })

  it('does not count reads as file changes', async () => {
    const result = await scan([
      fixture.assistant([fixture.tool('Read', 't1', { file_path: '/repo/src/a.ts' })]),
    ])
    expect(result.files.size).toBe(0)
  })

  it('infers command outcomes from output', async () => {
    const result = await scan([
      fixture.assistant([fixture.tool('Bash', 't1', { command: 'pnpm test:unit' })]),
      fixture.userResult('t1', 'Test Files  3 passed (3)'),
      fixture.assistant([fixture.tool('Bash', 't2', { command: 'pnpm type-check' })]),
      fixture.userResult('t2', 'src/a.ts(3,1): error TS2345: bad'),
    ])
    expect(result.commands.map(command => command.ok)).toEqual([true, false])
  })

  it('leaves a running command without an outcome', async () => {
    const result = await scan([
      fixture.assistant([fixture.tool('Bash', 't1', { command: 'pnpm test' })]),
    ])
    expect(result.commands[0]?.ok).toBeNull()
  })

  it('records spawned agents and the latest todo state', async () => {
    const result = await scan([
      fixture.assistant([fixture.tool('Agent', 'spawn', { description: 'slice A' })]),
      fixture.assistant([fixture.tool('TodoWrite', 't1', { todos: [{ content: 'a', status: 'pending' }] })]),
      fixture.userResult('t1', 'ok'),
      fixture.assistant([fixture.tool('TodoWrite', 't2', { todos: [{ content: 'a', status: 'completed' }] })]),
    ])
    expect(result.spawnIds.has('spawn')).toBe(true)
    expect(result.todos).toEqual([{ content: 'a', status: 'completed' }])
  })

  it('accumulates output tokens', async () => {
    const result = await scan([
      fixture.assistant([fixture.text('a')], { usage: { output_tokens: 10 } }),
      fixture.assistant([fixture.text('b')], { usage: { output_tokens: 5 } }),
    ])
    expect(result.tokensOut).toBe(15)
  })

  it('collects native timing, context, compaction, and API diagnostics', async () => {
    const result = await scan([
      fixture.assistant([fixture.text('retrying')], {
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 20,
        },
        extra: { effort: 'high', requestId: 'req-1', isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429 },
      }),
      fixture.system('turn_duration', { durationMs: 12_000, messageCount: 3, pendingBackgroundAgentCount: 1 }),
      fixture.system('compact_boundary', {
        compactMetadata: {
          durationMs: 800,
          preTokens: 100_000,
          postTokens: 20_000,
          cumulativeDroppedTokens: 80_000,
          preservedMessages: 6,
          trigger: 'manual',
        },
      }),
    ])

    const diagnostics = result.diagnostics()
    expect(diagnostics.incidents[0]).toMatchObject({ category: 'api', severity: 'error', code: '429' })
    expect(diagnostics.turns[0]).toMatchObject({ durationMs: 12_000, messageCount: 3, pendingAgents: 1 })
    expect(diagnostics.context[0]).toMatchObject({
      effort: 'high',
      requestId: 'req-1',
      usage: { in: 10, out: 5, cr: 100, cw: 20 },
    })
    expect(diagnostics.compactions[0]).toMatchObject({ preTokens: 100_000, postTokens: 20_000, trigger: 'manual' })
  })

  it('captures explicit tool metadata, patches, git operations, and agent receipts', async () => {
    const result = await scan([
      fixture.assistant([fixture.tool('Edit', 'edit-1', { file_path: '/repo/src/a.ts' })]),
      fixture.userResult('edit-1', 'updated', {
        toolUseResult: {
          filePath: '/repo/src/a.ts',
          structuredPatch: [{ lines: ['-old', '+new', ' same'] }],
          staleRecovered: true,
        },
      }),
      fixture.assistant([fixture.tool('Bash', 'bash-1', { command: 'git push' })]),
      fixture.userResult('bash-1', 'done', {
        toolUseResult: {
          timedOutAfterMs: 30_000,
          gitOperation: { commit: { sha: 'abcdef123456' }, push: { branch: 'feature' } },
        },
      }),
      fixture.assistant([fixture.tool('Agent', 'agent-1', { description: 'worker' })]),
      fixture.userResult('agent-1', 'complete', {
        toolUseResult: {
          status: 'completed',
          resolvedModel: 'claude-sonnet-5',
          totalDurationMs: 5_000,
          totalTokens: 900,
          totalToolUseCount: 7,
          toolStats: { readCount: 2, editFileCount: 1, linesAdded: 4, linesRemoved: 1 },
        },
      }),
    ])

    const diagnostics = result.diagnostics()
    expect(diagnostics.changes[0]).toMatchObject({ path: 'src/a.ts', linesAdded: 1, linesRemoved: 1, staleRecovered: true })
    expect(diagnostics.git.map(event => event.kind)).toEqual(['commit', 'push'])
    expect(diagnostics.outcomes[0]).toMatchObject({ model: 'claude-sonnet-5', durationMs: 5_000, totalTokens: 900 })
    expect(diagnostics.incidents.map(incident => incident.category)).toEqual(['tool', 'timeout'])
  })

  it('surfaces hook, truncation, denial, and interruption incidents', async () => {
    const result = await scan([
      fixture.attachment('hook_non_blocking_error', { hookEvent: 'PostToolUse', hookName: 'lint', exitCode: 1, stderr: 'failed' }),
      fixture.attachment('read_truncation_notice', { toolUseID: 'read-1', banner: 'Only part of the file was returned' }),
      fixture.userText('denied', { ts: fixture.T0(3) }),
      {
        cwd: '/repo',
        type: 'user',
        timestamp: fixture.T0(4),
        toolDenialKind: 'permission-rule',
        interruptedMessageId: 'message-123',
        message: { content: [] },
      },
    ])

    expect(result.diagnostics().incidents.map(incident => incident.category))
      .toEqual(['hook', 'truncation', 'interruption', 'permission'])
  })
})

describe('transcript helpers', () => {
  it('prefers explicit wave markers over incidental headings', () => {
    expect(findMilestones('**Before**\n\n**Wave 2 — DI core**\n\n**After**'))
      .toEqual([['Wave 2 — DI core', true]])
  })

  it('recognizes strong and weak milestones', () => {
    expect(findMilestones('**Wave 1 (parallel slices):**')).toEqual([['Wave 1 (parallel slices)', true]])
    expect(findMilestones('**Rulings I folded in**')).toEqual([['Rulings I folded in', false]])
    expect(findMilestones('just some ordinary sentence')).toEqual([])
  })

  it('shortens paths relative to the run or to their tail', () => {
    expect(shortPath('/repo/src/a.ts', '/repo')).toBe('src/a.ts')
    expect(shortPath('/a/b/c/d/e.ts', '/other')).toBe('c/d/e.ts')
  })

  it('summarizes meaningful tool fields', () => {
    expect(toolSummary({ command: 'ls  -l' })).toBe('ls -l')
    expect(toolSummary({ file_path: '/a.ts' })).toBe('/a.ts')
  })

  it('does not mistake passing output containing error language for failure', () => {
    expect(commandOk('✓ 12 passed — no errors reported', false)).toBe(true)
    expect(commandOk('anything', true)).toBe(false)
  })
})
