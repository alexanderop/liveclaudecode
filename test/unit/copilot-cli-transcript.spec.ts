import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { CopilotCliTranscriptScan } from '#server/utils/copilot-cli-transcript'
import * as fixture from '../fixtures/copilot-cli'
import { testFileSystem } from '../fixtures/filesystem'

const PATH = '/home/test/.copilot/session-state/session-1/events.jsonl'

describe('Copilot CLI transcript scan', () => {
  it.effect('normalizes messages, reasoning, tools, errors, diagnostics, and session metadata', () => {
    const scan = new CopilotCliTranscriptScan(PATH, 'GitHub Copilot CLI')
    return Effect.gen(function*() {
      yield* scan.refresh
      const stats = scan.statsAt(20)

      assert.strictEqual(scan.supported, true)
      assert.strictEqual(scan.sessionId, 'session-1')
      assert.strictEqual(scan.title, 'Fix the integration')
      assert.strictEqual(scan.model, 'claude-sonnet-4.5')
      assert.strictEqual(scan.workingDirectory, '/repo')
      assert.strictEqual(scan.sourceDetail, 'GitHub Copilot CLI')
      assert.strictEqual(stats.tools, 2)
      assert.strictEqual(stats.reads, 0)
      assert.strictEqual(stats.errors, 1)
      assert.strictEqual(stats.tokensOut, 17)
      assert.strictEqual(stats.live, false)
      assert.deepStrictEqual(stats.commands.map(command => command.ok), [false])
      assert.deepStrictEqual(stats.files.map(file => file.path), ['src/app.ts'])
      assert.isTrue(scan.events.some(event => event.kind === 'prompt'))
      assert.isTrue(scan.events.some(event => event.kind === 'thinking'))
      assert.isTrue(scan.events.some(event => event.kind === 'tool_use' && event.tool === 'bash'))
      assert.isTrue(scan.events.some(event => event.kind === 'tool_result' && event.error))
      assert.strictEqual(scan.diagnostics().incidents[0]?.title, 'bash failed')
      assert.strictEqual(scan.diagnostics().turns[0]?.durationMs, 4_000)
      assert.strictEqual(scan.diagnostics().environment.cwd, '/repo')
    }).pipe(Effect.provide(testFileSystem({
      [PATH]: {
        mtime: 19,
        content: fixture.jsonl([
          fixture.sessionStart(),
          fixture.modelChange(),
          fixture.userMessage('Fix the integration'),
          fixture.turnStart(),
          fixture.assistantMessage({
            reasoning: 'Inspect the logs',
            toolRequests: [
              fixture.toolRequest('bash', 'bash-1', { command: 'pnpm test' }),
              fixture.toolRequest('edit', 'edit-1', { path: '/repo/src/app.ts', old_str: 'a', new_str: 'b' }),
            ],
          }),
          fixture.toolStart('bash', 'bash-1', { command: 'pnpm test' }),
          fixture.toolComplete('bash-1', { success: false, content: 'failed', second: 6 }),
          fixture.toolStart('edit', 'edit-1', { path: '/repo/src/app.ts' }, 6),
          fixture.toolComplete('edit-1', { success: true, content: 'updated', second: 6 }),
          fixture.turnEnd('turn-1', 7),
          fixture.shutdown(8),
        ]),
      },
    })))
  })

  it.effect('defers partial trailing JSON, counts malformed records and parts, and tolerates unknown events', () => {
    const scan = new CopilotCliTranscriptScan(PATH)
    return Effect.gen(function*() {
      yield* scan.refresh
      assert.strictEqual(scan.supported, true)
      assert.strictEqual(scan.malformed, 1)
      assert.strictEqual(scan.malformedParts, 1)
      assert.strictEqual(scan.unknown, 1)
      assert.strictEqual(scan.line, 4)
    }).pipe(Effect.provide(testFileSystem({
      [PATH]: fixture.jsonl([
        fixture.sessionStart(),
        fixture.event('future.event', {}),
        fixture.assistantMessage({ toolRequests: [{ toolCallId: 42 }] }),
      ], { malformed: true, trailingPartial: true }),
    })))
  })

  it.effect('marks open turns and tools live, and error-only completions failed', () => {
    const active = new CopilotCliTranscriptScan('/active/events.jsonl')
    const failed = new CopilotCliTranscriptScan('/failed/events.jsonl')
    const aborted = new CopilotCliTranscriptScan('/aborted/events.jsonl')
    return Effect.gen(function*() {
      yield* active.refresh
      yield* failed.refresh
      yield* aborted.refresh
      assert.strictEqual(active.statsAt(20).live, true)
      assert.strictEqual(active.statsAt(20).current?.tool, 'bash')
      assert.strictEqual(failed.statsAt(20).live, false)
      assert.strictEqual(failed.statsAt(20).errors, 1)
      assert.strictEqual(failed.statsAt(20).commands[0]?.ok, false)
      assert.strictEqual(aborted.statsAt(20).live, false)
      assert.strictEqual(aborted.diagnostics().incidents[0]?.category, 'interruption')
    }).pipe(Effect.provide(testFileSystem({
      '/active/events.jsonl': fixture.jsonl([
        fixture.sessionStart('active'),
        fixture.turnStart(),
        fixture.toolStart('bash', 'bash-1', { command: 'pnpm test' }),
      ]),
      '/failed/events.jsonl': fixture.jsonl([
        fixture.sessionStart('failed'),
        fixture.turnStart(),
        fixture.toolStart('bash', 'bash-1', { command: 'pnpm test' }),
        fixture.toolComplete('bash-1', { error: { message: 'boom' } }),
        fixture.turnEnd(),
      ]),
      '/aborted/events.jsonl': fixture.jsonl([
        fixture.sessionStart('aborted'),
        fixture.turnStart(),
        fixture.toolStart('bash', 'bash-1', { command: 'pnpm test' }),
        fixture.abort(),
      ]),
    })))
  })

  it.effect('appends without a reset and increments the revision when history is replaced', () => {
    const file = fixture.mutableEventFile(PATH, fixture.jsonl([
      fixture.sessionStart(),
      fixture.userMessage('First prompt'),
    ]))
    const scan = new CopilotCliTranscriptScan(PATH)
    return Effect.gen(function*() {
      yield* scan.refresh
      assert.strictEqual(scan.eventRevision, 0)
      assert.strictEqual(scan.events.length, 1)

      file.update(fixture.jsonl([
        fixture.sessionStart(),
        fixture.userMessage('First prompt'),
        fixture.assistantMessage({ content: 'First response' }),
      ]))
      yield* scan.refresh
      assert.strictEqual(scan.eventRevision, 0)
      assert.strictEqual(scan.events.length, 2)

      file.update(fixture.jsonl([
        fixture.sessionStart(),
        fixture.userMessage('Replacement prompt'),
      ]))
      yield* scan.refresh
      assert.strictEqual(scan.eventRevision, 1)
      assert.strictEqual(scan.events[0]?.body, 'Replacement prompt')
    }).pipe(Effect.provide(file.layer))
  })

  it.effect('rejects structurally incomplete logs without surfacing their events', () => {
    const scan = new CopilotCliTranscriptScan(PATH)
    return Effect.gen(function*() {
      yield* scan.refresh
      assert.strictEqual(scan.supported, false)
      assert.strictEqual(scan.structuralMalformed, 1)
      assert.deepStrictEqual(scan.events, [])
      assert.strictEqual(scan.statsAt(10).records, 0)
    }).pipe(Effect.provide(testFileSystem({
      [PATH]: fixture.jsonl([fixture.userMessage('orphan')]),
    })))
  })
})
