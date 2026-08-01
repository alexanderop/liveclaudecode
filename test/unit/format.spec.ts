import { describe, expect, it } from 'vitest'
import {
  formatCount,
  formatDuration,
  formatMilliseconds,
  formatRelativeAge,
  formatUsd,
  parseTimestamp,
  secondsBetween,
  sessionSourceLabel,
} from '~/utils/format'

describe('display formatting', () => {
  it('formats estimated USD costs without hiding sub-cent usage', () => {
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(0.0042)).toBe('$0.004')
    expect(formatUsd(1.236)).toBe('$1.24')
  })

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

describe('parseTimestamp', () => {
  it('parses ISO timestamps and rejects missing or malformed values', () => {
    expect(parseTimestamp('2026-07-25T18:00:00.000Z')).toBe(Date.parse('2026-07-25T18:00:00.000Z'))
    expect(parseTimestamp(null)).toBeNull()
    expect(parseTimestamp('')).toBeNull()
    expect(parseTimestamp('not-a-date')).toBeNull()
  })
})

describe('formatRelativeAge', () => {
  it.each([
    [0, 'Now'],
    [4_999, 'Now'],
    [5_000, '5s ago'],
    [59_000, '59s ago'],
    [60_000, '1m ago'],
    [59 * 60_000, '59m ago'],
    [61 * 60_000, '1h ago'],
    [26 * 3_600_000, '26h ago'],
  ])('formats %s ms without a prefix', (value, expected) => {
    expect(formatRelativeAge(value)).toBe(expected)
  })

  it('applies the prefix in lowercase form, including for the "now" case', () => {
    expect(formatRelativeAge(1_000, { prefix: 'Updated' })).toBe('Updated now')
    expect(formatRelativeAge(90_000, { prefix: 'Updated' })).toBe('Updated 1m ago')
  })

  it('reports missing timestamps with the configured label', () => {
    expect(formatRelativeAge(null)).toBe('No event')
    expect(formatRelativeAge(null, { noneLabel: 'No recent event' })).toBe('No recent event')
  })
})

describe('sessionSourceLabel', () => {
  it.each([
    ['claude', 'Claude'],
    ['codex', 'Codex'],
    ['copilot', 'Copilot'],
  ] as const)('labels the %s source', (source, expected) => {
    expect(sessionSourceLabel(source)).toBe(expected)
  })

  it('falls back to Local when no source is known', () => {
    expect(sessionSourceLabel(null)).toBe('Local')
    expect(sessionSourceLabel(undefined)).toBe('Local')
  })
})
