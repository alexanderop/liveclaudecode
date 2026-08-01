import { assert, describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  InvalidRequestQuery,
  parseActivityQuery,
  parseCursorQuery,
  parseHours,
  parseSessionQuery,
} from '../../shared/schemas/request'

describe('request hours schema', () => {
  it('uses a valid query override, including all time', () => {
    expect(parseHours(168, '24')).toBe(24)
    expect(parseHours(168, '0')).toBe(0)
    expect(parseHours(168, '720')).toBe(720)
    expect(parseHours(168, ' 24 ')).toBe(24)
    expect(parseHours(168, '1e2')).toBe(100)
  })

  it('falls back to the configured range for unsafe query values', () => {
    expect(parseHours(24, '')).toBe(24)
    expect(parseHours(24, '-1')).toBe(24)
    expect(parseHours(24, 'not-a-number')).toBe(24)
    expect(parseHours(24, ['0'])).toBe(24)
  })

  it('uses seven days when both the query and configuration are invalid', () => {
    expect(parseHours('invalid', undefined)).toBe(168)
    expect(parseHours('', undefined)).toBe(0)
    expect(parseHours(null, undefined)).toBe(0)
  })
})

describe('request query schemas', () => {
  it.effect('normalizes session and cursor query fields through schemas', () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(yield* parseSessionQuery({ key: 'session', project: '/repo' }), {
        key: 'session',
        project: '/repo',
      })
      assert.deepStrictEqual(yield* parseCursorQuery({ key: ['invalid'], since: '-1', revision: '12.9' }), {
        key: '',
        project: '',
        since: 0,
        revision: 12,
      })
      assert.strictEqual((yield* parseCursorQuery({ since: '12items' })).since, 12)
    }))

  it.effect('defaults and clamps activity limits in the schema', () =>
    Effect.gen(function*() {
      assert.strictEqual((yield* parseActivityQuery({ limit: '50' })).limit, 100)
      assert.strictEqual((yield* parseActivityQuery({ limit: '3000' })).limit, 2_000)
      assert.strictEqual((yield* parseActivityQuery({ limit: ['invalid'] })).limit, 800)
      assert.strictEqual((yield* parseActivityQuery({ limit: '100px' })).limit, 100)
    }))

  it.effect('keeps lenient per-field defaults for an empty query', () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(yield* parseSessionQuery({}), { key: '', project: '' })
      assert.deepStrictEqual(yield* parseCursorQuery({}), { key: '', project: '', since: 0, revision: 0 })
    }))

  it.effect('fails with a typed InvalidRequestQuery when the query is not an object', () =>
    Effect.gen(function*() {
      const sessionError = yield* Effect.flip(parseSessionQuery(null))
      assert.instanceOf(sessionError, InvalidRequestQuery)
      assert.strictEqual(sessionError._tag, 'InvalidRequestQuery')
      assert.isTrue(sessionError.message.startsWith('Invalid request query'))

      const cursorError = yield* Effect.flip(parseCursorQuery('nonsense'))
      assert.strictEqual(cursorError._tag, 'InvalidRequestQuery')
      const activityError = yield* Effect.flip(parseActivityQuery(42))
      assert.strictEqual(activityError._tag, 'InvalidRequestQuery')
    }))
})
