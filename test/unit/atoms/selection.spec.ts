import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import type { RunNode } from '#shared/types/run'
import { makeFiltersAtoms } from '~/atoms/filters'
import { makePreferencesAtoms } from '~/atoms/preferences'
import { makeRangeAtoms } from '~/atoms/range'
import { makeSelectionAtoms } from '~/atoms/selection'
import { makeTreeAtoms } from '~/atoms/tree'
import { testAtoms } from '../../fixtures/atom-registry'
import { runNode, treeResponse } from '../../fixtures/runs'
import { stubApi } from '../../fixtures/stub-api'

/**
 * A whole dashboard's worth of atoms over one tree response.
 *
 * Built per test from the factories rather than reaching for the live
 * instances: the selection is the one place where four modules meet, so a test
 * that shared any of them would be asserting against another test's state.
 */
const withSelection = Effect.fn('withSelection')(function*(roots: RunNode[]) {
  const stub = stubApi({ tree: () => Effect.succeed(treeResponse(roots)) })
  const atoms = yield* testAtoms(stub.layer)
  const tree = makeTreeAtoms(atoms.runtime, makeRangeAtoms())
  const filters = makeFiltersAtoms(tree)
  const preferences = makePreferencesAtoms()
  const selection = makeSelectionAtoms(tree, filters, preferences)
  // Nothing derives until the tree has answered.
  yield* atoms.mount(tree.tree)
  yield* atoms.settled(tree.tree)
  return { atoms, filters, preferences, selection }
})

/** A session whose only live agent is the subagent `key`. */
const sessionWithLiveChild = (key: string, mtime: number): RunNode =>
  runNode({
    key: 'session',
    children: [
      runNode({ key, kind: 'subagent', label: key, live: true, subLive: true, mtime }),
    ],
    subAgents: 1,
    subLive: true,
  })

describe('selection atoms', () => {
  it.effect('opens on the deepest live agent of the first non-empty project', () =>
    Effect.gen(function*() {
      const { atoms, selection } = yield* withSelection([sessionWithLiveChild('worker', 1)])

      assert.deepStrictEqual(yield* atoms.get(selection.selection), {
        project: '/repo',
        key: 'worker',
      })
      assert.strictEqual((yield* atoms.get(selection.root))?.key, 'session')
      assert.strictEqual((yield* atoms.get(selection.node))?.key, 'worker')
    }))

  it.effect('does not open on a session the filters are hiding', () =>
    Effect.gen(function*() {
      const { atoms, filters, selection } = yield* withSelection([
        sessionWithLiveChild('worker', 1),
      ])

      yield* atoms.set(filters.query, 'nothing matches this')

      // The bootstrap reads the *visible* projects, so a filtered-out session is
      // not what the dashboard opens on.
      assert.isNull(yield* atoms.get(selection.selection))
    }))

  it.effect('keeps an explicit choice while follow-active is off', () =>
    Effect.gen(function*() {
      const { atoms, selection } = yield* withSelection([sessionWithLiveChild('worker', 1)])

      yield* atoms.set(selection.selection, { project: '/repo', key: 'session' })

      assert.strictEqual((yield* atoms.get(selection.selection))?.key, 'session')
    }))

  it.effect('overrides an explicit choice with the newest live agent when following', () =>
    Effect.gen(function*() {
      const root = runNode({
        key: 'session',
        children: [
          runNode({ key: 'older', kind: 'subagent', live: true, mtime: 1 }),
          runNode({ key: 'newer', kind: 'subagent', live: true, mtime: 2 }),
        ],
        subAgents: 2,
        subLive: true,
      })
      const { atoms, preferences, selection } = yield* withSelection([root])

      yield* atoms.set(selection.selection, { project: '/repo', key: 'older' })
      assert.strictEqual((yield* atoms.get(selection.selection))?.key, 'older')

      yield* atoms.set(preferences.followActive, true)

      // This is what the toggle is *for*: a live agent that appears in the
      // session being watched takes over. Under `explicit ?? auto` it would have
      // done nothing at all once the user had clicked anything.
      assert.strictEqual((yield* atoms.get(selection.selection))?.key, 'newer')

      yield* atoms.set(preferences.followActive, false)
      assert.strictEqual((yield* atoms.get(selection.selection))?.key, 'older')
    }))

  it.effect('closes the inspector when another agent is selected', () =>
    Effect.gen(function*() {
      const { atoms, selection } = yield* withSelection([sessionWithLiveChild('worker', 1)])

      yield* atoms.set(selection.inspected, 'worker')
      yield* atoms.set(selection.selection, { project: '/repo', key: 'session' })

      // The overlay was showing something from the agent being left. The page
      // used to couple these by hand, in `select()`.
      assert.isNull(yield* atoms.get(selection.inspected))
    }))

  it.effect('forgets a node the tree no longer contains, but keeps the choice', () =>
    Effect.gen(function*() {
      const { atoms, selection } = yield* withSelection([sessionWithLiveChild('worker', 1)])

      yield* atoms.set(selection.selection, { project: '/repo', key: 'vanished' })

      assert.strictEqual((yield* atoms.get(selection.selection))?.key, 'vanished')
      assert.isNull(yield* atoms.get(selection.node))
      assert.isNull(yield* atoms.get(selection.root))
    }))
})
