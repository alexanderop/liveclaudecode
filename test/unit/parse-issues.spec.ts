import { assert, describe, it } from '@effect/vitest'
import { Effect, Result, Schema } from 'effect'
import {
  addParseIssueCounts,
  invalidJsonIssue,
  ParseIssueLog,
  PARSE_ISSUE_SAMPLE_LIMIT,
  recordTypeOf,
  schemaMismatchIssue,
  totalParseIssues,
  unsupportedShapeIssue,
} from '../../server/utils/parse-issues'
import { NonNegativeInt } from '#shared/schemas/parse'

/**
 * A census built from the same `NonNegativeInt` the transcript schemas use for
 * count-shaped fields, so the generated cases match what a real scan can hold.
 */
const CensusSchema = Schema.Struct({
  invalidJson: NonNegativeInt,
  schemaMismatch: NonNegativeInt,
  unsupportedShape: NonNegativeInt,
})

const Record_ = Schema.Struct({
  type: Schema.Literal('assistant'),
  message: Schema.Struct({ content: Schema.String }),
})
const decode = Schema.decodeUnknownResult(Record_)

function schemaError(value: unknown): Schema.SchemaError {
  const result = decode(value)
  assert.strictEqual(Result.isSuccess(result), false)
  if (Result.isSuccess(result)) throw new Error('expected a decode failure')
  return result.failure
}

function jsonError(raw: string): unknown {
  try {
    JSON.parse(raw)
    throw new Error('expected invalid JSON')
  } catch (error) {
    return error
  }
}

describe('parse issue helpers', () => {
  it('names the failing field so a skipped record can be located', () => {
    const issue = schemaMismatchIssue(
      41,
      { type: 'assistant', message: { id: 'x' } },
      schemaError({ type: 'assistant', message: { id: 'x' } }),
    )

    assert.strictEqual(issue.reason, 'schema-mismatch')
    assert.strictEqual(issue.line, 41)
    assert.strictEqual(issue.recordType, 'assistant')
    // The path is the whole point: "Missing key" alone is not actionable.
    assert.ok(issue.detail.includes('message'))
    assert.ok(issue.detail.includes('content'))
    assert.ok(issue.excerpt.includes('assistant'))
  })

  it('reports the parse failure for an unreadable line', () => {
    const issue = invalidJsonIssue(3, '{"type":"assistant"', jsonError('{"type":"assistant"'))

    assert.strictEqual(issue.reason, 'invalid-json')
    assert.strictEqual(issue.recordType, '')
    assert.ok(issue.detail.length > 0)
    assert.strictEqual(issue.excerpt, '{"type":"assistant"')
  })

  it('collapses multi-line detail and bounds the excerpt', () => {
    const issue = unsupportedShapeIssue(0, { kind: 'x'.repeat(400) }, 'line one\n  line two')

    assert.strictEqual(issue.detail, 'line one line two')
    assert.ok(issue.excerpt.length <= 240)
    assert.ok(issue.excerpt.endsWith('…'))
  })

  it('reads the discriminator from either `type` or `kind`', () => {
    assert.strictEqual(recordTypeOf({ type: 'assistant' }), 'assistant')
    assert.strictEqual(recordTypeOf({ kind: 'session.start' }), 'session.start')
    assert.strictEqual(recordTypeOf({ kind: 7 }), '')
    assert.strictEqual(recordTypeOf('not-an-object'), '')
    assert.strictEqual(recordTypeOf(null), '')
  })
})

describe('ParseIssueLog', () => {
  it('counts every issue but retains only a bounded sample', () => {
    const log = new ParseIssueLog()
    for (let line = 0; line < PARSE_ISSUE_SAMPLE_LIMIT + 5; line += 1) {
      log.recordInvalidJson(line, '{', jsonError('{'))
    }

    assert.strictEqual(log.skipped, PARSE_ISSUE_SAMPLE_LIMIT + 5)
    assert.strictEqual(log.counts.invalidJson, PARSE_ISSUE_SAMPLE_LIMIT + 5)
    assert.strictEqual(log.samples.length, PARSE_ISSUE_SAMPLE_LIMIT)
    // The retained sample is the first ones seen, not the last.
    assert.strictEqual(log.samples[0]?.line, 0)
  })

  it('splits the tally by cause', () => {
    const log = new ParseIssueLog()
    log.recordInvalidJson(0, '{', jsonError('{'))
    log.recordSchemaMismatch(1, { type: 'assistant' }, schemaError({ type: 'assistant' }))
    log.recordUnsupportedShape(2, { type: 'assistant' }, 'cannot replay')

    assert.deepStrictEqual(log.counts, { invalidJson: 1, schemaMismatch: 1, unsupportedShape: 1 })
    assert.strictEqual(totalParseIssues(log.counts), 3)
    assert.deepStrictEqual(log.summary, { skipped: 3, counts: log.counts })
  })

  it('replaces derived issues instead of accumulating them across rebuilds', () => {
    const log = new ParseIssueLog()
    const derived = [unsupportedShapeIssue(4, { type: 'part' }, 'bad part')]

    // A scanner that re-derives its state on every poll would otherwise
    // multiply one bad record by the number of refreshes.
    log.replaceDerived(derived)
    log.replaceDerived(derived)
    log.replaceDerived(derived)

    assert.strictEqual(log.skipped, 1)
    assert.strictEqual(log.samples.length, 1)
  })

  it('keeps derived and recorded issues in one tally', () => {
    const log = new ParseIssueLog()
    log.recordInvalidJson(0, '{', jsonError('{'))
    log.replaceDerived([unsupportedShapeIssue(9, { type: 'part' }, 'bad part')])

    assert.strictEqual(log.skipped, 2)
    assert.deepStrictEqual(log.samples.map(issue => issue.line), [0, 9])
  })

  it('drops everything when a rewritten file is re-read', () => {
    const log = new ParseIssueLog()
    log.recordInvalidJson(0, '{', jsonError('{'))
    log.replaceDerived([unsupportedShapeIssue(9, { type: 'part' }, 'bad part')])
    log.reset()

    assert.strictEqual(log.skipped, 0)
    assert.deepStrictEqual(log.counts, { invalidJson: 0, schemaMismatch: 0, unsupportedShape: 0 })
    assert.strictEqual(log.samples.length, 0)
  })
})

describe('parse census arithmetic', () => {
  it.effect.prop(
    'merging two censuses totals to the sum of their totals',
    { left: CensusSchema, right: CensusSchema },
    ({ left, right }) =>
      Effect.sync(() => {
        const expected = totalParseIssues(left) + totalParseIssues(right)
        const merged = { ...left }
        addParseIssueCounts(merged, right)
        assert.strictEqual(totalParseIssues(merged), expected)
      }),
  )

  it.effect.prop(
    'merging is commutative in the total it reports',
    { left: CensusSchema, right: CensusSchema },
    ({ left, right }) =>
      Effect.sync(() => {
        const leftFirst = { ...left }
        addParseIssueCounts(leftFirst, right)
        const rightFirst = { ...right }
        addParseIssueCounts(rightFirst, left)
        assert.deepStrictEqual(leftFirst, rightFirst)
      }),
  )
})
