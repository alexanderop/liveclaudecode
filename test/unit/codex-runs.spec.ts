import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { buildCodexTree, collectCodexRollouts } from '#server/utils/codex-runs'
import { CodexScanCache, CodexSessionsDirectory } from '#server/utils/services'
import * as fixture from '../fixtures/codex'
import { testFileSystem, type FakeTree } from '../fixtures/filesystem'

const ROOT = '/codex/sessions'
const day = `${ROOT}/2026/07/26`

const tree: FakeTree = {
  [`${day}/rollout-a-parent.jsonl`]: {
    mtime: 5,
    content: fixture.rollout([
      fixture.sessionMeta('parent', { cwd: '/repo', originator: 'Codex Desktop', source: 'vscode' }),
      fixture.turnContext({ cwd: '/repo' }),
      fixture.message('user', 'Parent session', { ts: fixture.C0(2) }),
      fixture.event('task_complete', {}, fixture.C0(10)),
    ]),
  },
  [`${day}/rollout-b-child.jsonl`]: {
    mtime: 6,
    content: fixture.rollout([
      fixture.sessionMeta('child', {
        cwd: '/repo',
        source: fixture.subagentSource('parent', { nickname: 'Ada', role: 'worker' }),
      }),
      fixture.turnContext({ cwd: '/repo' }),
      fixture.message('assistant', 'Child done', { ts: fixture.C0(15) }),
      fixture.event('task_complete', {}, fixture.C0(16)),
    ]),
  },
  [`${day}/rollout-c-other.jsonl`]: {
    mtime: 7,
    content: fixture.rollout([
      fixture.sessionMeta('other', { cwd: '' }),
      fixture.message('user', 'Projectless session', { ts: fixture.C0(20) }),
      fixture.event('task_complete', {}, fixture.C0(21)),
    ], { malformed: true }),
  },
  [`${ROOT}/2026/07/25/rollout-old-copy.jsonl`]: {
    mtime: 1,
    content: fixture.rollout([
      fixture.sessionMeta('other', { cwd: '/old' }),
      fixture.message('user', 'Stale duplicate', { ts: fixture.C0(1) }),
    ]),
  },
}

const TestLayer = Layer.mergeAll(
  CodexScanCache.layer,
  Layer.succeed(CodexSessionsDirectory)(ROOT),
  testFileSystem(tree),
)

describe('Codex rollout hierarchy', () => {
  it.effect('deduplicates IDs, links subagents, retains projectless roots, and sorts by activity', () =>
    Effect.gen(function*() {
      const built = yield* buildCodexTree(999_999)
      assert.strictEqual(built.duplicates, 1)
      assert.strictEqual(built.malformed, 1)
      assert.strictEqual(built.unreadable, 0)
      assert.deepStrictEqual(built.roots.map(root => root.key), ['codex:other', 'codex:parent'])
      assert.strictEqual(built.roots[0]?.label, 'Projectless session')
      assert.strictEqual(built.cwdByKey.get('codex:other'), '')

      const parent = built.byKey.get('codex:parent')!
      assert.strictEqual(parent.source, 'codex')
      assert.strictEqual(parent.sourceDetail, 'Codex Desktop')
      assert.strictEqual(parent.children[0]?.key, 'codex:child')
      assert.strictEqual(parent.children[0]?.label, 'Ada')
      assert.strictEqual(parent.children[0]?.agentType, 'worker')
      assert.strictEqual(parent.subAgents, 1)
    }).pipe(Effect.provide(TestLayer)))

  it.effect('returns a typed filesystem failure when storage is unavailable', () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(collectCodexRollouts(24))
      assert.strictEqual(error._tag, 'PlatformError')
      if (error._tag === 'PlatformError') assert.strictEqual(error.reason._tag, 'NotFound')
    }).pipe(Effect.provide(Layer.mergeAll(
      Layer.succeed(CodexSessionsDirectory)(ROOT),
      testFileSystem({}),
    ))))

  it.effect('keeps readable sessions when one rollout cannot be inspected', () =>
    Effect.gen(function*() {
      const built = yield* buildCodexTree(999_999)
      assert.deepStrictEqual(built.roots.map(root => root.key), ['codex:parent'])
      assert.strictEqual(built.unreadable, 1)
    }).pipe(Effect.provide(Layer.mergeAll(
      CodexScanCache.layer,
      Layer.succeed(CodexSessionsDirectory)(ROOT),
      testFileSystem({
        [`${day}/rollout-parent.jsonl`]: fixture.rollout([
          fixture.sessionMeta('parent', { cwd: '/repo' }),
          fixture.message('user', 'Readable'),
        ]),
        [`${day}/rollout-denied.jsonl`]: fixture.rollout([
          fixture.sessionMeta('denied', { cwd: '/repo' }),
        ]),
      }, { denied: [`${day}/rollout-denied.jsonl`] }),
    ))))
})
