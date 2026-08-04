import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { FastCheck, TestClock } from 'effect/testing'
import {
  clip,
  commandOk,
  commandOutcome,
  findMilestones,
  MAX_CHARS,
  shortPath,
  toolSummary,
} from '#server/utils/transcript-content'
import { EDIT_TOOLS, TranscriptScan } from '#server/utils/transcript'
import * as fixture from '../fixtures/transcripts'
import { makeCallLog } from '../fixtures/call-log'
import { testFileSystem, type FakeTree } from '../fixtures/filesystem'

const PATH = '/p/s.jsonl'

/** Build a scan over an in-memory transcript. No temp directories involved. */
const scanOf = (records: Record<string, unknown>[], options: {
  trailingPartial?: boolean
  mtime?: number
} = {}) => {
  const tree: FakeTree = {
    [PATH]: { content: fixture.transcript(records, options), mtime: options.mtime },
  }
  return new TranscriptScan(PATH).refresh().pipe(Effect.provide(testFileSystem(tree)))
}

describe('TranscriptScan', () => {
  it.effect('pairs a tool call with its result', () =>
    Effect.gen(function*() {
      const result = yield* scanOf([
        fixture.assistant([fixture.text('looking'), fixture.tool('Read', 't1', { file_path: '/repo/a.ts' })]),
        fixture.userResult('t1', '1\tconst a = 1'),
      ])
      assert.deepStrictEqual(result.events.map(event => event.kind), ['text', 'tool_use', 'tool_result'])
      assert.strictEqual(result.events[1]?.summary, '/repo/a.ts')
      assert.strictEqual(result.events[2]?.tool, 'Read')
      assert.strictEqual(result.errors, 0)
    }))

  it.effect('reports an unanswered tool as current activity', () =>
    Effect.gen(function*() {
      const result = yield* scanOf([
        fixture.assistant([fixture.tool('Bash', 't1', { command: 'pnpm test' })]),
      ])
      assert.deepStrictEqual(result.currentActivity(), {
        tool: 'Bash',
        summary: 'pnpm test',
        ts: fixture.T0(),
      })
    }))

  it.effect('clears current activity when the result arrives', () =>
    Effect.gen(function*() {
      const result = yield* scanOf([
        fixture.assistant([fixture.tool('Bash', 't1', { command: 'pnpm test' })]),
        fixture.userResult('t1', 'ok'),
      ])
      assert.isNull(result.currentActivity())
    }))

  it.effect('counts and marks error results', () =>
    Effect.gen(function*() {
      const result = yield* scanOf([
        fixture.assistant([fixture.tool('Bash', 't1', { command: 'nope' })]),
        fixture.userResult('t1', 'Error: command not found', { isError: true }),
      ])
      assert.strictEqual(result.errors, 1)
      assert.isTrue(result.events.at(-1)?.error)
    }))

  it.effect('distinguishes system reminders from real prompts', () =>
    Effect.gen(function*() {
      const result = yield* scanOf([
        fixture.userText('<system-reminder>hi</system-reminder>'),
        fixture.userText('please fix the build'),
      ])
      assert.deepStrictEqual(result.events.map(event => event.kind), ['meta', 'prompt'])
    }))

  it.effect('waits for a trailing partial line, then ingests it once complete', () =>
    Effect.gen(function*() {
      const partial = fixture.transcript([fixture.assistant([fixture.text('one')])], { trailingPartial: true })
      const complete = fixture.transcript([
        fixture.assistant([fixture.text('one')]),
        fixture.assistant([fixture.text('two')]),
      ])

      const scan = new TranscriptScan(PATH)
      const first = yield* scan.refresh().pipe(Effect.provide(testFileSystem({ [PATH]: partial })))
      assert.strictEqual(first.events.length, 1)

      const second = yield* scan.refresh().pipe(Effect.provide(testFileSystem({ [PATH]: complete })))
      assert.deepStrictEqual(second.events.map(event => event.body), ['one', 'two'])
    }))

  it.effect('only ingests newly appended complete lines', () =>
    Effect.gen(function*() {
      const one = fixture.transcript([fixture.assistant([fixture.text('one')])])
      const scan = new TranscriptScan(PATH)
      yield* scan.refresh().pipe(Effect.provide(testFileSystem({ [PATH]: one })))
      assert.strictEqual(scan.line, 1)

      const two = one + fixture.transcript([fixture.assistant([fixture.text('two')])])
      yield* scan.refresh().pipe(Effect.provide(testFileSystem({ [PATH]: two })))
      assert.strictEqual(scan.line, 2)
      assert.strictEqual(scan.events.length, 2)
    }))

  it.effect('skips malformed lines without failing the scan', () =>
    Effect.gen(function*() {
      const body = '{"type":"assistant""broken"}\n'
        + fixture.transcript([fixture.assistant([fixture.text('fine')])])
      const result = yield* new TranscriptScan(PATH).refresh()
        .pipe(Effect.provide(testFileSystem({ [PATH]: body })))
      assert.deepStrictEqual(result.events.map(event => event.body), ['fine'])
    }))

  it.effect('records why each skipped record was skipped', () =>
    Effect.gen(function*() {
      // An unreadable line and a known record type with a bad field: the two
      // causes have different fixes, so the scan must tell them apart.
      const body = '{"type":"assistant""broken"}\n'
        + '{"type":"assistant","message":{"role":"assistant","content":42}}\n'
        + fixture.transcript([fixture.assistant([fixture.text('fine')])])
      const scan = yield* new TranscriptScan(PATH).refresh()
        .pipe(Effect.provide(testFileSystem({ [PATH]: body })))

      assert.strictEqual(scan.malformed, 2)
      assert.strictEqual(scan.parseIssues.skipped, scan.malformed)
      assert.deepStrictEqual(scan.parseIssues.counts, {
        invalidJson: 1,
        schemaMismatch: 1,
        unsupportedShape: 0,
      })

      const [unreadable, mismatch] = scan.parseIssues.samples
      assert.strictEqual(unreadable?.reason, 'invalid-json')
      assert.strictEqual(unreadable?.line, 0)
      assert.strictEqual(mismatch?.reason, 'schema-mismatch')
      assert.strictEqual(mismatch?.line, 1)
      assert.strictEqual(mismatch?.recordType, 'assistant')
      assert.ok(mismatch?.detail.includes('content'))
    }))

  it.effect('does not count an unrecognised record type as a parse issue', () =>
    Effect.gen(function*() {
      // Claude Code adds record kinds over time; those are surfaced as unknown
      // records rather than reported as something the user should fix.
      const body = '{"type":"some_future_kind","uuid":"u1"}\n'
        + fixture.transcript([fixture.assistant([fixture.text('fine')])])
      const scan = yield* new TranscriptScan(PATH).refresh()
        .pipe(Effect.provide(testFileSystem({ [PATH]: body })))

      assert.strictEqual(scan.malformed, 0)
      assert.strictEqual(scan.parseIssues.skipped, 0)
    }))

  it.effect('treats a missing transcript as empty rather than an error', () =>
    Effect.gen(function*() {
      const result = yield* new TranscriptScan('/p/absent.jsonl').refresh()
        .pipe(Effect.provide(testFileSystem({})))
      assert.strictEqual(result.events.length, 0)
      assert.strictEqual(result.line, 0)
    }))

  it.effect('does not read at all when size and mtime are unchanged', () =>
    Effect.gen(function*() {
      const reads = yield* makeCallLog<string>()
      const entry = { content: fixture.transcript([fixture.assistant([fixture.text('one')])]), mtime: 100 }
      const layer = testFileSystem({ [PATH]: entry }, { onRead: reads.record })

      const scan = new TranscriptScan(PATH)
      yield* scan.refresh().pipe(Effect.provide(layer))
      assert.strictEqual(yield* reads.count, 1)

      yield* scan.refresh().pipe(Effect.provide(layer))
      yield* scan.refresh().pipe(Effect.provide(layer))
      assert.strictEqual(yield* reads.count, 1)
      assert.strictEqual(scan.events.length, 1)
    }))

  it.effect('reads only the appended bytes when the transcript grows', () =>
    Effect.gen(function*() {
      const one = fixture.transcript([fixture.assistant([fixture.text('one')])])
      const two = fixture.transcript([fixture.assistant([fixture.text('two')])])
      const entry = { content: one, mtime: 100 }
      const layer = testFileSystem({ [PATH]: entry })

      const scan = new TranscriptScan(PATH)
      yield* scan.refresh().pipe(Effect.provide(layer))

      // Replace the consumed prefix with same-length noise: only the appended
      // record is parseable, so seeing both events proves the refresh never
      // went back over the already-consumed bytes.
      entry.content = 'x'.repeat(one.length) + two
      entry.mtime = 200
      yield* scan.refresh().pipe(Effect.provide(layer))
      assert.deepStrictEqual(scan.events.map(event => event.body), ['one', 'two'])
      assert.strictEqual(scan.malformed, 0)
    }))

  it.effect('recovers when the transcript is rewritten shorter', () =>
    Effect.gen(function*() {
      const long = fixture.transcript([
        fixture.assistant([fixture.text('one')]),
        fixture.assistant([fixture.text('two')]),
      ])
      const entry = { content: long, mtime: 100 }
      const layer = testFileSystem({ [PATH]: entry })

      const scan = new TranscriptScan(PATH)
      yield* scan.refresh().pipe(Effect.provide(layer))
      assert.strictEqual(scan.line, 2)

      entry.content = fixture.transcript([fixture.assistant([fixture.text('one')])])
      entry.mtime = 200
      yield* scan.refresh().pipe(Effect.provide(layer))
      assert.strictEqual(scan.line, 1)
      assert.strictEqual(scan.events.length, 2)
    }))

  it.effect('fails loudly when the transcript cannot be read', () =>
    Effect.gen(function*() {
      const error = yield* new TranscriptScan(PATH).refresh().pipe(
        Effect.provide(testFileSystem({ [PATH]: 'x' }, { denied: [PATH] })),
        Effect.flip,
      )
      assert.strictEqual(error.reason._tag, 'PermissionDenied')
    }))

  it.effect('collects edits relative to the run cwd', () =>
    Effect.gen(function*() {
      const result = yield* scanOf([
        fixture.assistant([fixture.tool('Edit', 't1', { file_path: '/repo/src/a.ts' })]),
        fixture.userResult('t1', 'ok'),
        fixture.assistant([fixture.tool('Write', 't2', { file_path: '/repo/src/a.ts' })]),
        fixture.userResult('t2', 'ok'),
      ])
      assert.deepStrictEqual(result.files.get('src/a.ts')?.ops, 2)
      assert.deepStrictEqual(result.files.get('src/a.ts')?.tools, ['Edit', 'Write'])
    }))

  it.effect('does not count reads as file changes', () =>
    Effect.gen(function*() {
      const result = yield* scanOf([
        fixture.assistant([fixture.tool('Read', 't1', { file_path: '/repo/src/a.ts' })]),
      ])
      assert.strictEqual(result.files.size, 0)
    }))

  it.effect('infers command outcomes from output', () =>
    Effect.gen(function*() {
      const result = yield* scanOf([
        fixture.assistant([fixture.tool('Bash', 't1', { command: 'pnpm test:unit' })]),
        fixture.userResult('t1', 'Test Files  3 passed (3)'),
        fixture.assistant([fixture.tool('Bash', 't2', { command: 'pnpm type-check' })]),
        fixture.userResult('t2', 'src/a.ts(3,1): error TS2345: bad'),
      ])
      assert.deepStrictEqual(result.commands.map(command => command.ok), [true, false])
    }))

  it.effect('leaves a running command without an outcome', () =>
    Effect.gen(function*() {
      const result = yield* scanOf([
        fixture.assistant([fixture.tool('Bash', 't1', { command: 'pnpm test' })]),
      ])
      assert.isNull(result.commands[0]?.ok ?? null)
    }))

  it.effect('records spawned agents and the latest todo state', () =>
    Effect.gen(function*() {
      const result = yield* scanOf([
        fixture.assistant([fixture.tool('Agent', 'spawn', { description: 'slice A' })]),
        fixture.assistant([fixture.tool('TodoWrite', 't1', { todos: [{ content: 'a', status: 'pending' }] })]),
        fixture.userResult('t1', 'ok'),
        fixture.assistant([fixture.tool('TodoWrite', 't2', { todos: [{ content: 'a', status: 'completed' }] })]),
      ])
      assert.isTrue(result.spawnIds.has('spawn'))
      assert.deepStrictEqual(result.todos, [{ content: 'a', status: 'completed' }])
    }))

  it.effect('keeps a background agent outstanding after its launch acknowledgement', () =>
    Effect.gen(function*() {
      const result = yield* scanOf([
        fixture.assistant([fixture.tool('Agent', 'spawn', { description: 'bg worker' })]),
        fixture.userResult('spawn', 'Async agent launched successfully.', {
          toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'agent-bg' },
        }),
      ])
      assert.isTrue(result.asyncSpawns.has('spawn'))
    }))

  it.effect('settles a background agent when its task-notification arrives', () =>
    Effect.gen(function*() {
      const result = yield* scanOf([
        fixture.assistant([fixture.tool('Agent', 'spawn', { description: 'bg worker' })]),
        fixture.userResult('spawn', 'Async agent launched successfully.', {
          toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'agent-bg' },
        }),
        fixture.userText(
          '<task-notification>\n<task-id>agent-bg</task-id>\n<tool-use-id>spawn</tool-use-id>\n'
          + '<status>completed</status>\n</task-notification>',
          { meta: true },
        ),
      ])
      assert.isFalse(result.asyncSpawns.has('spawn'))
    }))

  it.effect('does not treat a synchronous agent result as a background launch', () =>
    Effect.gen(function*() {
      const result = yield* scanOf([
        fixture.assistant([fixture.tool('Agent', 'spawn', { description: 'sync worker' })]),
        fixture.userResult('spawn', 'done', { toolUseResult: { status: 'completed' } }),
      ])
      assert.isFalse(result.asyncSpawns.has('spawn'))
    }))

  it.effect('accumulates output tokens', () =>
    Effect.gen(function*() {
      const result = yield* scanOf([
        fixture.assistant([fixture.text('a')], { usage: { output_tokens: 10 } }),
        fixture.assistant([fixture.text('b')], { usage: { output_tokens: 5 } }),
      ])
      assert.strictEqual(result.tokensOut, 15)
    }))

  it.effect('collects native timing, context, compaction, and API diagnostics', () =>
    Effect.gen(function*() {
      const result = yield* scanOf([
        fixture.assistant([fixture.text('retrying')], {
          messageId: 'msg-1',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 20,
            cache_creation: {
              ephemeral_5m_input_tokens: 7,
              ephemeral_1h_input_tokens: 13,
            },
            server_tool_use: { web_search_requests: 2 },
            service_tier: 'standard',
            inference_geo: 'not_available',
            speed: 'standard',
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
            preservedMessages: {
              anchorUuid: 'message-1',
              uuids: ['message-1', 'message-2', 'message-3'],
              allUuids: ['message-1', 'message-2', 'message-3', 'dropped-1'],
            },
            trigger: 'manual',
          },
        }),
        fixture.system('compact_boundary', {
          compactMetadata: { preservedMessages: 6, trigger: 'legacy' },
        }),
      ])

      const diagnostics = result.diagnostics()
      assert.strictEqual(diagnostics.incidents[0]?.category, 'api')
      assert.strictEqual(diagnostics.incidents[0]?.code, '429')
      assert.strictEqual(diagnostics.turns[0]?.durationMs, 12_000)
      assert.strictEqual(diagnostics.turns[0]?.pendingAgents, 1)
      assert.deepStrictEqual(diagnostics.context[0]?.usage, { in: 10, out: 5, cr: 100, cw: 20 })
      assert.deepStrictEqual(diagnostics.context[0], {
        ts: fixture.T0(),
        model: 'claude-opus-5',
        effort: 'high',
        usage: { in: 10, out: 5, cr: 100, cw: 20 },
        stopReason: null,
        messageId: 'msg-1',
        requestId: 'req-1',
        cacheWrite5m: 7,
        cacheWrite1h: 13,
        webSearchRequests: 2,
        serviceTier: 'standard',
        inferenceGeo: 'not_available',
        speed: 'standard',
      })
      assert.strictEqual(diagnostics.compactions[0]?.trigger, 'manual')
      assert.deepStrictEqual(
        diagnostics.compactions.map(compaction => compaction.preservedMessages),
        [3, 6],
      )
    }))

  it.effect('counts array-shaped stop-hook errors', () =>
    Effect.gen(function*() {
      const result = yield* scanOf([
        fixture.system('stop_hook_summary', {
          hookErrors: [{ hookName: 'lint' }, { hookName: 'format' }],
          preventedContinuation: true,
          toolUseID: 'tool-1',
        }),
      ])

      const incident = result.diagnostics().incidents[0]
      assert.strictEqual(incident?.severity, 'error')
      assert.strictEqual(incident?.category, 'hook')
      assert.strictEqual(incident?.title, 'Stop hook prevented continuation')
      assert.strictEqual(incident?.detail, '2 hook errors')
      assert.strictEqual(incident?.toolUseId, 'tool-1')
    }))

  it.effect('captures explicit tool metadata, patches, git operations, and agent receipts', () =>
    Effect.gen(function*() {
      const result = yield* scanOf([
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
      assert.strictEqual(diagnostics.changes[0]?.path, 'src/a.ts')
      assert.strictEqual(diagnostics.changes[0]?.linesAdded, 1)
      assert.isTrue(diagnostics.changes[0]?.staleRecovered)
      assert.deepStrictEqual(diagnostics.git.map(event => event.kind), ['commit', 'push'])
      assert.strictEqual(diagnostics.outcomes[0]?.model, 'claude-sonnet-5')
      assert.deepStrictEqual(diagnostics.incidents.map(incident => incident.category), ['tool', 'timeout'])
    }))

  it.effect('degrades mismatched toolUseResult fields instead of dropping the record', () =>
    Effect.gen(function*() {
      const result = yield* scanOf([
        fixture.assistant([fixture.tool('Agent', 'agent-1', { description: 'worker' })]),
        fixture.userResult('agent-1', 'complete', {
          toolUseResult: {
            status: 123,
            resolvedModel: { nested: true },
            totalDurationMs: 'later',
            toolStats: 'not-an-object',
            gitOperation: { commit: 'abc', push: { branch: 42 } },
            timedOutAfterMs: '5000',
          },
        }),
      ])

      const diagnostics = result.diagnostics()
      assert.deepStrictEqual(diagnostics.outcomes[0], {
        toolUseId: 'agent-1',
        ts: fixture.T0(1),
        status: '',
        model: '',
        durationMs: 0,
        totalTokens: 0,
        totalToolUseCount: 0,
        stats: { reads: 0, searches: 0, commands: 0, edits: 0, linesAdded: 0, linesRemoved: 0, other: 0 },
      })
      // A non-object commit degrades away; a push with a non-string branch
      // still records the push with the fallback label.
      assert.deepStrictEqual(diagnostics.git.map(event => [event.kind, event.label]), [['push', 'Pushed branch']])
      // A string timedOutAfterMs is not a timeout.
      assert.deepStrictEqual(diagnostics.incidents, [])
    }))

  it.effect('ignores attachment types the dashboard does not report', () =>
    Effect.gen(function*() {
      const result = yield* scanOf([
        fixture.attachment('some_future_attachment', { anything: true }),
        fixture.attachment('goal_status', { met: false, reason: 'budget exhausted' }),
      ])

      const incidents = result.diagnostics().incidents
      assert.deepStrictEqual(
        incidents.map(incident => [incident.category, incident.detail]),
        [['workflow', 'budget exhausted']],
      )
    }))

  it.effect('surfaces hook, truncation, denial, and interruption incidents', () =>
    Effect.gen(function*() {
      const result = yield* scanOf([
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

      assert.deepStrictEqual(
        result.diagnostics().incidents.map(incident => incident.category),
        ['hook', 'truncation', 'interruption', 'permission'],
      )
    }))

  it.effect('reports IDE diagnostics as incidents, mapping severity by level', () =>
    Effect.gen(function*() {
      const result = yield* scanOf([
        fixture.attachment('diagnostics', {
          isNew: true,
          files: [{
            uri: 'file:///repo/server/api/run.get.ts',
            diagnostics: [
              {
                message: "Cannot find name 'runRequest'.",
                severity: 'Error',
                range: { start: { line: 10, character: 9 }, end: { line: 10, character: 19 } },
                source: 'ts',
                code: '2552',
              },
              {
                message: 'Value is declared but never read.',
                severity: 'Hint',
                range: { start: { line: 3, character: 0 }, end: { line: 3, character: 5 } },
                source: 'ts-plugin',
                code: '6133',
              },
            ],
          }],
        }),
      ])

      assert.deepStrictEqual(
        result.diagnostics().incidents.map(incident => [
          incident.category,
          incident.severity,
          incident.title,
          incident.detail,
          incident.code,
        ]),
        [
          ['lsp', 'error', "Cannot find name 'runRequest'.", 'server/api/run.get.ts:11 · ts 2552', 'ts 2552'],
          ['lsp', 'info', 'Value is declared but never read.', 'server/api/run.get.ts:4 · ts-plugin 6133', 'ts-plugin 6133'],
        ],
      )
    }))

  it.effect('reports a re-sent diagnostic only once', () =>
    Effect.gen(function*() {
      const snapshot = {
        files: [{
          uri: 'file:///repo/a.ts',
          diagnostics: [{
            message: 'Broken',
            severity: 'Error',
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            source: 'ts',
            code: '1',
          }],
        }],
      }
      const result = yield* scanOf([
        fixture.attachment('diagnostics', snapshot),
        fixture.attachment('diagnostics', snapshot),
      ])

      assert.strictEqual(result.diagnostics().incidents.length, 1)
    }))

  it.effect('aggregates hook runs per name across successes and failures', () =>
    Effect.gen(function*() {
      const result = yield* scanOf([
        fixture.attachment('hook_success', { hookName: 'lint', hookEvent: 'PostToolUse', durationMs: 12 }),
        fixture.attachment('hook_success', { hookName: 'lint', hookEvent: 'PostToolUse', durationMs: 30 }),
        fixture.attachment('hook_success', { hookName: 'inject', hookEvent: 'SessionStart', durationMs: 5 }),
        fixture.attachment('hook_non_blocking_error', { hookName: 'lint', hookEvent: 'PostToolUse', exitCode: 1, stderr: 'boom' }),
      ])

      assert.deepStrictEqual(
        result.diagnostics().hooks?.map(hook => [hook.name, hook.event, hook.runs, hook.failures, hook.totalMs, hook.maxMs]),
        [
          ['lint', 'PostToolUse', 3, 1, 42, 30],
          ['inject', 'SessionStart', 1, 0, 5, 5],
        ],
      )
    }))

  it.effect('keeps the newest reported budget, since the record is rewritten as it spends', () =>
    Effect.gen(function*() {
      const result = yield* scanOf([
        fixture.attachment('budget_usd', { used: 0, total: 1.5, remaining: 1.5 }),
        fixture.attachment('budget_usd', { used: 0.72, total: 1.5, remaining: 0.78 }),
      ])

      assert.deepStrictEqual(result.diagnostics().budget, {
        usedUsd: 0.72,
        totalUsd: 1.5,
        remainingUsd: 0.78,
        ts: fixture.T0(2),
      })
    }))

  it.effect('omits hooks and budget when the session recorded neither', () =>
    Effect.gen(function*() {
      const result = yield* scanOf([fixture.userText('hello')])
      const diagnostics = result.diagnostics()
      assert.isUndefined(diagnostics.hooks)
      assert.isUndefined(diagnostics.budget)
    }))

  it.effect('annotates a command with the recorded reason for its exit code', () =>
    Effect.gen(function*() {
      const result = yield* scanOf([
        fixture.assistant([fixture.tool('Bash', 't1', { command: 'grep -r nothing .' })]),
        fixture.userResult('t1', '', {
          toolUseResult: { stdout: '', stderr: '', interrupted: false, returnCodeInterpretation: 'No matches found' },
        }),
      ])

      assert.deepStrictEqual(
        result.commands.map(command => [command.cmd, command.ok, command.note]),
        [['grep -r nothing .', true, 'No matches found']],
      )
    }))

  it.effect('takes the newest generated title, since the record is rewritten in place', () =>
    Effect.gen(function*() {
      const result = yield* scanOf([
        { type: 'ai-title', sessionId: 's', aiTitle: 'Explore Shiki integration' },
        { type: 'ai-title', sessionId: 's', aiTitle: 'Highlight transcript code with Shiki' },
      ])
      assert.strictEqual(result.title, 'Highlight transcript code with Shiki')
    }))

  it.effect('prefers a title the user set over the generated one, whatever their order', () =>
    Effect.gen(function*() {
      const result = yield* scanOf([
        { type: 'custom-title', sessionId: 's', customTitle: 'Shiki spike' },
        { type: 'ai-title', sessionId: 's', aiTitle: 'Highlight transcript code with Shiki' },
      ])
      assert.strictEqual(result.title, 'Shiki spike')
    }))

  it.effect('has no title when the session recorded none', () =>
    Effect.gen(function*() {
      const result = yield* scanOf([fixture.userText('hello')])
      assert.strictEqual(result.title, '')
    }))

  it.effect('records the session mode and permission mode separately', () =>
    Effect.gen(function*() {
      const result = yield* scanOf([
        { type: 'mode', sessionId: 's', mode: 'plan' },
        { type: 'permission-mode', sessionId: 's', permissionMode: 'bypassPermissions' },
      ])
      const { environment } = result.diagnostics()
      assert.strictEqual(environment.mode, 'plan')
      assert.strictEqual(environment.permissionMode, 'bypassPermissions')
    }))

  it.effect('keeps the newest instruction and ignores a blank one', () =>
    Effect.gen(function*() {
      const result = yield* scanOf([
        { type: 'last-prompt', sessionId: 's', lastPrompt: 'implement 1 and 2' },
        { type: 'last-prompt', sessionId: 's', lastPrompt: 'now write the tests' },
        { type: 'last-prompt', sessionId: 's', lastPrompt: '' },
      ])
      assert.strictEqual(result.lastPrompt, 'now write the tests')
    }))
})

/**
 * `live` and `ago` were previously untestable: they read `Date.now()` through a
 * default parameter, so no test covered them. With the Clock as a service the
 * boundary itself can be asserted.
 */
describe('TranscriptScan.stats liveness', () => {
  const MTIME = 1_000_000

  const statsAtClock = (clockSeconds: number) =>
    Effect.gen(function*() {
      yield* TestClock.setTime(clockSeconds * 1_000)
      const scan = yield* scanOf([fixture.assistant([fixture.text('hi')])], { mtime: MTIME })
      return yield* scan.stats
    })

  it.effect('reports a recently touched transcript as live', () =>
    Effect.gen(function*() {
      const stats = yield* statsAtClock(MTIME + 5)
      assert.isTrue(stats.live)
      assert.strictEqual(stats.ago, 5)
    }))

  it.effect('settles immediately when Claude records a completed turn', () =>
    Effect.gen(function*() {
      yield* TestClock.setTime((MTIME + 5) * 1_000)
      const scan = yield* scanOf([
        fixture.assistant([fixture.text('done')], { stopReason: 'end_turn' }),
      ], { mtime: MTIME })
      const stats = yield* scan.stats

      assert.isFalse(stats.live)
      assert.strictEqual(stats.ago, 5)
    }))

  it.effect('becomes live again when a completed session receives a new prompt', () =>
    Effect.gen(function*() {
      yield* TestClock.setTime((MTIME + 5) * 1_000)
      const scan = yield* scanOf([
        fixture.assistant([fixture.text('done')], { stopReason: 'end_turn' }),
        fixture.userText('one more task', { ts: fixture.T0(2) }),
      ], { mtime: MTIME })

      assert.isTrue((yield* scan.stats).live)
    }))

  it.effect('does not keep an abandoned open tool live beyond the freshness window', () =>
    Effect.gen(function*() {
      yield* TestClock.setTime((MTIME + 60) * 1_000)
      const scan = yield* scanOf([
        fixture.assistant([fixture.tool('Bash', 't1', { command: 'pnpm test' })]),
      ], { mtime: MTIME })

      assert.isFalse((yield* scan.stats).live)
    }))

  it.effect('is live on the last second inside the window', () =>
    Effect.gen(function*() {
      const stats = yield* statsAtClock(MTIME + 44)
      assert.isTrue(stats.live)
    }))

  it.effect('is not live once the window has elapsed', () =>
    Effect.gen(function*() {
      const stats = yield* statsAtClock(MTIME + 45)
      assert.isFalse(stats.live)
      assert.strictEqual(stats.ago, 45)
    }))
})

describe('transcript helpers', () => {
  it('prefers explicit wave markers over incidental headings', () => {
    assert.deepStrictEqual(
      findMilestones('**Before**\n\n**Wave 2 — DI core**\n\n**After**'),
      [['Wave 2 — DI core', true]],
    )
  })

  it('recognizes strong and weak milestones', () => {
    assert.deepStrictEqual(findMilestones('**Wave 1 (parallel slices):**'), [['Wave 1 (parallel slices)', true]])
    assert.deepStrictEqual(findMilestones('**Rulings I folded in**'), [['Rulings I folded in', false]])
    assert.deepStrictEqual(findMilestones('just some ordinary sentence'), [])
  })

  it('shortens paths relative to the run or to their tail', () => {
    assert.strictEqual(shortPath('/repo/src/a.ts', '/repo'), 'src/a.ts')
    assert.strictEqual(shortPath('/a/b/c/d/e.ts', '/other'), 'c/d/e.ts')
  })

  it('summarizes meaningful tool fields', () => {
    assert.strictEqual(toolSummary({ command: 'ls  -l' }), 'ls -l')
    assert.strictEqual(toolSummary({ file_path: '/a.ts' }), '/a.ts')
  })

  it('does not mistake passing output containing error language for failure', () => {
    assert.isTrue(commandOk('✓ 12 passed — no errors reported', false))
    assert.isFalse(commandOk('anything', true))
  })

  it('understands TAP failure totals without relying on an early pass marker', () => {
    const prefix = 'ok 1 - first\n'.repeat(30)
    assert.isTrue(commandOk(`${prefix}# pass 3\n# fail 0\n# duration_ms 40`, false))
    assert.isFalse(commandOk(`${prefix}# pass 2\n# fail 1\n# duration_ms 40`, false))
  })

  it('keeps a benign non-zero exit passing and records why', () => {
    assert.deepStrictEqual(
      commandOutcome({ returnCodeInterpretation: 'No matches found', stdout: '', stderr: '' }, '', false),
      { ok: true, note: 'No matches found' },
    )
  })

  it('reports an interrupted command as failed', () => {
    assert.deepStrictEqual(
      commandOutcome({ interrupted: true, stdout: 'partial', stderr: '' }, 'partial', false),
      { ok: false, note: 'Interrupted' },
    )
  })

  it('judges the recorded streams rather than the rendered result text', () => {
    // The rendered text says nothing; the failure only appears on stderr.
    assert.isFalse(commandOutcome({ stdout: '', stderr: 'error TS2552: nope' }, '', false).ok)
    assert.isTrue(commandOutcome({ stdout: 'all good', stderr: '' }, 'error TS2552: nope', false).ok)
  })

  it('falls back to the result text when no streams were recorded', () => {
    assert.deepStrictEqual(commandOutcome(null, '✓ 12 passed', false), { ok: true, note: '' })
    assert.deepStrictEqual(commandOutcome(null, 'anything', true), { ok: false, note: '' })
  })

  /**
   * `PHASE_PATTERNS` are module-level `/g` regexes whose `lastIndex` is shared
   * across calls. The reset in `findMilestones` is what keeps repeated calls
   * consistent; this pins that behaviour for arbitrary input.
   */
  it.prop('findMilestones is free of regex lastIndex leakage', [FastCheck.string()], ([text]) => {
    assert.deepStrictEqual(findMilestones(text), findMilestones(text))
  })

  it.prop('clip never exceeds the cap and reports the true length', [FastCheck.string()], ([text]) => {
    const [body, length] = clip(text)
    assert.isTrue(body.length <= MAX_CHARS)
    assert.strictEqual(length, text.length)
    assert.isTrue(text.startsWith(body))
  })
})

/**
 * The changed-files list is rendered as a display path, and every consumer —
 * the sidebar, the diff view, the run projection — treats the map key as that
 * display path. These pin the shape for arbitrary paths rather than for the
 * handful the example tests use.
 *
 * Note what is *not* claimed: a path of three segments or fewer is already
 * short enough to show, so `shortPath` leaves it alone and the key keeps its
 * leading slash. The bound that matters is the segment count, and the promise
 * that a long absolute path is always shortened to a relative tail.
 */
describe('changed-file keys', () => {
  const segment = FastCheck.stringMatching(/^[a-zA-Z0-9._-]{1,12}$/)
  const absolutePath = FastCheck.array(segment, { minLength: 1, maxLength: 8 })
    .map(parts => `/${parts.join('/')}`)
  const editTool = FastCheck.constantFrom(...EDIT_TOOLS)

  const scanOfEdits = (paths: ReadonlyArray<string>, tool: string) =>
    new TranscriptScan(PATH).refresh().pipe(Effect.provide(testFileSystem({
      [PATH]: fixture.transcript(paths.map((path, index) =>
        fixture.assistant([fixture.tool(tool, `t${index}`, { file_path: path })]),
      )),
    })))

  it.effect.prop(
    'never keep more than three segments, and are always a tail of the real path',
    { paths: FastCheck.array(absolutePath, { minLength: 1, maxLength: 6 }), tool: editTool },
    ({ paths, tool }) =>
      Effect.gen(function*() {
        const scan = yield* scanOfEdits(paths, tool)

        for (const key of scan.files.keys()) {
          assert.isAtMost(
            key.split('/').filter(Boolean).length,
            3,
            `"${key}" keeps more than three segments`,
          )
          assert.isTrue(
            paths.some(path => path.endsWith(key)),
            `"${key}" is not the tail of any recorded path`,
          )
        }
      }),
  )

  it.effect.prop(
    'shorten a deep absolute path to a relative tail',
    {
      parts: FastCheck.array(segment, { minLength: 4, maxLength: 8 }),
      tool: editTool,
    },
    ({ parts, tool }) =>
      Effect.gen(function*() {
        const path = `/${parts.join('/')}`
        const scan = yield* scanOfEdits([path], tool)

        assert.deepStrictEqual([...scan.files.keys()], [parts.slice(-3).join('/')])
      }),
  )
})
