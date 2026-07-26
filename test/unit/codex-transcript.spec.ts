import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { CodexTranscriptScan } from '#server/utils/codex-transcript'
import * as fixture from '../fixtures/codex'
import { testFileSystem } from '../fixtures/filesystem'

const PATH = '/codex/sessions/2026/07/26/rollout-2026-07-26T08-00-00-session-1.jsonl'

describe('Codex transcript scan', () => {
  it.effect('normalizes messages, tools, plans, explicit failures, and changed files', () => {
    const scan = new CodexTranscriptScan(PATH)
    return Effect.gen(function*() {
      yield* scan.refresh
      const stats = scan.statsAt(10)

      assert.strictEqual(scan.metadata.id, 'session-1')
      assert.strictEqual(scan.metadata.cwd, '/repo')
      assert.strictEqual(scan.model, 'gpt-5.6-test')
      assert.strictEqual(scan.firstPrompt, 'Ship the unified browser')
      assert.strictEqual(stats.tools, 2)
      assert.strictEqual(stats.errors, 1)
      assert.deepStrictEqual(stats.todos, [
        { content: 'Discover storage', status: 'completed' },
        { content: 'Add Codex', status: 'in_progress' },
      ])
      assert.deepStrictEqual(stats.files.map(file => file.path), ['src/app.ts'])
      assert.isTrue(scan.events.some(event => event.kind === 'prompt'))
      assert.isTrue(scan.events.some(event => event.kind === 'thinking'))
      assert.isTrue(scan.events.some(event => event.kind === 'tool_use' && event.tool === 'exec_command'))
      assert.isTrue(scan.events.some(event => event.kind === 'tool_result' && event.error))
      assert.strictEqual(scan.diagnostics().incidents[0]?.title, 'exec_command failed')
    }).pipe(Effect.provide(testFileSystem({
      [PATH]: {
        mtime: 9,
        content: fixture.rollout([
          fixture.sessionMeta('session-1', { cwd: '/repo' }),
          fixture.turnContext({ cwd: '/repo' }),
          fixture.message('user', 'Ship the unified browser'),
          fixture.reasoning('Inspect the adapters'),
          fixture.toolCall('functions.update_plan', 'plan-1', {
            plan: [
              { step: 'Discover storage', status: 'completed' },
              { step: 'Add Codex', status: 'in_progress' },
            ],
          }, { custom: true }),
          fixture.toolOutput('plan-1', { ok: true }, { custom: true }),
          fixture.toolCall('functions.exec_command', 'cmd-1', { cmd: 'pnpm test' }, { ts: fixture.C0(7) }),
          fixture.toolOutput('cmd-1', JSON.stringify({ isError: true, content: 'failed' }), { ts: fixture.C0(8) }),
          fixture.event('patch_apply_end', {
            call_id: 'patch-1',
            success: true,
            changes: { '/repo/src/app.ts': { kind: 'update' } },
          }, fixture.C0(9)),
          fixture.event('task_complete', {}, fixture.C0(10)),
        ]),
      },
    })))
  })

  it.effect('defers a partial trailing line and reports malformed complete records', () => {
    const scan = new CodexTranscriptScan(PATH)
    return Effect.gen(function*() {
      yield* scan.refresh
      assert.strictEqual(scan.metadata.id, 'session-1')
      assert.strictEqual(scan.line, 2)
      assert.strictEqual(scan.malformed, 1)
    }).pipe(Effect.provide(testFileSystem({
      [PATH]: fixture.rollout(
        [fixture.sessionMeta('session-1', { cwd: '/repo' })],
        { malformed: true, trailingPartial: true },
      ),
    })))
  })

  it.effect('marks a recent started task live and a completed task idle', () => {
    const active = new CodexTranscriptScan('/active.jsonl')
    const complete = new CodexTranscriptScan('/complete.jsonl')
    return Effect.gen(function*() {
      yield* active.refresh
      yield* complete.refresh
      assert.strictEqual(active.statsAt(20).live, true)
      assert.strictEqual(active.statsAt(20_000).live, true)
      assert.strictEqual(complete.statsAt(20).live, false)
    }).pipe(Effect.provide(testFileSystem({
      '/active.jsonl': { mtime: 19, content: fixture.rollout([
        fixture.sessionMeta('active'), fixture.event('task_started'),
      ]) },
      '/complete.jsonl': { mtime: 19, content: fixture.rollout([
        fixture.sessionMeta('complete'), fixture.event('task_started'), fixture.event('task_complete'),
      ]) },
    })))
  })

  it.effect('uses only explicit command outcomes and preserves unknown results', () => {
    const scan = new CodexTranscriptScan(PATH)
    return Effect.gen(function*() {
      yield* scan.refresh
      assert.deepStrictEqual(scan.statsAt(20).commands.map(command => command.ok), [false, true, null])
      assert.strictEqual(scan.statsAt(20).errors, 1)
    }).pipe(Effect.provide(testFileSystem({
      [PATH]: fixture.rollout([
        fixture.sessionMeta('outcomes'),
        fixture.toolCall('exec_command', 'failed', { cmd: 'exit 1' }),
        fixture.toolOutput('failed', { exit_code: 1, output: 'failed' }),
        fixture.toolCall('exec_command', 'passed', { cmd: 'exit 0' }),
        fixture.toolOutput('passed', { exit_code: 0, output: 'passed' }),
        fixture.toolCall('exec_command', 'unknown', { cmd: 'unknown' }),
        fixture.toolOutput('unknown', 'unstructured output'),
      ]),
    })))
  })
})
