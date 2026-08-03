import { assert, describe, it } from '@effect/vitest'
import { comarkCodeText } from '~/utils/comark-node'

describe('comarkCodeText', () => {
  it('reads the source out of a fence node', () => {
    const node = ['pre', { language: 'ts' }, ['code', { class: 'language-ts' }, 'const a = 1']]

    assert.strictEqual(comarkCodeText(node), 'const a = 1')
  })

  it('concatenates text split across sibling children', () => {
    const node = ['pre', {}, ['code', {}, 'line one\n', 'line two']]

    assert.strictEqual(comarkCodeText(node), 'line one\nline two')
  })

  it('returns an empty string for a fence with no content', () => {
    assert.strictEqual(comarkCodeText(['pre', {}, ['code', {}]]), '')
  })

  it('returns an empty string for values that are not nodes', () => {
    assert.strictEqual(comarkCodeText(undefined), '')
    assert.strictEqual(comarkCodeText(null), '')
    assert.strictEqual(comarkCodeText({ tag: 'pre' }), '')
  })
})
