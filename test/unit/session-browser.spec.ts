import { assert, describe, it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Layer } from 'effect'
import { TestClock } from 'effect/testing'
import {
  getSessionActivity,
  getSessionEvents,
  loadSessionCatalog,
  SessionCatalogCache,
  SessionLocatorCache,
} from '#server/utils/session-catalog'
import { CopilotCliTranscriptScan } from '#server/utils/copilot-cli-transcript'
import { CopilotTranscriptScan } from '#server/utils/copilot-transcript'
import { FILE_CONCURRENCY } from '#server/utils/filesystem-concurrency'
import {
  CodexScanCache,
  CodexSessionsDirectory,
  CopilotScanCache,
  CopilotSessionStateDirectory,
  ProjectsDirectory,
  PromptCache,
  ScanCache,
  WorkingDirectory,
  VsCodeUserDataDirectories,
  type CopilotSessionLocation,
  type CopilotSessionScan,
} from '#server/utils/services'
import * as claude from '../fixtures/transcripts'
import * as codex from '../fixtures/codex'
import * as copilot from '../fixtures/copilot'
import * as copilotCli from '../fixtures/copilot-cli'
import {
  operationConcurrencyProbe,
  testFileSystem,
  type FakeTree,
} from '../fixtures/filesystem'

const CLAUDE = '/claude/projects'
const CODEX = '/codex/sessions'
const VSCODE = '/Library/Application Support/Code/User'
const COPILOT_CLI = '/copilot/session-state'
type FileSystemOptions = NonNullable<Parameters<typeof testFileSystem>[1]>

function recordingCopilotCache(locations: CopilotSessionLocation[]) {
  return Layer.effect(
    CopilotScanCache,
    Effect.sync(() => {
      const scans = new Map<string, CopilotSessionScan>()
      return CopilotScanCache.of({
        get: Effect.fn('recordingCopilotCache.get')(function*(location) {
          locations.push({ ...location })
          let scan = scans.get(location.path)
          if (!scan) {
            scan = location.format === 'cli'
              ? new CopilotCliTranscriptScan(location.path, location.application, location.workspace)
              : new CopilotTranscriptScan(location.path, location.application, location.workspace)
            scans.set(location.path, scan)
          }
          return yield* scan.refresh
        }),
        peek: path => Effect.sync(() => scans.get(path)),
      })
    }),
  )
}

function layer(
  tree: FakeTree,
  denied: ReadonlyArray<string> = [],
  copilotLocations?: CopilotSessionLocation[],
  beforeRead?: (path: string) => Effect.Effect<void>,
  fileSystemOptions: FileSystemOptions = {},
) {
  return Layer.mergeAll(
    SessionCatalogCache.layer,
    ScanCache.layer,
    CodexScanCache.layer,
    copilotLocations ? recordingCopilotCache(copilotLocations) : CopilotScanCache.layer,
    SessionLocatorCache.layer,
    PromptCache.layer,
    Layer.succeed(ProjectsDirectory)(CLAUDE),
    Layer.succeed(CodexSessionsDirectory)(CODEX),
    Layer.succeed(VsCodeUserDataDirectories)([VSCODE]),
    Layer.succeed(CopilotSessionStateDirectory)(COPILOT_CLI),
    Layer.succeed(WorkingDirectory)('/work'),
    testFileSystem(tree, { ...fileSystemOptions, denied, beforeRead }),
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

  it.effect('shares one Claude discovery budget across every catalog project', () => {
    const probe = operationConcurrencyProbe()
    const history = Object.fromEntries(
      Array.from({ length: 16 }, (_, project) =>
        Array.from({ length: 16 }, (_, session) => [
          `${CLAUDE}/project-${project}/session-${session}.jsonl`,
          claude.transcript([
            claude.userText(`Project ${project} session ${session}`),
          ]),
        ]),
      ).flat(),
    )
    const scopedProbe: FileSystemOptions = {
      beforeOperation: (_method, path) => path.startsWith(CLAUDE)
        ? probe.beforeOperation()
        : Effect.void,
      afterOperation: (_method, path) => path.startsWith(CLAUDE)
        ? probe.afterOperation()
        : Effect.void,
    }
    return Effect.gen(function*() {
      const catalog = yield* loadSessionCatalog('', 999_999)
      assert.strictEqual(
        catalog.projects.reduce(
          (total, project) => total + project.roots.length,
          0,
        ),
        256,
      )
      assert.isAtMost(probe.maximum(), FILE_CONCURRENCY)
      assert.isAbove(probe.maximum(), 1)
    }).pipe(Effect.provide(layer(
      history,
      [],
      undefined,
      undefined,
      scopedProbe,
    )))
  })

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

  it.effect('retains a catalog only while concurrent callers share its build', () => {
    let buildStarted!: Deferred.Deferred<void>
    let releaseBuild!: Deferred.Deferred<void>
    const beforeRead = (path: string) => path.endsWith('/claude-1.jsonl')
      ? Effect.gen(function*() {
          yield* Deferred.succeed(buildStarted, undefined)
          yield* Deferred.await(releaseBuild)
        })
      : Effect.void

    return Effect.gen(function*() {
      buildStarted = yield* Deferred.make<void>()
      releaseBuild = yield* Deferred.make<void>()
      const cache = yield* SessionCatalogCache
      const first = yield* Effect.forkChild(loadSessionCatalog('', 999_999))
      yield* Deferred.await(buildStarted)
      const second = yield* Effect.forkChild(loadSessionCatalog('', 999_999))
      yield* Effect.yieldNow
      assert.strictEqual(yield* cache.size, 1)

      yield* Deferred.succeed(releaseBuild, undefined)
      const catalogs = yield* Effect.all([
        Fiber.join(first),
        Fiber.join(second),
      ], { concurrency: 2 })
      assert.strictEqual(catalogs[0], catalogs[1])
      assert.strictEqual(yield* cache.size, 0)
    }).pipe(Effect.provide(layer({
      [`${CLAUDE}/repo/claude-1.jsonl`]: claude.transcript([
        claude.userText('Claude session'),
      ]),
    }, [], undefined, beforeRead)))
  })

  it.effect('removes interrupted catalog ownership', () => {
    let buildStarted!: Deferred.Deferred<void>
    const beforeRead = (path: string) => path.endsWith('/claude-1.jsonl')
      ? Effect.gen(function*() {
          yield* Deferred.succeed(buildStarted, undefined)
          return yield* Effect.never
        })
      : Effect.void

    return Effect.gen(function*() {
      buildStarted = yield* Deferred.make<void>()
      const cache = yield* SessionCatalogCache
      const building = yield* Effect.forkChild(loadSessionCatalog('', 999_999))
      yield* Deferred.await(buildStarted)
      assert.strictEqual(yield* cache.size, 1)

      yield* Fiber.interrupt(building)
      assert.strictEqual(yield* cache.size, 0)
    }).pipe(Effect.provide(layer({
      [`${CLAUDE}/repo/claude-1.jsonl`]: claude.transcript([
        claude.userText('Claude session'),
      ]),
    }, [], undefined, beforeRead)))
  })

  it.effect('cannot orphan ownership during immediate owner interruption', () => {
    let blockReads = true
    const beforeRead = (path: string) => path.endsWith('/claude-1.jsonl') && blockReads
      ? Effect.never
      : Effect.void

    return Effect.gen(function*() {
      const cache = yield* SessionCatalogCache
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const building = yield* Effect.forkChild(loadSessionCatalog('', 999_999))
        yield* Effect.yieldNow
        yield* Fiber.interrupt(building)
        assert.strictEqual(yield* cache.size, 0)
      }

      blockReads = false
      const catalog = yield* loadSessionCatalog('', 999_999)
      assert.strictEqual(catalog.projects[0]?.roots[0]?.key, 'claude-1')
      assert.strictEqual(yield* cache.size, 0)
    }).pipe(Effect.provide(layer({
      [`${CLAUDE}/repo/claude-1.jsonl`]: claude.transcript([
        claude.userText('Claude session'),
      ]),
    }, [], undefined, beforeRead)))
  })

  it.effect('keeps targeted event locators isolated by catalog range', () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(Date.parse('2026-07-28T08:00:00.000Z'))
      const visible = yield* loadSessionCatalog('', 999_999)
      assert.strictEqual(visible.projects[0]?.id, '/repo')

      const hidden = yield* loadSessionCatalog('', 24)
      assert.strictEqual(hidden.projects.length, 0)

      const locators = yield* SessionLocatorCache
      const original = yield* locators.get('', 999_999, '/repo', 'codex:codex-1')
      const other = yield* locators.get('', 24, '/repo', 'codex:codex-1')
      assert.strictEqual(original?.source, 'codex')
      assert.strictEqual(other, undefined)
    }).pipe(Effect.provide(layer({
      [`${CODEX}/2026/07/26/rollout-codex-1.jsonl`]: {
        content: codex.rollout([
          codex.sessionMeta('codex-1', { cwd: '/repo' }),
          codex.message('user', 'Visible in the unfiltered catalog'),
        ]),
        mtime: Date.parse('2026-07-26T08:00:00.000Z') / 1_000,
      },
    }))))

  it.effect('bounds locator snapshots and promotes recently read catalogs', () =>
    Effect.gen(function*() {
      const catalog = yield* loadSessionCatalog('', 999_999)
      assert.strictEqual(catalog.projects[0]?.id, '/repo')

      const locators = yield* SessionLocatorCache
      const location = yield* locators.get('', 999_999, '/repo', 'codex:codex-1')
      assert.isDefined(location)

      for (let index = 0; index < 7; index += 1) {
        yield* locators.replace(`project-${index}`, index, [location!])
      }
      assert.isDefined(yield* locators.get('', 999_999, '/repo', 'codex:codex-1'))

      yield* locators.replace('project-7', 7, [location!])
      assert.strictEqual(
        yield* locators.get('project-0', 0, '/repo', 'codex:codex-1'),
        undefined,
      )
      assert.isDefined(yield* locators.get('', 999_999, '/repo', 'codex:codex-1'))
    }).pipe(Effect.provide(layer({
      [`${CODEX}/2026/07/26/rollout-codex-1.jsonl`]: codex.rollout([
        codex.sessionMeta('codex-1', { cwd: '/repo' }),
        codex.message('user', 'Retained locator'),
      ]),
    }))))

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
      assert.strictEqual(catalog.sources[2]?.message, '1 malformed record skipped')
      assert.strictEqual(catalog.projects[0]?.roots[0]?.key, 'copilot:copilot-readable')
    }).pipe(Effect.provide(layer({
      [`${VSCODE}/workspaceStorage/repo/workspace.json`]: JSON.stringify({ folder: 'file:///repo' }),
      [`${VSCODE}/workspaceStorage/repo/chatSessions/copilot-readable.jsonl`]: copilot.log([
        copilot.initial(copilot.snapshot({ id: 'copilot-readable' })),
      ], { malformed: true }),
      [`${VSCODE}/globalStorage/transferredChatSessions/copilot-duplicate.jsonl`]: copilot.log([
        copilot.initial(copilot.snapshot({ id: 'copilot-readable' })),
      ]),
      [`${VSCODE}/globalStorage/emptyWindowChatSessions/generic.jsonl`]: copilot.log([
        copilot.initial(copilot.snapshot({
          id: 'generic',
          responder: 'Other Provider',
          requests: [copilot.request('generic-request', 'Not Copilot', {
            agentId: 'other.provider',
            copilotMetadata: false,
          })],
        })),
      ]),
    }))))

  it.effect('reports unreadable Claude transcripts without hiding readable sessions', () => {
    const denied = `${CLAUDE}/repo/denied.jsonl`
    return Effect.gen(function*() {
      const catalog = yield* loadSessionCatalog('', 999_999)
      assert.strictEqual(catalog.sources[0]?.state, 'degraded')
      assert.strictEqual(catalog.sources[0]?.sessions, 1)
      assert.match(catalog.sources[0]?.message || '', /1 unreadable transcript skipped/)
      assert.strictEqual(catalog.projects[0]?.roots[0]?.key, 'readable')
    }).pipe(Effect.provide(layer({
      [`${CLAUDE}/repo/readable.jsonl`]: claude.transcript([
        claude.userText('Readable session'),
      ]),
      [denied]: claude.transcript([
        claude.userText('Denied session'),
      ]),
    }, [denied])))
  })

  it.effect('preserves exact Copilot storage metadata for targeted event refreshes', () =>
    {
      const locations: CopilotSessionLocation[] = []
      return Effect.gen(function*() {
        yield* loadSessionCatalog('', 999_999)
        locations.length = 0
        yield* getSessionEvents('', 999_999, '/repo', 'copilot:vscode-location', 0, 0)
        yield* getSessionEvents('', 999_999, '/repo', 'copilot:cli-location', 0, 0)

        assert.deepStrictEqual(locations, [
          {
            path: `${VSCODE}/profiles/team/workspaceStorage/repo/chatSessions/vscode-location.jsonl`,
            application: 'VS Code profile',
            workspace: '/repo',
            format: 'vscode',
          },
          {
            path: `${COPILOT_CLI}/cli-location/events.jsonl`,
            application: 'Copilot CLI',
            workspace: '',
            format: 'cli',
          },
        ])
      }).pipe(Effect.provide(layer({
        [`${VSCODE}/profiles/team/workspaceStorage/repo/workspace.json`]: JSON.stringify({ folder: 'file:///repo' }),
        [`${VSCODE}/profiles/team/workspaceStorage/repo/chatSessions/vscode-location.jsonl`]: copilot.log([
          copilot.initial(copilot.snapshot({ id: 'vscode-location' })),
        ]),
        [`${COPILOT_CLI}/cli-location/events.jsonl`]: copilotCli.jsonl([
          copilotCli.sessionStart('cli-location'),
        ]),
      }, [], locations)))
    },
  )

  it.effect('merges only bounded per-agent tails from large session histories', () => {
    const rootRecords = [
      claude.assistant([
        claude.tool('Agent', 'spawn-bounded', { description: 'Bounded worker' }),
      ], { ts: '2026-07-25T18:00:00.000Z' }),
    ]
    const childRecords = []
    const startedAt = Date.parse('2026-07-25T19:00:00.000Z')
    for (let index = 0; index < 1_200; index += 1) {
      rootRecords.push(claude.userText(`Root event ${index}`, {
        ts: new Date(startedAt + index * 2_000).toISOString(),
      }))
      childRecords.push(claude.userText(`Child event ${index}`, {
        ts: new Date(startedAt + index * 2_000 + 1_000).toISOString(),
      }))
    }

    return Effect.gen(function*() {
      const activity = yield* getSessionActivity('', 999_999, '/repo', 'bounded', 37)
      assert.strictEqual(activity.total, 2_401)
      assert.strictEqual(activity.events.length, 37)
      assert.isTrue(activity.truncated)
      assert.deepStrictEqual(
        activity.events.map(event => event.ts || ''),
        [...activity.events]
          .sort((left, right) => (left.ts || '').localeCompare(right.ts || ''))
          .map(event => event.ts || ''),
      )
      assert.deepStrictEqual(
        new Set(activity.events.map(event => event.agentKey)),
        new Set(['bounded', 'bounded/agent-bounded']),
      )
      assert.deepStrictEqual(
        [activity.events[0]?.body, activity.events.at(-1)?.body],
        ['Child event 1181', 'Child event 1199'],
      )
      assert.deepStrictEqual(
        [activity.events[0]?.ts, activity.events.at(-1)?.ts],
        [
          new Date(startedAt + 1_181 * 2_000 + 1_000).toISOString(),
          new Date(startedAt + 1_199 * 2_000 + 1_000).toISOString(),
        ],
      )

      const empty = yield* getSessionActivity('', 999_999, '/repo', 'bounded', 0)
      assert.strictEqual(empty.total, 2_401)
      assert.deepStrictEqual(empty.events, [])
      assert.isTrue(empty.truncated)
    }).pipe(Effect.provide(layer({
      [`${CLAUDE}/repo/bounded.jsonl`]: claude.transcript(rootRecords),
      [`${CLAUDE}/repo/bounded/subagents/agent-bounded.jsonl`]: claude.transcript(childRecords),
      [`${CLAUDE}/repo/bounded/subagents/agent-bounded.meta.json`]: JSON.stringify({
        agentType: 'implementation-worker',
        description: 'Bounded worker',
        toolUseId: 'spawn-bounded',
      }),
    })))
  })

  it.effect('selects the newest activity by timestamp when transcript order differs', () =>
    Effect.gen(function*() {
      const activity = yield* getSessionActivity('', 999_999, '/repo', 'unordered', 2)
      assert.strictEqual(activity.total, 3)
      assert.isTrue(activity.truncated)
      assert.deepStrictEqual(
        activity.events.map(event => [event.ts, event.body]),
        [
          ['2026-07-25T18:00:10.000Z', 'Ten'],
          ['2026-07-25T18:00:12.000Z', 'Twelve'],
        ],
      )
    }).pipe(Effect.provide(layer({
      [`${CLAUDE}/repo/unordered.jsonl`]: claude.transcript([
        claude.userText('Ten', { ts: '2026-07-25T18:00:10.000Z' }),
        claude.userText('Twelve', { ts: '2026-07-25T18:00:12.000Z' }),
        claude.userText('Nine', { ts: '2026-07-25T18:00:09.000Z' }),
      ]),
    }))))
})
