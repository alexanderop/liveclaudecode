import { describe, expect, it } from 'vitest'
import { resolveHours } from '../../server/utils/request-hours'
import {
  parseActivityQuery,
  parseCursorQuery,
  parseSessionQuery,
} from '../../shared/schemas/request'

describe('request context hours', () => {
  it('uses a valid query override, including all time', () => {
    expect(resolveHours(168, '24')).toBe(24)
    expect(resolveHours(168, '0')).toBe(0)
    expect(resolveHours(168, '720')).toBe(720)
    expect(resolveHours(168, ' 24 ')).toBe(24)
    expect(resolveHours(168, '1e2')).toBe(100)
  })

  it('falls back to the configured range for unsafe query values', () => {
    expect(resolveHours(24, '')).toBe(24)
    expect(resolveHours(24, '-1')).toBe(24)
    expect(resolveHours(24, 'not-a-number')).toBe(24)
    expect(resolveHours(24, ['0'])).toBe(24)
  })

  it('uses seven days when both the query and configuration are invalid', () => {
    expect(resolveHours('invalid', undefined)).toBe(168)
    expect(resolveHours('', undefined)).toBe(0)
    expect(resolveHours(null, undefined)).toBe(0)
  })

  it('normalizes session and cursor query fields through schemas', () => {
    expect(parseSessionQuery({ key: 'session', project: '/repo' })).toEqual({
      key: 'session',
      project: '/repo',
    })
    expect(parseCursorQuery({ key: ['invalid'], since: '-1', revision: '12.9' })).toEqual({
      key: '',
      project: '',
      since: 0,
      revision: 12,
    })
    expect(parseCursorQuery({ since: '12items' }).since).toBe(12)
  })

  it('defaults and clamps activity limits in the schema', () => {
    expect(parseActivityQuery({ limit: '50' }).limit).toBe(100)
    expect(parseActivityQuery({ limit: '3000' }).limit).toBe(2_000)
    expect(parseActivityQuery({ limit: ['invalid'] }).limit).toBe(800)
    expect(parseActivityQuery({ limit: '100px' }).limit).toBe(100)
  })
})
