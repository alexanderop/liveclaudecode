import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { loadSessionCatalog, SessionCatalogCache } from '#server/utils/session-browser'
import {
  CodexScanCache,
  CodexSessionsDirectory,
  CopilotScanCache,
  ProjectsDirectory,
  PromptCache,
  ScanCache,
  SessionLocatorCache,
  WorkingDirectory,
  VsCodeUserDataDirectories,
} from '#server/utils/services'
import * as claude from '../fixtures/transcripts'
import * as codex from '../fixtures/codex'
import * as copilot from '../fixtures/copilot'
import { testFileSystem, type FakeTree } from '../fixtures/filesystem'

const CLAUDE = '/claude/projects'
const CODEX = '/codex/sessions'
const VSCODE = '/Library/Application Support/Code/User'

function layer(tree: FakeTree, denied: ReadonlyArray<string> = []) {
  return Layer.mergeAll(
    SessionCatalogCache.layer,
    ScanCache.layer,
    CodexScanCache.layer,
    CopilotScanCache.layer,
    SessionLocatorCache.layer,
    PromptCache.layer,
    Layer.succeed(ProjectsDirectory)(CLAUDE),
    Layer.succeed(CodexSessionsDirectory)(CODEX),
    Layer.succeed(VsCodeUserDataDirectories)([VSCODE]),
    Layer.succeed(WorkingDirectory)('/work'),
    testFileSystem(tree, { denied }),
  )
}

describe('unified session catalog', () => {
  it.effect('merges Claude and Codex by project and sorts their roots by latest activity', () =>
    Effect.gen(function*() {
      const catalog = yield* loadSessionCatalog('', 999_999)
      assert.strictEqual(catalog.projects.length, 2)
      assert.strictEqual(catalog.projects[0]?.name, 'repo')
      assert.deepStrictEqual(
        catalog.projects[0]?.roots.map(root => [root.key, root.source]),
        [
          ['codex:codex-1', 'codex'],
          ['copilot:copilot-1', 'copilot'],
          ['claude-1', 'claude'],
        ],
      )
      assert.strictEqual(catalog.projects[1]?.name, 'Unassigned')
      assert.strictEqual(catalog.projects[1]?.roots[0]?.source, 'codex')
      assert.deepStrictEqual(catalog.sources.map(source => source.state), ['ready', 'degraded', 'ready'])
      assert.strictEqual(catalog.sources[1]?.malformed, 1)
    }).pipe(Effect.provide(layer({
      [`${CLAUDE}/repo/claude-1.jsonl`]: claude.transcript([
        claude.userText('Claude session', { ts: '2026-07-26T08:00:01.000Z' }),
        claude.assistant([claude.text('Done')], { ts: '2026-07-26T08:00:02.000Z' }),
      ]),
      [`${CODEX}/2026/07/26/rollout-codex-1.jsonl`]: codex.rollout([
        codex.sessionMeta('codex-1', { cwd: '/repo' }),
        codex.message('user', 'Codex session', { ts: '2026-07-26T08:00:03.000Z' }),
        codex.event('task_complete', {}, '2026-07-26T08:00:04.000Z'),
      ]),
      [`${CODEX}/2026/07/26/rollout-codex-2.jsonl`]: codex.rollout([
        codex.sessionMeta('codex-2'),
        codex.message('user', 'No project', { ts: '2026-07-26T08:00:00.000Z' }),
      ], { malformed: true }),
      [`${VSCODE}/workspaceStorage/repo/workspace.json`]: JSON.stringify({ folder: 'file:///repo' }),
      [`${VSCODE}/workspaceStorage/repo/chatSessions/copilot-1.jsonl`]: copilot.log([
        copilot.initial(copilot.snapshot({
          id: 'copilot-1',
          requests: [copilot.request('copilot-request', 'Copilot session', {
            timestamp: copilot.T0 + 3_000,
            completedAt: copilot.T0 + 3_500,
          })],
        })),
      ]),
    }))))

  it.effect('never serves a stale catalog to a later load', () => {
    const entry = {
      content: claude.transcript([
        claude.userText('Claude session', { ts: '2026-07-26T08:00:01.000Z' }),
      ]),
      mtime: 100,
    }
    return Effect.gen(function*() {
      const first = yield* loadSessionCatalog('', 999_999)
      assert.strictEqual(first.projects[0]?.roots[0]?.records, 1)

      entry.content += claude.transcript([
        claude.assistant([claude.text('Done')], { ts: '2026-07-26T08:00:02.000Z' }),
      ])
      entry.mtime = 160

      const rebuilt = yield* loadSessionCatalog('', 999_999)
      assert.strictEqual(rebuilt.projects[0]?.roots[0]?.records, 2)
    }).pipe(Effect.provide(layer({ [`${CLAUDE}/repo/claude-1.jsonl`]: entry })))
  })

  it.effect('returns source availability as data when one storage root is missing', () =>
    Effect.gen(function*() {
      const catalog = yield* loadSessionCatalog('', 999_999)
      assert.strictEqual(catalog.projects.length, 1)
      assert.strictEqual(catalog.projects[0]?.roots[0]?.source, 'claude')
      assert.strictEqual(catalog.sources[0]?.state, 'ready')
      assert.strictEqual(catalog.sources[1]?.state, 'unavailable')
      assert.strictEqual(catalog.sources[2]?.state, 'unavailable')
      assert.isTrue(catalog.sources[1]?.message.includes('NotFound'))
    }).pipe(Effect.provide(layer({
      [`${CLAUDE}/repo/claude-1.jsonl`]: claude.transcript([
        claude.userText('Claude only'),
      ]),
    }))))

  it.effect('supports Codex when Claude storage is unavailable', () =>
    Effect.gen(function*() {
      const catalog = yield* loadSessionCatalog('', 999_999)
      assert.strictEqual(catalog.sources[0]?.state, 'unavailable')
      assert.strictEqual(catalog.sources[1]?.state, 'ready')
      assert.strictEqual(catalog.projects[0]?.roots[0]?.key, 'codex:codex-only')
    }).pipe(Effect.provide(layer({
      [`${CODEX}/2026/07/26/rollout-codex-only.jsonl`]: codex.rollout([
        codex.sessionMeta('codex-only', { cwd: '/repo' }),
        codex.message('user', 'Codex only'),
      ]),
    }))))

  it.effect('reports Claude ready before a configured repository has its first transcript', () =>
    Effect.gen(function*() {
      const catalog = yield* loadSessionCatalog('/work/new-repo', 999_999)
      assert.strictEqual(catalog.sources[0]?.state, 'ready')
      assert.strictEqual(catalog.sources[0]?.sessions, 0)
    }).pipe(Effect.provide(layer({
      '/work/new-repo/README.md': '#',
    }))))

  it.effect('keeps readable Codex sessions when another rollout is unreadable', () => {
    const unreadable = `${CODEX}/2026/07/26/rollout-unreadable.jsonl`
    return Effect.gen(function*() {
      const catalog = yield* loadSessionCatalog('', 999_999)
      assert.strictEqual(catalog.sources[1]?.state, 'degraded')
      assert.strictEqual(catalog.sources[1]?.sessions, 1)
      assert.match(catalog.sources[1]?.message || '', /1 unreadable rollout skipped/)
      assert.strictEqual(catalog.projects[0]?.roots[0]?.key, 'codex:codex-readable')
    }).pipe(Effect.provide(layer({
      [`${CODEX}/2026/07/26/rollout-readable.jsonl`]: codex.rollout([
        codex.sessionMeta('codex-readable', { cwd: '/repo' }),
        codex.message('user', 'Readable'),
      ]),
      [unreadable]: codex.rollout([
        codex.sessionMeta('codex-unreadable', { cwd: '/repo' }),
      ]),
    }, [unreadable])))
  })

  it.effect('reports a degraded Copilot source without hiding readable sessions', () =>
    Effect.gen(function*() {
      const catalog = yield* loadSessionCatalog('', 999_999)
      assert.strictEqual(catalog.sources[2]?.state, 'degraded')
      assert.strictEqual(catalog.sources[2]?.sessions, 1)
      assert.strictEqual(catalog.sources[2]?.malformed, 1)
      assert.strictEqual(catalog.projects[0]?.roots[0]?.key, 'copilot:copilot-readable')
    }).pipe(Effect.provide(layer({
      [`${VSCODE}/workspaceStorage/repo/workspace.json`]: JSON.stringify({ folder: 'file:///repo' }),
      [`${VSCODE}/workspaceStorage/repo/chatSessions/copilot-readable.jsonl`]: copilot.log([
        copilot.initial(copilot.snapshot({ id: 'copilot-readable' })),
      ], { malformed: true }),
    }))))
})
