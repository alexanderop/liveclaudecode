import { describe, expect, it } from 'vitest'
import { createLatestRequestGate } from '~/utils/latest-request-gate'

describe('createLatestRequestGate', () => {
  it('deduplicates a key that is already in flight', () => {
    const gate = createLatestRequestGate()
    const first = gate.start('a')

    expect(first).not.toBeNull()
    expect(gate.start('a')).toBeNull()
  })

  it('allows the same key again after the request settles', () => {
    const gate = createLatestRequestGate()
    const first = gate.start('a')!
    gate.settle(first)

    expect(gate.start('a')).not.toBeNull()
  })

  it('marks earlier tokens stale when a newer request starts', () => {
    const gate = createLatestRequestGate()
    const first = gate.start('a')!
    const second = gate.start('b')!

    expect(gate.isCurrent(first)).toBe(false)
    expect(gate.isCurrent(second)).toBe(true)
  })

  it('keeps only the newest token current across an A-B-A cycle', () => {
    const gate = createLatestRequestGate()
    const staleA = gate.start('a')!
    gate.start('b')
    const freshA = gate.start('a')!

    expect(gate.isCurrent(staleA)).toBe(false)
    expect(gate.isCurrent(freshA)).toBe(true)
  })

  it('settling a superseded token does not release the newer pending key', () => {
    const gate = createLatestRequestGate()
    const staleA = gate.start('a')!
    gate.start('b')
    const freshA = gate.start('a')!
    gate.settle(staleA)

    expect(gate.start('a')).toBeNull()
    expect(gate.isCurrent(freshA)).toBe(true)
  })

  it('invalidate stales every token and clears the pending slot', () => {
    const gate = createLatestRequestGate()
    const token = gate.start('a')!
    gate.invalidate()

    expect(gate.isCurrent(token)).toBe(false)
    expect(gate.start('a')).not.toBeNull()
  })
})
