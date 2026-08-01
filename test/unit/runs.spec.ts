import { resolve, sep } from 'node:path'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer, Stream } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as PlatformError from 'effect/PlatformError'
import { FastCheck } from 'effect/testing'
import {
  buildTree,
  firstPrompt,
  flatten,
  pathFor,
  rollup,
  rootOf,
  runPhases,
} from '#server/utils/runs'
import { PromptCache, ScanCache } from '#server/utils/services'
import type { RunNode } from '#shared/types/run'
import * as fixture from '../fixtures/transcripts'
import { testFileSystem, type FakeTree } from '../fixtures/filesystem'

const SESSION = 'sess-1'
const ROOT = '/p'

const tree: FakeTree = {
  [`${ROOT}/${SESSION}.jsonl`]: fixture.transcript([
    fixture.userText('/ship @plan.md'),
    fixture.assistant([
      fixture.text('**Wave 1 — two slices**'),
      fixture.tool('Agent', 'spawn-a', { description: 'slice A' }),
      fixture.tool('Agent', 'spawn-b', { description: 'slice B' }),
    ], { ts: fixture.T0(1) }),
    fixture.userResult('spawn-a', 'done', { ts: fixture.T0(30) }),
  ]),
  [`${ROOT}/${SESSION}/subagents/agent-a.jsonl`]: fixture.transcript([
    fixture.assistant([fixture.tool('Edit', 'e1', { file_path: '/repo/src/a.ts' })], { ts: fixture.T0(2) }),
    fixture.userResult('e1', 'ok', { ts: fixture.T0(3) }),
  ]),
  [`${ROOT}/${SESSION}/subagents/agent-a.meta.json`]: JSON.stringify({
    agentType: 'implementation-worker', description: 'slice A', toolUseId: 'spawn-a',
  }),
  [`${ROOT}/${SESSION}/subagents/agent-b.jsonl`]: fixture.transcript([
    fixture.assistant([
      fixture.text('**Wave 2 — follow up**'),
      fixture.tool('Bash', 'b1', { command: 'pnpm test' }),
    ], { ts: fixture.T0(4) }),
  ]),
  [`${ROOT}/${SESSION}/subagents/agent-b.meta.json`]: JSON.stringify({
    agentType: 'implementation-worker', description: 'slice B', toolUseId: 'spawn-b',
  }),
}

/**
 * A fresh cache per test. This replaces the old `resetScanCache()` /
 * `resetRunCaches()` calls — state cannot leak because each test builds its
 * own service instances.
 */
const TestLayer = Layer.mergeAll(ScanCache.layer, PromptCache.layer)
  .pipe(Layer.provideMerge(testFileSystem(tree)))

const withTree = <A>(use: (built: {
  roots: RunNode[]
  byKey: Map<string, RunNode>
  cwd: string
}) => A) =>
  buildTree(ROOT, 99_999).pipe(Effect.map(use), Effect.provide(TestLayer))

describe('run hierarchy', () => {
  it.effect('hangs subagents off the transcript that spawned them', () =>
    withTree(({ roots }) => {
      assert.strictEqual(roots.length, 1)
      assert.strictEqual(roots[0]?.key, SESSION)
      assert.deepStrictEqual(roots[0]?.children.map(child => child.label).sort(), ['slice A', 'slice B'])
    }))

  it.effect('labels a session from the first user prompt', () =>
    withTree(({ roots }) => {
      assert.strictEqual(roots[0]?.label, '/ship @plan.md')
    }))

  it.effect('falls back to the session id when no prompt fits the label scan window', () =>
    Effect.gen(function*() {
      const giant = `{"pad":"${'x'.repeat(300_000)}"}\n`
        + fixture.transcript([fixture.userText('real prompt')])
      const built = yield* buildTree('/q', 99_999).pipe(Effect.provide(
        Layer.mergeAll(ScanCache.layer, PromptCache.layer)
          .pipe(Layer.provideMerge(testFileSystem({ '/q/big-session.jsonl': giant }))),
      ))
      assert.strictEqual(built.roots[0]?.label, 'big-sess')
    }))

  it.effect('distinguishes returned and running agents', () =>
    withTree(({ roots }) => {
      const children = roots[0]!.children
      const states = Object.fromEntries(children.map(child => [child.label, child.spawnState]))
      assert.deepStrictEqual(states, { 'slice A': 'returned', 'slice B': 'running' })
      assert.isFalse(children.find(child => child.label === 'slice A')!.live)
      assert.isTrue(children.find(child => child.label === 'slice B')!.live)
    }))

  it.effect('rolls up totals for the whole subtree', () =>
    withTree(({ roots }) => {
      const root = roots[0]!
      assert.strictEqual(root.subAgents, 2)
      assert.strictEqual(root.subRunning, 1)
      assert.strictEqual(root.subTools, 4)
      assert.deepStrictEqual(root.subFiles, { 'src/a.ts': 1 })
    }))

  it.effect('produces depth-ordered timeline lanes', () =>
    withTree(({ roots }) => {
      const lanes = flatten(roots[0]!)
      assert.deepStrictEqual(lanes.map(lane => lane.depth), [0, 1, 1])
      assert.strictEqual(lanes[0]?.key, SESSION)
    }))

  it.effect('finds the top-level run for a worker', () =>
    withTree(({ roots }) => {
      assert.strictEqual(rootOf(roots, `${SESSION}/agent-b`)?.key, SESSION)
    }))

  it.effect('merges phase announcements across every agent', () =>
    withTree(({ roots }) => {
      const phases = runPhases(roots[0]!)
      assert.deepStrictEqual(phases.map(phase => phase.title), ['Wave 1 — two slices', 'Wave 2 — follow up'])
      assert.deepStrictEqual(
        Object.fromEntries(phases.map(phase => [phase.title, phase.who])),
        { 'Wave 1 — two slices': 'main', 'Wave 2 — follow up': 'slice B' },
      )
    }))

  it.effect('uses zero hours to include all history', () =>
    buildTree(ROOT, 0).pipe(
      Effect.map(built => assert.deepStrictEqual(built.roots.map(root => root.key), [SESSION])),
      Effect.provide(TestLayer),
    ))

  it.effect('treats a not-yet-created transcript directory as an empty tree', () =>
    buildTree('/new-project', 99_999).pipe(
      Effect.map(built => assert.deepStrictEqual(built.roots, [])),
      Effect.provide(TestLayer),
    ))

  it.effect('treats missing subagent metadata and directories as optional', () =>
    buildTree('/optional', 99_999).pipe(
      Effect.map((built) => {
        assert.strictEqual(built.roots.length, 1)
        assert.strictEqual(built.roots[0]?.children[0]?.label, 'worker')
      }),
      Effect.provide(
        Layer.mergeAll(ScanCache.layer, PromptCache.layer).pipe(
          Layer.provideMerge(testFileSystem({
            '/optional/session.jsonl': fixture.transcript([fixture.userText('Session')]),
            '/optional/session/subagents/worker.jsonl': fixture.transcript([
              fixture.assistant([fixture.text('Done')]),
            ]),
            '/optional/empty/placeholder.txt': '',
          })),
        ),
      ),
    ))

  it.effect('ignores project metadata files when discovering session directories', () =>
    buildTree('/indexed', 99_999).pipe(
      Effect.map((built) => {
        assert.deepStrictEqual(built.roots.map(root => root.key), ['session'])
        assert.strictEqual(built.unreadable, 0)
      }),
      Effect.provide(
        Layer.mergeAll(ScanCache.layer, PromptCache.layer).pipe(
          Layer.provideMerge(testFileSystem({
            '/indexed/session.jsonl': fixture.transcript([fixture.userText('Session')]),
            '/indexed/sessions-index.json': JSON.stringify({ version: 1 }),
          })),
        ),
      ),
    ))

  it.effect('degrades around permission failures while reading session prompts', () => {
    const path = '/denied/session.jsonl'
    return Effect.gen(function*() {
      const built = yield* buildTree('/denied', 99_999)
      assert.strictEqual(built.roots.length, 0)
      assert.strictEqual(built.unreadable, 1)
    }).pipe(Effect.provide(
      Layer.mergeAll(ScanCache.layer, PromptCache.layer).pipe(
        Layer.provideMerge(testFileSystem({
          [path]: fixture.transcript([fixture.userText('Secret')]),
        }, { denied: [path] })),
      ),
    ))
  })

  it.effect('degrades around permission failures while reading subagent metadata', () => {
    const meta = '/denied-meta/session/subagents/worker.meta.json'
    return Effect.gen(function*() {
      const built = yield* buildTree('/denied-meta', 99_999)
      assert.strictEqual(built.roots[0]?.key, 'session')
      assert.strictEqual(built.roots[0]?.children.length, 0)
      assert.strictEqual(built.unreadable, 1)
    }).pipe(Effect.provide(
      Layer.mergeAll(ScanCache.layer, PromptCache.layer).pipe(
        Layer.provideMerge(testFileSystem({
          '/denied-meta/session.jsonl': fixture.transcript([fixture.userText('Session')]),
          '/denied-meta/session/subagents/worker.jsonl': fixture.transcript([
            fixture.assistant([fixture.text('Done')]),
          ]),
          [meta]: JSON.stringify({ description: 'worker' }),
        }, { denied: [meta] })),
      ),
    ))
  })

  it.effect('degrades around permission failures while listing subagents', () => {
    const directory = '/denied-directory/session/subagents'
    return Effect.gen(function*() {
      const built = yield* buildTree('/denied-directory', 99_999)
      assert.strictEqual(built.roots[0]?.key, 'session')
      assert.strictEqual(built.roots[0]?.children.length, 0)
      assert.strictEqual(built.unreadable, 1)
    }).pipe(Effect.provide(
      Layer.mergeAll(ScanCache.layer, PromptCache.layer).pipe(
        Layer.provideMerge(testFileSystem({
          '/denied-directory/session.jsonl': fixture.transcript([fixture.userText('Session')]),
          [`${directory}/worker.jsonl`]: fixture.transcript([
            fixture.assistant([fixture.text('Done')]),
          ]),
        }, { denied: [directory] })),
      ),
    ))
  })

  it.effect('does not cache a transient missing-prompt fallback', () =>
    {
      let attempts = 0
      const missing = PlatformError.systemError({
        _tag: 'NotFound',
        module: 'FileSystem',
        method: 'stream',
        pathOrDescriptor: '/retry/session.jsonl',
      })
      const content = new TextEncoder().encode(fixture.transcript([
        fixture.userText('Recovered prompt'),
      ]))
      const fileSystem = FileSystem.layerNoop({
        stream: () => {
          attempts += 1
          return attempts === 1 ? Stream.fail(missing) : Stream.make(content)
        },
      })
      return Effect.gen(function*() {
        assert.strictEqual(yield* firstPrompt('/retry/session.jsonl'), '')
        assert.strictEqual(yield* firstPrompt('/retry/session.jsonl'), 'Recovered prompt')
        assert.strictEqual(attempts, 2)
      }).pipe(Effect.provide(PromptCache.layer.pipe(Layer.provideMerge(fileSystem))))
    },
  )

  it.effect('caches scans within a layer but not across them', () =>
    Effect.gen(function*() {
      const first = yield* buildTree(ROOT, 99_999)
      const second = yield* buildTree(ROOT, 99_999)
      // Same cache instance: the second build sees the already-parsed scans and
      // must not double-count anything.
      assert.strictEqual(first.roots[0]?.subTools, second.roots[0]?.subTools)
    }).pipe(Effect.provide(TestLayer)))
})

describe('background agents', () => {
  const ASYNC_SESSION = 'sess-bg'
  const launch = fixture.userResult('spawn-bg', 'Async agent launched successfully.', {
    ts: fixture.T0(2),
    toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'agent-bg' },
  })
  const notification = fixture.userText(
    '<task-notification>\n<task-id>agent-bg</task-id>\n<tool-use-id>spawn-bg</tool-use-id>\n'
    + '<status>completed</status>\n</task-notification>',
    { ts: fixture.T0(40), meta: true },
  )
  const asyncTree = (settled: boolean): FakeTree => ({
    [`/bg/${ASYNC_SESSION}.jsonl`]: fixture.transcript([
      fixture.userText('/audit'),
      fixture.assistant([fixture.tool('Agent', 'spawn-bg', { description: 'bg worker' })], { ts: fixture.T0(1) }),
      ...(settled ? [launch, notification] : [launch]),
    ]),
    [`/bg/${ASYNC_SESSION}/subagents/agent-bg.jsonl`]: fixture.transcript([
      fixture.assistant([fixture.tool('Bash', 'b1', { command: 'pnpm test' })], { ts: fixture.T0(3) }),
    ]),
    [`/bg/${ASYNC_SESSION}/subagents/agent-bg.meta.json`]: JSON.stringify({
      agentType: 'Explore', description: 'bg worker', toolUseId: 'spawn-bg',
    }),
  })

  const buildAsync = (settled: boolean) =>
    buildTree('/bg', 99_999).pipe(Effect.provide(
      Layer.mergeAll(ScanCache.layer, PromptCache.layer)
        .pipe(Layer.provideMerge(testFileSystem(asyncTree(settled)))),
    ))

  it.effect('keeps an async-launched agent running despite the instant tool result', () =>
    Effect.gen(function*() {
      const built = yield* buildAsync(false)
      const worker = built.roots[0]!.children[0]!
      assert.strictEqual(worker.spawnState, 'running')
      assert.isTrue(worker.live)
      assert.strictEqual(built.roots[0]!.subRunning, 1)
    }))

  it.effect('settles an async agent once its task-notification arrives', () =>
    Effect.gen(function*() {
      const built = yield* buildAsync(true)
      const worker = built.roots[0]!.children[0]!
      assert.strictEqual(worker.spawnState, 'returned')
      assert.isFalse(worker.live)
      assert.strictEqual(built.roots[0]!.subRunning, 0)
    }))
})

describe('pathFor', () => {
  it.effect('maps session and subagent keys to transcript paths', () =>
    Effect.gen(function*() {
      assert.strictEqual(yield* pathFor('/p', 'abc'), '/p/abc.jsonl')
      assert.strictEqual(yield* pathFor('/p', 'abc/agent-1'), '/p/abc/subagents/agent-1.jsonl')
    }))

  it.effect('rejects traversal-shaped run keys', () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(pathFor('/p', '../passwd'))
      assert.strictEqual(error._tag, 'InvalidRunKey')
    }))

  /**
   * A run key arrives directly from a query parameter, so this is a security
   * boundary. Rejecting is always acceptable; escaping the project directory
   * never is.
   */
  it.prop('never resolves outside the project directory', [FastCheck.string()], ([key]) => {
    const result = Effect.runSyncExit(pathFor('/p', key))
    if (result._tag !== 'Success') return
    assert.isTrue(resolve(result.value).startsWith(`${resolve('/p')}${sep}`))
  })

  it.prop(
    'accepts well-formed keys and keeps them contained',
    [FastCheck.stringMatching(/^[a-zA-Z0-9_-]{1,20}$/), FastCheck.stringMatching(/^[a-zA-Z0-9_-]{1,20}$/)],
    ([session, agent]) => {
      const path = Effect.runSync(pathFor('/p', `${session}/${agent}`))
      assert.isTrue(resolve(path).startsWith(`${resolve('/p')}${sep}`))
      assert.isTrue(path.endsWith(`${agent}.jsonl`))
    },
  )
})

/**
 * `rollup` is recursive, mutates in place, and was previously exercised against
 * exactly one tree shape. These properties hold for arbitrary shapes.
 */
describe('rollup', () => {
  const node = (
    tools: number,
    errors: number,
    lastTs: string | null,
    live: boolean,
    children: RunNode[],
  ): RunNode => ({
    source: 'claude',
    sourceDetail: 'Claude Code',
    tools,
    errors,
    lastTs,
    live,
    children,
    files: [],
    key: 'k',
    kind: 'session',
    sid: 's',
    label: '',
    agentType: '',
    toolUseId: null,
    model: '',
    spawnDepth: null,
    parentAgentId: null,
    stoppedByUser: false,
    spawnState: '',
    subAgents: 0,
    subRunning: 0,
    subErrors: 0,
    subTools: 0,
    subFiles: {},
    subLast: null,
    subLive: false,
    records: 0,
    toolCounts: {},
    reads: 0,
    tokensOut: 0,
    firstTs: null,
    mtime: 0,
    ago: 0,
    size: 0,
    todos: null,
    skills: [],
    milestones: [],
    current: null,
    commands: [],
    finalText: '',
  })

  /**
   * Depth is bounded explicitly. An unbounded `letrec` recurses until the
   * generator blows the stack rather than producing a tree.
   */
  const treeOfDepth = FastCheck.memo((depth: number): FastCheck.Arbitrary<RunNode> =>
    FastCheck.tuple(
      FastCheck.nat(5),
      FastCheck.nat(3),
      FastCheck.option(FastCheck.integer({ min: 1, max: 99 }), { nil: null }),
      FastCheck.boolean(),
      depth <= 1
        ? FastCheck.constant([] as RunNode[])
        : FastCheck.array(treeOfDepth(depth - 1), { maxLength: 3 }),
    ).map(([tools, errors, ts, live, children]) =>
      node(tools, errors, ts === null ? null : `2026-07-25T18:00:${String(ts).padStart(2, '0')}Z`, live, children)))

  const arbitraryTree = treeOfDepth(4)

  const descendants = (n: RunNode): RunNode[] => n.children.flatMap(c => [c, ...descendants(c)])

  it.prop('subTools is the sum of tools across the subtree', [arbitraryTree], ([root]) => {
    rollup(root)
    const expected = [root, ...descendants(root)].reduce((total, n) => total + n.tools, 0)
    assert.strictEqual(root.subTools, expected)
  })

  it.prop('subAgents is the descendant count', [arbitraryTree], ([root]) => {
    rollup(root)
    assert.strictEqual(root.subAgents, descendants(root).length)
  })

  it.prop('subLast is the greatest timestamp in the subtree', [arbitraryTree], ([root]) => {
    rollup(root)
    const stamps = [root, ...descendants(root)].map(n => n.lastTs || '').filter(Boolean).sort()
    assert.strictEqual(root.subLast || '', stamps.at(-1) || '')
  })

  it.prop('subLive is true when any node in the subtree is live', [arbitraryTree], ([root]) => {
    rollup(root)
    assert.strictEqual(root.subLive, [root, ...descendants(root)].some(n => n.live))
  })

  /** The function mutates its argument, so running it twice must be a no-op. */
  it.prop('is idempotent despite mutating in place', [arbitraryTree], ([root]) => {
    rollup(root)
    const once = { tools: root.subTools, agents: root.subAgents, errors: root.subErrors, last: root.subLast }
    rollup(root)
    assert.deepStrictEqual(
      { tools: root.subTools, agents: root.subAgents, errors: root.subErrors, last: root.subLast },
      once,
    )
  })
})
