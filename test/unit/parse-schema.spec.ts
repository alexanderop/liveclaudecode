import { assert, describe, it } from '@effect/vitest'
import { Result, Schema } from 'effect'
import { NonNegativeInt, parseOrNull } from '../../shared/schemas/parse'

const decodeNonNegativeInt = Schema.decodeUnknownResult(NonNegativeInt)

describe('NonNegativeInt', () => {
  it('accepts zero and positive integers', () => {
    assert.deepStrictEqual(Result.getOrNull(decodeNonNegativeInt(0)), 0)
    assert.deepStrictEqual(Result.getOrNull(decodeNonNegativeInt(42)), 42)
  })

  it('rejects negatives, fractions, and non-numbers', () => {
    assert.isTrue(Result.isFailure(decodeNonNegativeInt(-1)))
    assert.isTrue(Result.isFailure(decodeNonNegativeInt(1.5)))
    assert.isTrue(Result.isFailure(decodeNonNegativeInt('3')))
    assert.isTrue(Result.isFailure(decodeNonNegativeInt(Number.NaN)))
  })
})

describe('parseOrNull', () => {
  const parse = parseOrNull(Schema.Struct({ name: Schema.String }))

  it('returns the decoded value on success', () => {
    assert.deepStrictEqual(parse({ name: 'ok' }), { name: 'ok' })
  })

  it('collapses any decode failure to null', () => {
    assert.isNull(parse({ name: 7 }))
    assert.isNull(parse('nope'))
    assert.isNull(parse(null))
  })

  it('honours decode options such as preserving excess properties', () => {
    const preserving = parseOrNull(
      Schema.Struct({ name: Schema.String }),
      { onExcessProperty: 'preserve' },
    )
    const input: unknown = { name: 'ok', extra: 1 }
    assert.deepStrictEqual<unknown>(preserving(input), { name: 'ok', extra: 1 })
  })
})
