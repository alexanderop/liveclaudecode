import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import {
  buildCopilotTree,
  collectCopilotSessions,
} from '#server/utils/copilot-runs'
import {
  CopilotScanCache,
  VsCodeUserDataDirectories,
} from '#server/utils/services'
import * as fixture from '../fixtures/copilot'
import { testFileSystem, type FakeTree } from '../fixtures/filesystem'

const STABLE = '/Library/Application Support/Code/User'
const INSIDERS = '/Library/Application Support/Code - Insiders/User'

function session(root: string, workspace: string, id: string): string {
  return `${root}/workspaceStorage/${workspace}/chatSessions/${id}.jsonl`
}

function layer(tree: FakeTree, denied: ReadonlyArray<string> = []) {
  return Layer.mergeAll(
    CopilotScanCache.layer,
    Layer.succeed(VsCodeUserDataDirectories)([STABLE, INSIDERS]),
    testFileSystem(tree, { denied }),
  )
}

describe('VS Code Copilot discovery', () => {
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
})
