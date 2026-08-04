import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { FastCheck, TestClock } from 'effect/testing'
import {
  compact,
  compactText,
  completeJsonlLines,
  type MutableFileChange,
  parseJsonlValues,
  pushIncident,
  recordFileChange,
  recordMilestones,
  statsNow,
  toolStatsFromCounts,
} from '#server/utils/transcript-scan-core'
import type { DiagnosticIncident, Milestone, TranscriptStats } from '#shared/types/run'

const TS = '2026-07-25T18:00:00.000Z'

describe('JSONL line framing', () => {
  it('keeps only the lines a newline has already terminated', () => {
    // The trailing fragment is a partial write the next read will complete;
    // parsing it now would ingest half a record.
    assert.deepStrictEqual(completeJsonlLines('{"a":1}\n{"b":2}\n{"c":'), ['{"a":1}', '{"b":2}'])
    assert.deepStrictEqual(completeJsonlLines('{"a":1}\n'), ['{"a":1}'])
    assert.deepStrictEqual(completeJsonlLines('{"a":1}'), [])
    assert.deepStrictEqual(completeJsonlLines(''), [])
  })

  it.prop(
    'never returns a line the input did not terminate',
    [FastCheck.string()],
    ([raw]) => {
      const lines = completeJsonlLines(raw)
      // Every returned line is followed by a newline in the original text.
      assert.strictEqual(lines.length, raw.split('\n').length - 1)
      return true
    },
  )
})

describe('parseJsonlValues', () => {
  it('reports each unparseable line with its index, text, and error', () => {
    const { values, malformed } = parseJsonlValues(['{"a":1}', 'not json', '{"b":2}'])

    assert.deepStrictEqual(values, [[0, { a: 1 }], [2, { b: 2 }]])
    assert.strictEqual(malformed.length, 1)
    assert.strictEqual(malformed[0]?.index, 1)
    assert.strictEqual(malformed[0]?.line, 'not json')
    // The error is what `/debug` shows, so it has to survive the round trip.
    assert.instanceOf(malformed[0]?.error, SyntaxError)
  })

  it('skips blank lines without counting them as malformed', () => {
    const { values, malformed } = parseJsonlValues(['', '   ', '\t', '{"a":1}'])

    assert.deepStrictEqual(values, [[3, { a: 1 }]])
    assert.deepStrictEqual(malformed, [])
  })

  it('resumes at fromIndex, keeping indices absolute for incremental reads', () => {
    const lines = ['{"a":1}', 'broken', '{"b":2}']
    const { values, malformed } = parseJsonlValues(lines, 1)

    assert.deepStrictEqual(values, [[2, { b: 2 }]])
    assert.deepStrictEqual(malformed.map(entry => entry.index), [1])
  })

  it('keeps non-object JSON values, which the record schemas then reject', () => {
    const { values, malformed } = parseJsonlValues(['null', '42', '"text"', '[1]'])

    assert.deepStrictEqual(values, [[0, null], [1, 42], [2, 'text'], [3, [1]]])
    assert.deepStrictEqual(malformed, [])
  })

  it('reports every malformed line rather than stopping at the first', () => {
    const { values, malformed } = parseJsonlValues(['{', '{"a":1}', '}', '{"b":'])

    assert.deepStrictEqual(values, [[1, { a: 1 }]])
    assert.deepStrictEqual(malformed.map(entry => entry.index), [0, 2, 3])
  })
})

describe('file change bookkeeping', () => {
  it('counts operations per path and keeps each tool once', () => {
    const files = new Map<string, MutableFileChange>()
    recordFileChange(files, 'app/a.ts', 'Edit', TS)
    recordFileChange(files, 'app/a.ts', 'Edit', '2026-07-25T18:01:00.000Z')
    recordFileChange(files, 'app/a.ts', 'Write', '2026-07-25T18:02:00.000Z')
    recordFileChange(files, 'app/b.ts', 'Edit', TS)

    assert.deepStrictEqual(files.get('app/a.ts'), {
      ops: 3,
      tools: ['Edit', 'Write'],
      lastTs: '2026-07-25T18:02:00.000Z',
    })
    assert.strictEqual(files.get('app/b.ts')?.ops, 1)
  })
})

describe('previews', () => {
  it('collapses whitespace and clips to the limit', () => {
    assert.strictEqual(compact('  lots   of\n\twhitespace  '), 'lots of whitespace')
    assert.strictEqual(compact('abcdef', 3), 'abc')
    assert.strictEqual(compact(''), '')
  })

  it('serializes objects and ignores values with no useful preview', () => {
    assert.strictEqual(compactText({ file_path: '/repo/a.ts' }), '{"file_path":"/repo/a.ts"}')
    assert.strictEqual(compactText(' padded '), 'padded')
    assert.strictEqual(compactText(42), '')
    assert.strictEqual(compactText(null), '')
    assert.strictEqual(compactText(undefined), '')
  })

  it('degrades a value JSON.stringify cannot handle instead of throwing', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    assert.strictEqual(compactText(circular), '')
  })
})

describe('incidents and milestones', () => {
  it('gives each incident an id that stays unique per line and category', () => {
    const incidents: DiagnosticIncident[] = []
    const base: Omit<DiagnosticIncident, 'id'> = {
      line: 12,
      category: 'tool',
      severity: 'error',
      title: 'Edit failed',
      detail: 'boom',
      ts: TS,
    }
    pushIncident(incidents, base)
    pushIncident(incidents, base)
    pushIncident(incidents, { ...base, line: 13 })

    assert.deepStrictEqual(incidents.map(incident => incident.id), [
      '12:tool:0',
      '12:tool:1',
      '13:tool:2',
    ])
  })

  it('appends milestones but not one that repeats the previous title', () => {
    const milestones: Milestone[] = []
    recordMilestones(milestones, '**Wave 1 — setup**', TS)
    recordMilestones(milestones, '**Wave 1 — setup**', '2026-07-25T18:01:00.000Z')
    recordMilestones(milestones, '**Wave 2 — ship**', '2026-07-25T18:02:00.000Z')
    recordMilestones(milestones, 'no milestone in this line', '2026-07-25T18:03:00.000Z')

    assert.deepStrictEqual(milestones.map(milestone => milestone.title), [
      'Wave 1 — setup',
      'Wave 2 — ship',
    ])
    assert.isTrue(milestones.every(milestone => milestone.strong))
  })

  it.prop(
    'never records a title longer than the timeline can show',
    [FastCheck.string({ minLength: 1, maxLength: 400 })],
    ([text]) => {
      const milestones: Milestone[] = []
      recordMilestones(milestones, `**Wave 1 ${text}**`, TS)
      recordMilestones(milestones, `### ${text}`, TS)

      return milestones.every(milestone => milestone.title.length <= 90)
    },
  )
})

describe('tool statistics', () => {
  it('totals every tool and the read-only subset', () => {
    const counts = { Read: 4, Grep: 2, Edit: 3 }
    assert.deepStrictEqual(toolStatsFromCounts(counts, new Set(['Read', 'Grep'])), {
      tools: 9,
      reads: 6,
    })
    assert.deepStrictEqual(toolStatsFromCounts({}, new Set(['Read'])), { tools: 0, reads: 0 })
    assert.deepStrictEqual(toolStatsFromCounts(counts, new Set()), { tools: 9, reads: 0 })
  })
})

describe('statsNow', () => {
  it.effect('snapshots at the current Clock time in seconds, not wall time', () =>
    Effect.gen(function*() {
      const observed: number[] = []
      const scan = {
        statsAt: (now: number) => {
          observed.push(now)
          return { tools: 0 } as unknown as TranscriptStats
        },
      }

      yield* statsNow(scan)
      yield* TestClock.adjust('30 seconds')
      yield* statsNow(scan)

      assert.strictEqual(observed.length, 2)
      assert.strictEqual(observed[1]! - observed[0]!, 30)
    }))
})
