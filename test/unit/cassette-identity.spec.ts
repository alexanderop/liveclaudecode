import { assert, describe, it } from '@effect/vitest'
import { IdentityTable } from '../../script/cassette/identity.ts'
import { scanChunks } from '../cassettes/redaction/scanners'

/**
 * Substitution is the half of the safety model that has no second chance.
 *
 * The residue scanners fail closed, so a value the table misses aborts the
 * recording rather than reaching the repository — but only if the scanners
 * happen to have a detector for its shape. Everything here is a case where a
 * plausible-looking table let a real value through and a real recording
 * carried it, so each test is a leak that happened rather than one imagined.
 */

const CAPTURE = '/private/tmp/runner-501/-Users-real-Projects-work/9f2c/scratchpad/box/sandbox'

function tableForCapture(): IdentityTable {
  const table = new IdentityTable('probe/one')
  table.observe('user', 'realname')
  table.observeDirectory(CAPTURE)
  return table
}

describe('cassette identity substitution', () => {
  it('rewrites a capture path split across a line break', () => {
    // Terminal output wraps, and a stack frame is where it wraps. The naive
    // implementation — every literal first, then every tolerant pattern —
    // passes a simpler version of this test and fails this one: the literal
    // pass replaces the shorter known *prefix* `/private/tmp/runner-501`,
    // leaving nothing for the longer value's tolerant pattern to match, and
    // the tail below the break survives into the cassette.
    const table = tableForCapture()

    const rewritten = table.apply(
      `at Context.<anonymous> (file://${CAPTURE.slice(0, 48)}\n${CAPTURE.slice(48)}/test/a.test.ts:9:3)`,
    )

    assert.ok(!rewritten.includes('scratchpad'), rewritten)
    assert.ok(!rewritten.includes('runner-501'), rewritten)
    assert.deepStrictEqual(
      scanChunks([{ label: 'probe', text: rewritten, keyClass: 'scrub' }], []),
      [],
    )
  })

  it('maps every ancestor of the capture directory, not only the directory', () => {
    // Tool output quotes ancestors constantly — an npm log path, a `cd`, a
    // stack frame. Mapping only the capture directory leaves each of them
    // intact, which is how a recording publishes the operator's layout.
    const table = tableForCapture()

    const rewritten = table.apply(`cd /private/tmp/runner-501/-Users-real-Projects-work && ls`)

    assert.strictEqual(rewritten, 'cd /Users/user-1 && ls')
  })

  it('renames an attached configuration file by path, basename, and stem', () => {
    // VS Code labels an attached instruction file `prompt:agent-browser.md`
    // with no path at all, and the model then discusses it by name in its own
    // prose. Replacing only the path leaves the inventory in the two places a
    // reader would actually notice it.
    const table = new IdentityTable('probe/two')
    table.observe('user', 'realname')
    table.observeConfigPath('/Users/realname/.claude/rules/agent-browser.md')

    assert.strictEqual(
      table.apply('/Users/realname/.claude/rules/agent-browser.md'),
      '/Users/user-1/.agent-config/file-1.md',
    )
    assert.strictEqual(table.apply('prompt:agent-browser.md'), 'prompt:file-1.md')
    assert.strictEqual(
      table.apply('the agent-browser rule might not apply'),
      'the file-1 rule might not apply',
    )
  })

  it('leaves a short configuration name alone', () => {
    // `test.md` cannot be substituted out of a transcript without wrecking
    // unrelated text, so the path is renamed and the bare name is not.
    const table = new IdentityTable('probe/three')
    table.observe('user', 'realname')
    table.observeConfigPath('/Users/realname/.claude/test.md')

    assert.strictEqual(table.apply('see test.md for details'), 'see test.md for details')
  })

  it('keeps one real value on one pseudonym across every spelling', () => {
    // The table is global to a cassette. A path rewritten one way in the
    // transcript body and another in the file layout still parses, and its
    // file-change aggregation is nonsense.
    const table = tableForCapture()

    assert.strictEqual(table.observeDirectory(CAPTURE), table.apply(CAPTURE))
    table.assertInjective()
  })
})
