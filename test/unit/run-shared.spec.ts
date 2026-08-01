import { assert, describe, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import type * as FileSystem from 'effect/FileSystem'
import {
  detectFileChange,
  freshFilesIn,
  isFreshFile,
} from '../../server/utils/filesystem-concurrency'
import { testFileSystem } from '../fixtures/filesystem'
import {
  addCausal,
  addUsage,
  countUnreadable,
  emptyCausal,
  emptyEnvironment,
  emptyRunDiagnostics,
  emptyUsage,
  finishRunDiagnostics,
  freshnessCutoff,
  isFreshFileInfo,
  isFreshMtime,
  mergeScanDiagnostics,
  selectLatestById,
  visitNodes,
} from '../../server/utils/run-shared'
import type { DiagnosticIncident, RunNode, ScanDiagnostics } from '../../shared/types/run'

function node(key: string, children: RunNode[] = []): RunNode {
  return {
    records: 0,
    tools: 0,
    toolCounts: {},
    reads: 0,
    errors: 0,
    tokensOut: 0,
    firstTs: null,
    lastTs: null,
    mtime: 0,
    ago: 0,
    live: false,
    size: 0,
    todos: null,
    skills: [],
    milestones: [],
    current: null,
    files: [],
    commands: [],
    finalText: '',
    source: 'claude',
    sourceDetail: '',
    key,
    kind: 'session',
    sid: key,
    label: key,
    agentType: '',
    toolUseId: null,
    model: '',
    spawnDepth: null,
    parentAgentId: null,
    stoppedByUser: false,
    spawnState: '',
    children,
    subAgents: 0,
    subRunning: 0,
    subErrors: 0,
    subTools: 0,
    subFiles: {},
    subLast: null,
    subLive: false,
  }
}

function incident(id: string, ts: string | null): DiagnosticIncident {
  return { id, severity: 'error', category: 'tool', title: id, detail: '', ts, line: 0 }
}

function scanDiagnostics(over: Partial<ScanDiagnostics> = {}): ScanDiagnostics {
  return {
    incidents: [],
    turns: [],
    context: [],
    compactions: [],
    outcomes: [],
    changes: [],
    git: [],
    environment: emptyEnvironment(),
    causal: emptyCausal(),
    ...over,
  }
}

describe('visitNodes', () => {
  it('visits every node preorder with its depth', () => {
    const root = node('root', [node('a', [node('a1')]), node('b')])
    const seen: Array<[string, number]> = []
    visitNodes(root, (visited, depth) => seen.push([visited.key, depth]))
    assert.deepStrictEqual(seen, [['root', 0], ['a', 1], ['a1', 2], ['b', 1]])
  })
})

describe('selectLatestById', () => {
  it('keeps the newest item per id and counts later duplicates', () => {
    const items = [
      { id: 'a', mtime: 1, tag: 'old' },
      { id: 'a', mtime: 5, tag: 'new' },
      { id: 'b', mtime: 2, tag: 'only' },
      { id: 'a', mtime: 3, tag: 'middle' },
    ]
    const { selected, duplicates } = selectLatestById(items, item => item.id, item => item.mtime)
    assert.strictEqual(duplicates, 2)
    assert.strictEqual(selected.get('a')?.tag, 'new')
    assert.strictEqual(selected.get('b')?.tag, 'only')
  })

  it('skips items with an empty id entirely', () => {
    const { selected, duplicates } = selectLatestById(
      [{ id: '', mtime: 1 }, { id: '', mtime: 2 }],
      item => item.id,
      item => item.mtime,
    )
    assert.strictEqual(selected.size, 0)
    assert.strictEqual(duplicates, 0)
  })
})

describe('freshness', () => {
  it('computes the cutoff from the window, with zero meaning unbounded', () => {
    assert.strictEqual(freshnessCutoff(2, 10_000_000), 10_000_000 - 2 * 3_600_000)
    assert.strictEqual(freshnessCutoff(0, 10_000_000), Number.NEGATIVE_INFINITY)
    assert.strictEqual(freshnessCutoff(-1, 10_000_000), Number.NEGATIVE_INFINITY)
  })

  it('treats a missing mtime as fresh and compares present ones to the cutoff', () => {
    assert.isTrue(isFreshMtime(Option.none(), 1_000))
    assert.isTrue(isFreshMtime(Option.some(new Date(1_000)), 1_000))
    assert.isFalse(isFreshMtime(Option.some(new Date(999)), 1_000))
  })

  it('requires a regular file for file-info freshness', () => {
    const fileInfo = { type: 'File', mtime: Option.some(new Date(2_000)) } as FileSystem.File.Info
    const directoryInfo = { type: 'Directory', mtime: Option.some(new Date(2_000)) } as FileSystem.File.Info
    assert.isTrue(isFreshFileInfo(fileInfo, 1_000))
    assert.isFalse(isFreshFileInfo(directoryInfo, 1_000))
    assert.isFalse(isFreshFileInfo({ type: 'File', mtime: Option.some(new Date(1)) } as FileSystem.File.Info, 1_000))
  })
})

describe('aggregate helpers', () => {
  it('produces independent zeroed instances', () => {
    const first = emptyUsage()
    const second = emptyUsage()
    first.in = 5
    assert.deepStrictEqual(second, { in: 0, out: 0, cr: 0, cw: 0 })
    assert.deepStrictEqual(emptyCausal(), {
      records: 0,
      recordsWithUuid: 0,
      branchPoints: 0,
      sidechainRecords: 0,
      interruptions: 0,
    })
    assert.deepStrictEqual(emptyEnvironment(), {
      cwd: '',
      gitBranch: '',
      version: '',
      entrypoint: '',
      permissionMode: '',
    })
  })

  it('adds usage and causal counters field by field', () => {
    const usage = { in: 1, out: 2, cr: 3, cw: 4 }
    addUsage(usage, { in: 10, out: 20, cr: 30, cw: 40 })
    assert.deepStrictEqual(usage, { in: 11, out: 22, cr: 33, cw: 44 })

    const causal = emptyCausal()
    addCausal(causal, { records: 5, recordsWithUuid: 4, branchPoints: 3, sidechainRecords: 2, interruptions: 1 })
    addCausal(causal, { records: 1, recordsWithUuid: 1, branchPoints: 1, sidechainRecords: 1, interruptions: 1 })
    assert.deepStrictEqual(causal, {
      records: 6,
      recordsWithUuid: 5,
      branchPoints: 4,
      sidechainRecords: 3,
      interruptions: 2,
    })
  })
})

describe('countUnreadable', () => {
  it.effect('logs each failure and returns the count', () =>
    Effect.gen(function*() {
      assert.strictEqual(yield* countUnreadable('spec', [new Error('a'), new Error('b')]), 2)
      assert.strictEqual(yield* countUnreadable('spec', []), 0)
    }))
})

describe('filesystem discovery helpers', () => {
  it.effect('detectFileChange distinguishes missing, unchanged, and changed files', () =>
    Effect.gen(function*() {
      const layer = testFileSystem({ '/p/a.jsonl': { content: 'one\n', mtime: 100 } })
      const previous = { mtime: 0, lastLoadedMtime: 0, lastLoadedSize: -1 }

      const missing = yield* detectFileChange('/p/absent.jsonl', previous).pipe(Effect.provide(layer))
      assert.strictEqual(missing._tag, 'Missing')

      const changed = yield* detectFileChange('/p/a.jsonl', previous).pipe(Effect.provide(layer))
      assert.deepStrictEqual(changed, { _tag: 'Changed', mtime: 100, size: 4 })

      const unchanged = yield* detectFileChange('/p/a.jsonl', {
        mtime: 100,
        lastLoadedMtime: 100,
        lastLoadedSize: 4,
      }).pipe(Effect.provide(layer))
      assert.deepStrictEqual(unchanged, { _tag: 'Unchanged', mtime: 100, size: 4 })
    }))

  it.effect('isFreshFile requires a regular file inside the freshness window', () =>
    Effect.gen(function*() {
      const layer = testFileSystem({
        '/p/fresh.jsonl': { content: 'x', mtime: 100 },
        '/p/stale.jsonl': { content: 'x', mtime: 1 },
        '/p/dir/inner.jsonl': 'x',
      })
      assert.isTrue(yield* isFreshFile('/p/fresh.jsonl', 50_000).pipe(Effect.provide(layer)))
      assert.isFalse(yield* isFreshFile('/p/stale.jsonl', 50_000).pipe(Effect.provide(layer)))
      assert.isFalse(yield* isFreshFile('/p/dir', 50_000).pipe(Effect.provide(layer)))
    }))

  it.effect('freshFilesIn lists fresh matches and counts per-file stat failures', () =>
    Effect.gen(function*() {
      const layer = testFileSystem({
        '/p/fresh.jsonl': { content: 'x', mtime: 100 },
        '/p/stale.jsonl': { content: 'x', mtime: 1 },
        '/p/denied.jsonl': { content: 'x', mtime: 100 },
        '/p/skipped.txt': { content: 'x', mtime: 100 },
      }, { denied: ['/p/denied.jsonl'] })
      const listed = yield* freshFilesIn('/p', name => name.endsWith('.jsonl'), 50_000)
        .pipe(Effect.provide(layer))
      assert.deepStrictEqual(listed.paths, ['/p/fresh.jsonl'])
      assert.strictEqual(listed.unreadable, 1)
    }))
})

describe('run diagnostics aggregation', () => {
  it('attributes merged entries to their node and accumulates usage and causal totals', () => {
    const aggregate = emptyRunDiagnostics()
    mergeScanDiagnostics(aggregate, scanDiagnostics({
      incidents: [incident('i1', '2026-01-01T00:00:02Z')],
      turns: [{ ts: '2026-01-01T00:00:01Z', durationMs: 5, messageCount: 2, pendingAgents: 0, pendingWorkflows: 0 }],
      context: [
        { ts: null, model: 'm', effort: '', usage: { in: 1, out: 2, cr: 3, cw: 4 }, stopReason: null },
        { ts: null, model: 'm', effort: '', usage: { in: 1, out: 1, cr: 1, cw: 1 }, stopReason: null },
      ],
      causal: { records: 7, recordsWithUuid: 6, branchPoints: 1, sidechainRecords: 0, interruptions: 2 },
    }), 'Main session', 'sess-1')

    assert.deepStrictEqual(aggregate.usage, { in: 2, out: 3, cr: 4, cw: 5 })
    assert.strictEqual(aggregate.causal.records, 7)
    assert.deepStrictEqual(
      aggregate.incidents.map(entry => [entry.id, entry.who, entry.key]),
      [['i1', 'Main session', 'sess-1']],
    )
    assert.deepStrictEqual(
      aggregate.turns.map(entry => [entry.who, entry.key]),
      [['Main session', 'sess-1']],
    )
  })

  it('sorts by timestamp and keeps only the bounded tail', () => {
    const aggregate = emptyRunDiagnostics()
    // Push out of order so the sort is observable, and more than the limit.
    for (let index = 219; index >= 0; index -= 1) {
      aggregate.incidents.push(incident(`i${index}`, `2026-01-01T00:${String(index % 60).padStart(2, '0')}:${String(Math.floor(index / 60)).padStart(2, '0')}Z`))
    }
    const finished = finishRunDiagnostics(aggregate)
    assert.strictEqual(finished.incidents.length, 200)
    const timestamps = finished.incidents.map(entry => entry.ts ?? '')
    assert.deepStrictEqual(timestamps, [...timestamps].sort())
  })

  it('keeps the latest entries when trimming to the tail', () => {
    const aggregate = emptyRunDiagnostics()
    for (let index = 0; index < 205; index += 1) {
      aggregate.incidents.push(incident(`i${index}`, `2026-01-01T00:00:00.${String(index).padStart(3, '0')}Z`))
    }
    const finished = finishRunDiagnostics(aggregate)
    assert.strictEqual(finished.incidents.length, 200)
    assert.strictEqual(finished.incidents[0]?.id, 'i5')
    assert.strictEqual(finished.incidents.at(-1)?.id, 'i204')
  })
})
