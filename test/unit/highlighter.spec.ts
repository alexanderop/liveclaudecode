import { assert, describe, it } from '@effect/vitest'
import { highlightCode } from '~/utils/highlighter'

describe('highlightCode', () => {
  it('tokenizes a loaded grammar', async () => {
    const html = await highlightCode('const answer = 42', { language: 'ts' })

    assert.ok(html.includes('class="shiki'), 'expected Shiki markup')
    assert.ok(html.includes('>const</span>'), 'expected `const` to be its own token')
  })

  it('emits both themes so the color mode switches without re-highlighting', async () => {
    const html = await highlightCode('a', { language: 'text' })

    assert.ok(html.includes('shiki-themes github-light github-dark-default'))
    assert.ok(html.includes('light-dark('), 'expected light-dark() colors')
  })

  it('leaves the background to the surrounding stylesheet', async () => {
    const html = await highlightCode('a', { language: 'text' })

    assert.ok(!html.includes('background-color:'))
  })

  it('marks added, removed, and highlighted lines', async () => {
    const html = await highlightCode('one\ntwo\nthree', {
      language: 'text',
      removed: [1],
      added: [2],
      highlights: [3],
    })

    assert.ok(html.includes('line line-remove'))
    assert.ok(html.includes('line line-add'))
    assert.ok(html.includes('line line-highlight'))
  })

  it('renders an unknown language as plain text rather than failing', async () => {
    const html = await highlightCode('%%% not a language %%%', { language: 'brainfuck' })

    assert.ok(html.includes('%%% not a language %%%'))
  })

  it('escapes markup in the source', async () => {
    const html = await highlightCode('<script>alert(1)</script>', { language: 'text' })

    assert.ok(!html.includes('<script>'))
    assert.ok(html.includes('&#x3C;script>'))
  })
})
