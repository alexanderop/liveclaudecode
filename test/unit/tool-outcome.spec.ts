import { assert, describe, it } from '@effect/vitest'
import {
  FAILED_OUTCOME_STATUS_SET,
  FAILED_OUTCOME_STATUSES,
  PASSED_OUTCOME_STATUS_SET,
  PASSED_OUTCOME_STATUSES,
} from '../../shared/schemas/tool-outcome'

describe('tool outcome status vocabulary', () => {
  it('derives each lookup set from its status list', () => {
    assert.deepStrictEqual([...FAILED_OUTCOME_STATUS_SET].sort(), [...FAILED_OUTCOME_STATUSES].sort())
    assert.deepStrictEqual([...PASSED_OUTCOME_STATUS_SET].sort(), [...PASSED_OUTCOME_STATUSES].sort())
  })

  it('classifies the statuses the scanners rely on', () => {
    for (const status of ['failed', 'error', 'denied', 'cancelled', 'canceled', 'timed_out', 'timeout']) {
      assert.isTrue(FAILED_OUTCOME_STATUS_SET.has(status), status)
    }
    for (const status of ['completed', 'success', 'succeeded', 'ok', 'passed']) {
      assert.isTrue(PASSED_OUTCOME_STATUS_SET.has(status), status)
    }
  })

  it('keeps the failed and passed vocabularies disjoint and lowercase', () => {
    for (const status of FAILED_OUTCOME_STATUS_SET) {
      assert.isFalse(PASSED_OUTCOME_STATUS_SET.has(status), status)
      assert.strictEqual(status, status.toLowerCase())
    }
    for (const status of PASSED_OUTCOME_STATUS_SET) {
      assert.strictEqual(status, status.toLowerCase())
    }
  })

  it('does not classify unknown statuses', () => {
    assert.isFalse(FAILED_OUTCOME_STATUS_SET.has('running'))
    assert.isFalse(PASSED_OUTCOME_STATUS_SET.has('running'))
  })
})
