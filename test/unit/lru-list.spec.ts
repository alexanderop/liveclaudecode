import { describe, expect, it } from 'vitest'
import type { LruEntry } from '~/utils/lru-list'
import { ensureLruEntry, touchLruEntry } from '~/utils/lru-list'

describe('lru list', () => {
  it('creates an entry once and returns the same state afterwards', () => {
    const entries: LruEntry<{ count: number }>[] = []
    const created = ensureLruEntry(entries, 'a', () => ({ count: 0 }))
    created.count = 5

    expect(ensureLruEntry(entries, 'a', () => ({ count: 0 }))).toBe(created)
    expect(entries).toHaveLength(1)
  })

  it('moves a touched entry to the most-recently-used position', () => {
    const entries: LruEntry<string>[] = []
    ensureLruEntry(entries, 'a', () => 'a')
    ensureLruEntry(entries, 'b', () => 'b')
    touchLruEntry(entries, 'a', 'a', 10)

    expect(entries.map(entry => entry.identity)).toEqual(['b', 'a'])
  })

  it('evicts the least recently used entry beyond capacity', () => {
    const entries: LruEntry<string>[] = []
    for (const identity of ['a', 'b', 'c']) {
      ensureLruEntry(entries, identity, () => identity)
      touchLruEntry(entries, identity, identity, 2)
    }

    expect(entries.map(entry => entry.identity)).toEqual(['b', 'c'])
  })

  it('re-inserts an evicted identity when touched with retained state', () => {
    const entries: LruEntry<string>[] = []
    const state = ensureLruEntry(entries, 'a', () => 'kept')
    touchLruEntry(entries, 'b', 'b', 1)

    expect(entries.map(entry => entry.identity)).toEqual(['b'])

    touchLruEntry(entries, 'a', state, 1)

    expect(entries).toEqual([{ identity: 'a', state: 'kept' }])
  })
})
