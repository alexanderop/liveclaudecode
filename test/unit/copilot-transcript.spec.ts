import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { CopilotTranscriptScan } from '#server/utils/copilot-transcript'
import * as fixture from '../fixtures/copilot'
import { testFileSystem } from '../fixtures/filesystem'

const PATH = '/vscode/chatSessions/copilot.jsonl'

describe('Copilot transcript replay and normalization', () => {
  it.effect('replays deltas and preserves explicit command, edit, diagnostic, and completion semantics', () => {
    const scan = new CopilotTranscriptScan(PATH, 'VS Code', '/repo')
    const initial = fixture.snapshot({
      id: 'complete',
      title: 'Copilot completed session',
      requests: [fixture.request('request-1', 'Fix the tests', {
        mode: 'agent',
        elapsedMs: 2_500,
        response: [
          fixture.thinking('Checking the failure'),
          fixture.tool('run_in_terminal', 'command-1', {
            command: 'pnpm test',
            exitCode: 1,
          }),
          fixture.textEdit('/repo/src/fix.ts'),
          fixture.markdown('Tests still fail explicitly.'),
          { kind: 'futurePart', value: 'ignored' },
        ],
      })],
    })
    return Effect.gen(function*() {
      yield* scan.refresh
      const stats = scan.statsAt(999_999_999)
      assert.strictEqual(scan.supported, true)
      assert.strictEqual(stats.live, false)
      assert.deepStrictEqual(stats.commands, [{
        cmd: 'pnpm test',
        ts: '2026-07-26T08:00:00.000Z',
        ok: false,
        tid: 'command-1',
      }])
      assert.deepStrictEqual(stats.files.map(file => file.path), ['src/fix.ts'])
      assert.strictEqual(stats.errors, 1)
      assert.strictEqual(stats.finalText, 'Tests still fail explicitly.')
      assert.strictEqual(scan.diagnostics().turns[0]?.durationMs, 2_500)
      assert.strictEqual(scan.diagnostics().changes[0]?.linesAdded, 1)
      assert.isTrue(scan.events.some(event => event.kind === 'tool_result'
        && event.error
        && event.body === 'Ran run_in_terminal'))
    }).pipe(Effect.provide(testFileSystem({ [PATH]: fixture.log([fixture.initial(initial)]) })))
  })

  it.effect('keeps explicit active state regardless of inactivity and completed state idle when recent', () => {
    const active = new CopilotTranscriptScan('/active.jsonl', 'VS Code', '/repo')
    const complete = new CopilotTranscriptScan('/complete.jsonl', 'VS Code', '/repo')
    return Effect.gen(function*() {
      yield* active.refresh
      yield* complete.refresh
      assert.strictEqual(active.statsAt(9_999_999_999).live, true)
      assert.strictEqual(active.statsAt(9_999_999_999).current?.tool, 'Copilot')
      assert.strictEqual(complete.statsAt(fixture.T0 / 1_000 + 1).live, false)
    }).pipe(Effect.provide(testFileSystem({
      '/active.jsonl': fixture.log([fixture.initial(fixture.snapshot({
        id: 'active',
        pendingRequests: [{ request: 'pending' }],
        requests: [fixture.request('active-request', 'Keep working', { state: 0 })],
      }))]),
      '/complete.jsonl': fixture.log([fixture.initial(fixture.snapshot({
        id: 'complete',
        requests: [fixture.request('complete-request', 'Done', { state: 1 })],
      }))]),
    })))
  })

  it.effect('isolates incomplete lines and reconciles newly materialized semantic events', () => {
    const scan = new CopilotTranscriptScan(PATH, 'VS Code Insiders', '/repo')
    const base = fixture.snapshot({
      id: 'growing',
      requests: [fixture.request('request-1', 'Start', {
        state: 0,
        response: [fixture.tool('run_in_terminal', 'command-1', {
          complete: false,
          command: 'pnpm test',
        })],
      })],
    })
    const first = fixture.log([fixture.initial(base)], { trailingPartial: true })
    const second = fixture.log([
      fixture.initial(base),
      fixture.set(['requests', 0, 'response', 0], fixture.tool('run_in_terminal', 'command-1', {
        complete: true,
        command: 'pnpm test',
        exitCode: 0,
      })),
      fixture.set(['requests', 0, 'modelState'], { value: 1, completedAt: fixture.T0 + 3_000 }),
    ])
    return Effect.gen(function*() {
      yield* scan.refresh.pipe(Effect.provide(testFileSystem({ [PATH]: { content: first, mtime: 1 } })))
      const before = scan.events.length
      const revision = scan.eventRevision
      assert.strictEqual(scan.malformed, 0)
      assert.strictEqual(scan.statsAt(10).commands[0]?.ok, null)

      yield* scan.refresh.pipe(Effect.provide(testFileSystem({ [PATH]: { content: second, mtime: 2 } })))
      assert.strictEqual(scan.statsAt(10).commands[0]?.ok, true)
      assert.strictEqual(scan.statsAt(10).live, false)
      assert.strictEqual(scan.events.length, before + 1)
      assert.strictEqual(scan.events.filter(event => event.kind === 'tool_use').length, 1)
      assert.strictEqual(scan.events.filter(event => event.kind === 'tool_result').length, 1)
      assert.strictEqual(scan.eventRevision, revision)
    })
  })

  it.effect('replaces streamed response parts instead of accumulating partial duplicates', () => {
    const scan = new CopilotTranscriptScan(PATH, 'VS Code', '/repo')
    const base = fixture.snapshot({
      id: 'streaming',
      requests: [fixture.request('request-1', 'Stream', {
        state: 0,
        response: [fixture.markdown('Partial response')],
      })],
    })
    const first = fixture.log([fixture.initial(base)])
    const second = fixture.log([
      fixture.initial(base),
      fixture.set(['requests', 0, 'response', 0, 'value'], 'Complete response'),
    ])
    return Effect.gen(function*() {
      yield* scan.refresh.pipe(Effect.provide(testFileSystem({ [PATH]: { content: first, mtime: 1 } })))
      const revision = scan.eventRevision
      assert.strictEqual(scan.events.filter(event => event.kind === 'text').length, 1)

      yield* scan.refresh.pipe(Effect.provide(testFileSystem({ [PATH]: { content: second, mtime: 2 } })))
      const messages = scan.events.filter(event => event.kind === 'text')
      assert.strictEqual(messages.length, 1)
      assert.strictEqual(messages[0]?.body, 'Complete response')
      assert.strictEqual(scan.eventRevision, revision + 1)
    })
  })

  it.effect('rejects unsafe replay paths and invalid indices without polluting prototypes', () => {
    const scan = new CopilotTranscriptScan(PATH, 'VS Code', '/repo')
    return Effect.gen(function*() {
      assert.strictEqual(Object.hasOwn(Object.prototype, 'copilotPolluted'), false)
      yield* scan.refresh
      assert.strictEqual(scan.supported, true)
      assert.strictEqual(scan.malformed, 2)
      assert.strictEqual(Object.hasOwn(Object.prototype, 'copilotPolluted'), false)
    }).pipe(Effect.provide(testFileSystem({
      [PATH]: fixture.log([
        fixture.initial(fixture.snapshot({ id: 'safe' })),
        fixture.set(['__proto__', 'copilotPolluted'], true),
        fixture.push(['requests'], [], -1),
      ]),
    })))
  })

  it.effect('omits commands and changes when exact source records are absent', () => {
    const scan = new CopilotTranscriptScan(PATH, 'VS Code', '/repo')
    return Effect.gen(function*() {
      yield* scan.refresh
      assert.deepStrictEqual(scan.statsAt(10).commands, [])
      assert.deepStrictEqual(scan.statsAt(10).files, [])
      assert.deepStrictEqual(scan.diagnostics().changes, [])
      const result = scan.events.find(event => event.kind === 'tool_result')
      assert.strictEqual(result?.body, 'Run the checks')
    }).pipe(Effect.provide(testFileSystem({
      [PATH]: fixture.log([fixture.initial(fixture.snapshot({
        requests: [fixture.request('request', 'Do not infer', {
          response: [
            fixture.tool('run_in_terminal', 'tool', { isError: false, message: 'Run the checks' }),
            { kind: 'textEditGroup', uri: { scheme: 'file', path: '/repo/empty.ts' }, edits: [] },
          ],
        })],
      }))]),
    })))
  })

  it.effect('does not classify generic VS Code chat without Copilot metadata', () => {
    const scan = new CopilotTranscriptScan(PATH, 'VS Code', '')
    return Effect.gen(function*() {
      yield* scan.refresh
      assert.strictEqual(scan.supported, false)
    }).pipe(Effect.provide(testFileSystem({
      [PATH]: fixture.log([fixture.initial(fixture.snapshot({
        responder: 'Another Provider',
        requests: [fixture.request('generic', 'Generic', {
          agentId: 'other.provider',
          copilotMetadata: false,
        })],
      }))]),
    })))
  })

  it.effect('keeps agent, edit, and ordinary chat modes distinct when recorded', () => {
    const agent = new CopilotTranscriptScan('/agent.jsonl', 'VS Code', '/repo')
    const edit = new CopilotTranscriptScan('/edit.jsonl', 'VS Code', '/repo')
    const chat = new CopilotTranscriptScan('/chat.jsonl', 'VS Code', '/repo')
    return Effect.gen(function*() {
      yield* agent.refresh
      yield* edit.refresh
      yield* chat.refresh
      assert.strictEqual(agent.sourceDetail, 'VS Code · agent')
      assert.strictEqual(edit.sourceDetail, 'VS Code · edit')
      assert.strictEqual(chat.sourceDetail, 'VS Code · chat')
    }).pipe(Effect.provide(testFileSystem({
      '/agent.jsonl': fixture.log([fixture.initial(fixture.snapshot({ requests: [
        fixture.request('agent', 'Agent', { mode: 'agent' }),
      ] }))]),
      '/edit.jsonl': fixture.log([fixture.initial(fixture.snapshot({ requests: [
        fixture.request('edit', 'Edit', { agentId: 'github.copilot.editingSession' }),
      ] }))]),
      '/chat.jsonl': fixture.log([fixture.initial(fixture.snapshot({ requests: [
        fixture.request('chat', 'Chat', { agentId: 'github.copilot.default' }),
      ] }))]),
    })))
  })

  it.effect('counts malformed known data while tolerating unknown future records', () => {
    const scan = new CopilotTranscriptScan(PATH, 'VS Code', '/repo')
    return Effect.gen(function*() {
      yield* scan.refresh
      assert.strictEqual(scan.supported, true)
      assert.strictEqual(scan.malformed, 1)
      assert.strictEqual(scan.malformedParts, 1)
      assert.strictEqual(scan.unknown, 2)
    }).pipe(Effect.provide(testFileSystem({
      [PATH]: fixture.log([
        fixture.initial(fixture.snapshot({ requests: [fixture.request('request', 'Forward compatible', {
          response: [
            { kind: 'toolInvocationSerialized', toolId: 'missing-required-fields' },
            { kind: 'futurePart', payload: {} },
          ],
        })] })),
        fixture.unknownRecord(),
      ], { malformed: true }),
    })))
  })
})
