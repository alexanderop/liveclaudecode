import { describe, expect, it } from 'vitest'
import { resolveHours } from '../../server/utils/request-hours'

describe('request context hours', () => {
  it('uses a valid query override, including all time', () => {
    expect(resolveHours(168, '24')).toBe(24)
    expect(resolveHours(168, '0')).toBe(0)
    expect(resolveHours(168, '720')).toBe(720)
  })

  it('falls back to the configured range for unsafe query values', () => {
    expect(resolveHours(24, '')).toBe(24)
    expect(resolveHours(24, '-1')).toBe(24)
    expect(resolveHours(24, 'not-a-number')).toBe(24)
    expect(resolveHours(24, ['0'])).toBe(24)
  })

  it('uses seven days when both the query and configuration are invalid', () => {
    expect(resolveHours('invalid', undefined)).toBe(168)
  })
})
