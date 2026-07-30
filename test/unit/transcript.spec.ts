import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { FastCheck, TestClock } from 'effect/testing'
import {
  clip,
  commandOk,
  findMilestones,
  MAX_CHARS,
  shortPath,
  toolSummary,
} from '#server/utils/transcript-content'
import { TranscriptScan } from '#server/utils/transcript'
import * as fixture from '../fixtures/transcripts'
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
  return new TranscriptScan(PATH).refresh.pipe(Effect.provide(testFileSystem(tree)))
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
      const first = yield* scan.refresh.pipe(Effect.provide(testFileSystem({ [PATH]: partial })))
      assert.strictEqual(first.events.length, 1)

      const second = yield* scan.refresh.pipe(Effect.provide(testFileSystem({ [PATH]: complete })))
      assert.deepStrictEqual(second.events.map(event => event.body), ['one', 'two'])
    }))

  it.effect('only ingests newly appended complete lines', () =>
    Effect.gen(function*() {
      const one = fixture.transcript([fixture.assistant([fixture.text('one')])])
      const scan = new TranscriptScan(PATH)
      yield* scan.refresh.pipe(Effect.provide(testFileSystem({ [PATH]: one })))
      assert.strictEqual(scan.line, 1)

      const two = one + fixture.transcript([fixture.assistant([fixture.text('two')])])
      yield* scan.refresh.pipe(Effect.provide(testFileSystem({ [PATH]: two })))
      assert.strictEqual(scan.line, 2)
      assert.strictEqual(scan.events.length, 2)
    }))

  it.effect('skips malformed lines without failing the scan', () =>
    Effect.gen(function*() {
      const body = '{"type":"assistant""broken"}\n'
        + fixture.transcript([fixture.assistant([fixture.text('fine')])])
      const result = yield* new TranscriptScan(PATH).refresh
        .pipe(Effect.provide(testFileSystem({ [PATH]: body })))
      assert.deepStrictEqual(result.events.map(event => event.body), ['fine'])
    }))

  it.effect('treats a missing transcript as empty rather than an error', () =>
    Effect.gen(function*() {
      const result = yield* new TranscriptScan('/p/absent.jsonl').refresh
        .pipe(Effect.provide(testFileSystem({})))
      assert.strictEqual(result.events.length, 0)
      assert.strictEqual(result.line, 0)
    }))

  it.effect('does not read at all when size and mtime are unchanged', () =>
    Effect.gen(function*() {
      const reads: string[] = []
      const entry = { content: fixture.transcript([fixture.assistant([fixture.text('one')])]), mtime: 100 }
      const layer = testFileSystem({ [PATH]: entry }, { onRead: path => reads.push(path) })

      const scan = new TranscriptScan(PATH)
      yield* scan.refresh.pipe(Effect.provide(layer))
      assert.strictEqual(reads.length, 1)

      yield* scan.refresh.pipe(Effect.provide(layer))
      yield* scan.refresh.pipe(Effect.provide(layer))
      assert.strictEqual(reads.length, 1)
      assert.strictEqual(scan.events.length, 1)
    }))

  it.effect('reads only the appended bytes when the transcript grows', () =>
    Effect.gen(function*() {
      const one = fixture.transcript([fixture.assistant([fixture.text('one')])])
      const two = fixture.transcript([fixture.assistant([fixture.text('two')])])
      const entry = { content: one, mtime: 100 }
      const layer = testFileSystem({ [PATH]: entry })

      const scan = new TranscriptScan(PATH)
      yield* scan.refresh.pipe(Effect.provide(layer))

      // Replace the consumed prefix with same-length noise: only the appended
      // record is parseable, so seeing both events proves the refresh never
      // went back over the already-consumed bytes.
      entry.content = 'x'.repeat(one.length) + two
      entry.mtime = 200
      yield* scan.refresh.pipe(Effect.provide(layer))
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
      yield* scan.refresh.pipe(Effect.provide(layer))
      assert.strictEqual(scan.line, 2)

      entry.content = fixture.transcript([fixture.assistant([fixture.text('one')])])
      entry.mtime = 200
      yield* scan.refresh.pipe(Effect.provide(layer))
      assert.strictEqual(scan.line, 1)
      assert.strictEqual(scan.events.length, 2)
    }))

  it.effect('fails loudly when the transcript cannot be read', () =>
    Effect.gen(function*() {
      const error = yield* new TranscriptScan(PATH).refresh.pipe(
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
