import type { DiffLine } from '~/utils/line-diff'
import { assert, describe, it } from '@effect/vitest'
import * as fc from 'fast-check'
import { diffLines } from '~/utils/line-diff'

const side = (lines: readonly DiffLine[], dropped: DiffLine['kind']): string[] =>
  lines.filter(line => line.kind !== dropped).map(line => line.text)

describe('diffLines', () => {
  it('marks nothing when both sides are identical', () => {
    assert.deepStrictEqual(diffLines('a\nb', 'a\nb'), [
      { text: 'a', kind: 'context' },
      { text: 'b', kind: 'context' },
    ])
  })

  it('emits the removal before the addition at a divergence', () => {
    assert.deepStrictEqual(diffLines('a\nold\nc', 'a\nnew\nc'), [
      { text: 'a', kind: 'context' },
      { text: 'old', kind: 'remove' },
      { text: 'new', kind: 'add' },
      { text: 'c', kind: 'context' },
    ])
  })

  it('reports a pure insertion without touching the surrounding lines', () => {
    assert.deepStrictEqual(diffLines('a\nc', 'a\nb\nc'), [
      { text: 'a', kind: 'context' },
      { text: 'b', kind: 'add' },
      { text: 'c', kind: 'context' },
    ])
  })

  it('treats a trailing newline as terminating the last line', () => {
    assert.deepStrictEqual(diffLines('a\n', 'a'), [{ text: 'a', kind: 'context' }])
  })

  it('returns every line as added when there is no prior content', () => {
    assert.deepStrictEqual(diffLines('', 'a\nb'), [
      { text: 'a', kind: 'add' },
      { text: 'b', kind: 'add' },
    ])
  })

  it('returns nothing for two empty sides', () => {
    assert.deepStrictEqual(diffLines('', ''), [])
  })

  it('degrades to a wholesale replacement past the line budget', () => {
    const before = Array.from({ length: 5 }, (_, i) => `line ${i}`).join('\n')
    const after = `${before}\nextra`

    assert.deepStrictEqual(diffLines(before, after, { maxLines: 3 }), [
      ...before.split('\n').map(text => ({ text, kind: 'remove' })),
      ...after.split('\n').map(text => ({ text, kind: 'add' })),
    ])
  })

  // Examples cannot cover the LCS backtrack, so the round-trip is asserted over
  // generated inputs: dropping the additions must rebuild the original text and
  // dropping the removals must rebuild the replacement.
  it.prop(
    'reconstructs both sides from the marked lines',
    [
      fc.array(fc.stringMatching(/^[a-c]{1,3}$/), { maxLength: 12 }),
      fc.array(fc.stringMatching(/^[a-c]{1,3}$/), { maxLength: 12 }),
    ],
    ([before, after]) => {
      const lines = diffLines(before.join('\n'), after.join('\n'))

      assert.deepStrictEqual(side(lines, 'add'), before)
      assert.deepStrictEqual(side(lines, 'remove'), after)
    },
  )
})
