import { describe, expect, it } from 'vitest'
import {
  formatCount,
  formatDuration,
  formatMilliseconds,
  secondsBetween,
} from '~/utils/format'

describe('display formatting', () => {
  it.each([
    [0, 0],
    [999, 999],
    [1_000, '1.0k'],
    [12_500, '12.5k'],
    [1_000_000, '1.0M'],
  ])('formats the count boundary %s', (value, expected) => {
    expect(formatCount(value)).toBe(expected)
  })

  it('formats transcript spans without inventing time for missing timestamps', () => {
    expect(secondsBetween(null, '2026-07-25T18:00:00.000Z')).toBe(0)
    expect(formatDuration(null, null)).toBe('0s')
    expect(formatDuration(
      '2026-07-25T18:00:00.000Z',
      '2026-07-25T19:02:03.000Z',
    )).toBe('1h2m')
  })

  it.each([
    [499, '499ms'],
    [1_000, '1s'],
    [65_000, '1m5s'],
    [3_720_000, '1h2m'],
  ])('formats the millisecond duration %s', (value, expected) => {
    expect(formatMilliseconds(value)).toBe(expected)
  })
})
