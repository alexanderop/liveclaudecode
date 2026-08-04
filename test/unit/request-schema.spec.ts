import { assert, describe, it } from '@effect/vitest'
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
    assert.strictEqual(parseHours(168, '24'), 24)
    assert.strictEqual(parseHours(168, '0'), 0)
    assert.strictEqual(parseHours(168, '720'), 720)
    assert.strictEqual(parseHours(168, ' 24 '), 24)
    assert.strictEqual(parseHours(168, '1e2'), 100)
  })

  it('falls back to the configured range for unsafe query values', () => {
    assert.strictEqual(parseHours(24, ''), 24)
    assert.strictEqual(parseHours(24, '-1'), 24)
    assert.strictEqual(parseHours(24, 'not-a-number'), 24)
    assert.strictEqual(parseHours(24, ['0']), 24)
  })

  it('uses seven days when both the query and configuration are invalid', () => {
    assert.strictEqual(parseHours('invalid', undefined), 168)
    assert.strictEqual(parseHours('', undefined), 0)
    assert.strictEqual(parseHours(null, undefined), 0)
    // A configured value the coercion cannot handle degrades instead of
    // throwing past `runRequest`'s error mapping.
    assert.strictEqual(parseHours(Symbol('hours'), undefined), 168)
    assert.strictEqual(parseHours({ valueOf() { throw new Error('boom') } }, undefined), 168)
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
