import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import {
  buildCopilotTree,
  collectCopilotSessions,
} from '#server/utils/copilot-runs'
import {
  CopilotScanCache,
  CopilotSessionStateDirectory,
  VsCodeUserDataDirectories,
} from '#server/utils/services'
import { FILE_CONCURRENCY } from '#server/utils/filesystem-concurrency'
import * as fixture from '../fixtures/copilot'
import * as cliFixture from '../fixtures/copilot-cli'
import {
  operationConcurrencyProbe,
  testFileSystem,
  type FakeTree,
} from '../fixtures/filesystem'

const STABLE = '/Library/Application Support/Code/User'
const INSIDERS = '/Library/Application Support/Code - Insiders/User'
const CLI = '/copilot/session-state'

function session(root: string, workspace: string, id: string): string {
  return `${root}/workspaceStorage/${workspace}/chatSessions/${id}.jsonl`
}

/**
 * Where Copilot keeps its transcripts. Two frozen lists, shared by the whole
 * block; the scan cache and the filesystem stay per test so no scan or permit
 * pool outlives the case that built it.
 */
const storageRoots = Layer.mergeAll(
  Layer.succeed(CopilotSessionStateDirectory)(CLI),
  Layer.succeed(VsCodeUserDataDirectories)([STABLE, INSIDERS]),
)

function layer(tree: FakeTree, denied: ReadonlyArray<string> = []) {
  return Layer.mergeAll(CopilotScanCache.layer, testFileSystem(tree, { denied }))
}

describe('VS Code Copilot discovery', () => {
  it.layer(storageRoots)('across the standard storage roots', (it) => {
    it.effect('discovers current Copilot CLI session event logs', () =>
      Effect.gen(function*() {
        const built = yield* buildCopilotTree(0)
        assert.strictEqual(built.rootsPresent, 1)
        assert.strictEqual(built.roots.length, 1)
        assert.strictEqual(built.roots[0]?.key, 'copilot:cli-session')
        assert.strictEqual(built.roots[0]?.sourceDetail, 'Copilot CLI')
        assert.strictEqual(built.cwdByKey.get('copilot:cli-session'), '/repo')
      }).pipe(Effect.provide(layer({
        [`${CLI}/cli-session/events.jsonl`]: [
          JSON.stringify({
            id: 'event-1',
            timestamp: '2026-07-30T10:00:00.000Z',
            type: 'session.start',
            data: {
              sessionId: 'cli-session',
              version: 1,
              producer: 'copilot-agent',
              copilotVersion: '1.0.75',
              startTime: '2026-07-30T10:00:00.000Z',
              context: { cwd: '/repo', gitRoot: '/repo', branch: 'main' },
            },
          }),
          JSON.stringify({
            id: 'event-2',
            timestamp: '2026-07-30T10:00:01.000Z',
            type: 'user.message',
            data: { content: 'Inspect this repository' },
          }),
          JSON.stringify({
            id: 'event-3',
            timestamp: '2026-07-30T10:00:02.000Z',
            type: 'assistant.message',
            data: { content: 'Done.', model: 'gpt-5', outputTokens: 4 },
          }),
          JSON.stringify({
            id: 'event-4',
            timestamp: '2026-07-30T10:00:03.000Z',
            type: 'assistant.turn_end',
            data: { turnId: 'turn-1' },
          }),
          '',
        ].join('\n'),
      }))))

    it.effect('counts deduplicated VS Code subagent tool calls without synthetic children', () =>
      Effect.gen(function*() {
        const built = yield* buildCopilotTree(0)
        const root = built.byKey.get('copilot:vscode-subagents')
        assert.strictEqual(root?.subAgents, 2)
        assert.deepStrictEqual(root?.children, [])
      }).pipe(Effect.provide(layer({
        [session(STABLE, 'workspace', 'vscode-subagents')]: fixture.log([
          fixture.initial(fixture.snapshot({
            id: 'vscode-subagents',
            requests: [fixture.request('request-1', 'Delegate the investigation', {
              response: [
                fixture.tool('execution_subagent', 'agent-1', { complete: false }),
                fixture.tool('execution_subagent', 'agent-1'),
                fixture.tool('search_subagent', 'search-1'),
                fixture.tool('read_agent', 'read-1'),
                fixture.tool('task_complete', 'complete-1'),
              ],
            })],
          })),
        ]),
      }))))

    it.effect('counts deduplicated Copilot CLI task and runSubagent calls', () =>
      Effect.gen(function*() {
        const built = yield* buildCopilotTree(0)
        const root = built.byKey.get('copilot:cli-subagents')
        assert.strictEqual(root?.subAgents, 3)
        assert.deepStrictEqual(root?.children, [])
      }).pipe(Effect.provide(layer({
        [`${CLI}/cli-subagents/events.jsonl`]: cliFixture.jsonl([
          cliFixture.sessionStart('cli-subagents'),
          cliFixture.assistantMessage({
            toolRequests: [
              cliFixture.toolRequest('task', 'task-1', {
                agent_type: 'explore',
                name: 'First task',
                description: 'Inspect the parser',
                mode: 'background',
              }),
            ],
          }),
          cliFixture.toolStart('task', 'task-1', { description: 'Inspect the parser' }),
          cliFixture.toolStart('task', 'task-2', { description: 'Inspect the tests' }, 6),
          cliFixture.toolStart('runSubagent', 'agent-3', { description: 'Check the UI' }, 7),
        ]),
      }))))

    it.effect('does not count non-spawning Copilot tools as subagents', () =>
      Effect.gen(function*() {
        const built = yield* buildCopilotTree(0)
        assert.strictEqual(built.byKey.get('copilot:cli-non-spawns')?.subAgents, 0)
      }).pipe(Effect.provide(layer({
        [`${CLI}/cli-non-spawns/events.jsonl`]: cliFixture.jsonl([
          cliFixture.sessionStart('cli-non-spawns'),
          cliFixture.toolStart('read_agent', 'read-1', { agent_id: 'agent-1' }),
          cliFixture.toolStart('task_complete', 'complete-1', {}),
        ]),
      }))))

    it.effect('uses zero hours to include all history', () =>
      Effect.gen(function*() {
        const discovery = yield* collectCopilotSessions(0)
        assert.strictEqual(discovery.locations.length, 3)
      }).pipe(Effect.provide(layer({
        [`${STABLE}/workspaceStorage/stable-workspace/workspace.json`]: JSON.stringify({ folder: 'file:///repo' }),
        [session(STABLE, 'stable-workspace', 'stable')]: { mtime: 1, content: fixture.log([
          fixture.initial(fixture.snapshot({ id: 'stable' })),
        ]) },
        [session(INSIDERS, 'insiders-workspace', 'insiders')]: { mtime: 2, content: fixture.log([
          fixture.initial(fixture.snapshot({ id: 'insiders' })),
        ]) },
        [`${INSIDERS}/globalStorage/emptyWindowChatSessions/unassigned.jsonl`]: { mtime: 3, content: fixture.log([
          fixture.initial(fixture.snapshot({ id: 'unassigned' })),
        ]) },
      }))))

    it.effect('shares one filesystem budget across nested VS Code stores', () => {
      const probe = operationConcurrencyProbe()
      const history = Object.fromEntries(
        Array.from({ length: 16 }, (_, parent) =>
          Array.from({ length: 16 }, (_, child) => {
            const id = `session-${parent}-${child}`
            return [
              session(STABLE, `workspace-${parent}`, id),
              fixture.log([fixture.initial(fixture.snapshot({ id }))]),
            ] as const
          })).flat(),
      )
      return Effect.gen(function*() {
        const discovery = yield* collectCopilotSessions(0)
        assert.strictEqual(discovery.locations.length, 256)
        assert.isAtMost(probe.maximum(), FILE_CONCURRENCY)
        assert.isAbove(probe.maximum(), 1)
      }).pipe(Effect.provide(Layer.mergeAll(
        Layer.succeed(CopilotSessionStateDirectory)(CLI),
        Layer.succeed(VsCodeUserDataDirectories)([STABLE]),
        testFileSystem(history, probe),
      )))
    })

    it.effect('discovers Stable, Insiders, profiles, and workspace associations', () =>
      Effect.gen(function*() {
        const discovery = yield* collectCopilotSessions(999_999)
        assert.strictEqual(discovery.rootsPresent, 2)
        assert.strictEqual(discovery.locations.length, 3)
        assert.deepStrictEqual(
          discovery.locations.filter(location => location.workspace).map(location => location.workspace),
          ['/repo', 'vscode-remote://ssh-remote+example/workspace'],
        )
        assert.isTrue(discovery.locations.some(location => location.application === 'VS Code Insiders profile'))
      }).pipe(Effect.provide(layer({
        [`${STABLE}/workspaceStorage/stable-workspace/workspace.json`]: JSON.stringify({ folder: 'file:///repo' }),
        [session(STABLE, 'stable-workspace', 'stable')]: fixture.log([
          fixture.initial(fixture.snapshot({ id: 'stable' })),
        ]),
        [`${INSIDERS}/workspaceStorage/remote-workspace/workspace.json`]: JSON.stringify({
          folder: 'vscode-remote://ssh-remote+example/workspace',
        }),
        [session(INSIDERS, 'remote-workspace', 'remote')]: fixture.log([
          fixture.initial(fixture.snapshot({ id: 'remote' })),
        ]),
        [`${INSIDERS}/profiles/profile-a/globalStorage/emptyWindowChatSessions/unassigned.jsonl`]: fixture.log([
          fixture.initial(fixture.snapshot({ id: 'unassigned' })),
        ]),
      }))))

    it.effect('deduplicates only matching session ids and selects the newest snapshot', () =>
      Effect.gen(function*() {
        const tree = yield* buildCopilotTree(999_999)
        assert.strictEqual(tree.rootsPresent, 2)
        assert.strictEqual(tree.duplicates, 1)
        assert.strictEqual(tree.roots.length, 2)
        assert.strictEqual(tree.byKey.get('copilot:same')?.label, 'Newer snapshot')
        assert.strictEqual(tree.cwdByKey.get('copilot:same'), '/repo')
        assert.strictEqual(tree.genericExcluded, 1)
      }).pipe(Effect.provide(layer({
        [`${STABLE}/workspaceStorage/a/workspace.json`]: JSON.stringify({ folder: 'file:///repo' }),
        [session(STABLE, 'a', 'same')]: { mtime: 10, content: fixture.log([
          fixture.initial(fixture.snapshot({ id: 'same', title: 'Older snapshot' })),
        ]) },
        [`${INSIDERS}/workspaceStorage/b/workspace.json`]: JSON.stringify({ folder: 'file:///repo' }),
        [session(INSIDERS, 'b', 'same')]: { mtime: 20, content: fixture.log([
          fixture.initial(fixture.snapshot({ id: 'same', title: 'Newer snapshot' })),
        ]) },
        [session(INSIDERS, 'b', 'different')]: { mtime: 15, content: fixture.log([
          fixture.initial(fixture.snapshot({ id: 'different', title: 'Different conversation' })),
        ]) },
        [session(INSIDERS, 'b', 'generic')]: fixture.log([
          fixture.initial(fixture.snapshot({
            id: 'generic',
            responder: 'Other Provider',
            requests: [fixture.request('generic-request', 'Not Copilot', {
              agentId: 'other.provider',
              copilotMetadata: false,
            })],
          })),
        ]),
      }))))

    it.effect('keeps readable sessions when another file is unreadable and tolerates a missing variant', () => {
      const readable = session(INSIDERS, 'workspace', 'readable')
      const unreadable = session(INSIDERS, 'workspace', 'unreadable')
      return Effect.gen(function*() {
        const tree = yield* buildCopilotTree(999_999)
        assert.strictEqual(tree.rootsPresent, 1)
        assert.strictEqual(tree.roots.length, 1)
        assert.strictEqual(tree.roots[0]?.key, 'copilot:readable')
        assert.strictEqual(tree.unreadable, 1)
      }).pipe(Effect.provide(layer({
        [`${INSIDERS}/workspaceStorage/workspace/workspace.json`]: JSON.stringify({ folder: 'file:///repo' }),
        [readable]: fixture.log([fixture.initial(fixture.snapshot({ id: 'readable' }))]),
        [unreadable]: fixture.log([fixture.initial(fixture.snapshot({ id: 'unreadable' }))]),
      }, [unreadable])))
    })

    it.effect('keeps sessions when workspace metadata is unreadable and reports degradation', () => {
      const workspace = `${INSIDERS}/workspaceStorage/workspace/workspace.json`
      const readable = session(INSIDERS, 'workspace', 'readable')
      return Effect.gen(function*() {
        const discovery = yield* collectCopilotSessions(999_999)
        assert.strictEqual(discovery.rootsPresent, 1)
        assert.strictEqual(discovery.locations.length, 1)
        assert.strictEqual(discovery.locations[0]?.path, readable)
        assert.strictEqual(discovery.locations[0]?.workspace, '')
        assert.strictEqual(discovery.unreadable, 1)
      }).pipe(Effect.provide(layer({
        [workspace]: JSON.stringify({ folder: 'file:///repo' }),
        [readable]: fixture.log([fixture.initial(fixture.snapshot({ id: 'readable' }))]),
      }, [workspace])))
    })
  })
})
