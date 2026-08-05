import { assert, describe, it } from '@effect/vitest'
import { allCassettes, type Cassette } from '../fixtures/cassette'
import { decodeParseCensus } from '../fixtures/cassette-schema'
import { isTranscript, projectConformance } from '../fixtures/cassette-projection'
import { CASSETTE_CLOCK_ANCHOR, CASSETTE_SOURCES } from '../cassettes/redaction/rules'

/**
 * Level 1 — schema conformance.
 *
 * The format-drift alarm, and the cheapest of the three replay tiers: it never
 * builds a scanner, only decodes each record with the parser its source would
 * use in production. That is what makes it affordable to run over the whole
 * corpus on every unit run, which in turn is what makes it a *drift* alarm
 * rather than a spot check.
 *
 * What it can catch that a synthetic fixture cannot: `shared/schemas/*` decode
 * with `onExcessProperty: 'preserve'`, on purpose, so a *renamed* vendor field
 * does not fail a decode — it produces a record that parses and means less. A
 * fixture written against the old name keeps passing forever. A recording from
 * a newer tool version does not.
 */

const cassettes = allCassettes()

describe('cassette conformance', () => {
  it('has at least one cassette per supported source', () => {
    // A guard on the table below: `describe.each` over an empty list is a
    // green run, and "no cassettes" must never read as "nothing drifted".
    const missing = CASSETTE_SOURCES.filter(source =>
      !cassettes.some(cassette => cassette.manifest.source.includes(source)),
    )
    assert.deepStrictEqual(
      missing,
      [],
      `No cassette recorded for: ${missing.join(', ')}. `
      + 'Record one following docs/cassette-scenarios.md.',
    )
  })

  it('anchors every cassette to the same instant', () => {
    // The property that makes a re-record reviewable. With an anchor derived
    // from capture time, re-recording one unchanged session across an hour
    // boundary rewrites every timestamp, mtime, and hash — a one-line diff
    // becomes a wholesale replacement, and nobody reads those.
    assert.deepStrictEqual(
      cassettes.map(cassette => cassette.manifest.clockAnchor),
      cassettes.map(() => CASSETTE_CLOCK_ANCHOR),
    )
  })

  for (const cassette of cassettes) {
    describe(cassette.id, () => {
      const conformance = projectConformance(cassette)

      it('decodes every record, or names it in expectedParseIssues', () => {
        const allowed = new Set(
          cassette.manifest.expectedParseIssues.map(issue =>
            `${issue.path}:${issue.line}:${issue.kind}`,
          ),
        )
        const unexplained = conformance.issues
          .filter(issue => !allowed.has(`${issue.path}:${issue.line}:${issue.kind}`))
          .map(issue => `${issue.path}:${issue.line} (${issue.kind}) ${issue.detail}`)

        assert.deepStrictEqual(
          unexplained,
          [],
          'Records this cassette carries no longer decode. Either the tool changed its '
          + 'format and the schemas must catch up, or the change is expected and the '
          + 'cassette should be re-recorded.',
        )
      })

      it('has no stale entry in expectedParseIssues', () => {
        // A listed issue that now decodes means someone widened a schema and
        // left the allowance behind. Left alone, it is a standing permission
        // for a real regression to land unnoticed at that exact line.
        const observed = new Set(
          conformance.issues.map(issue => `${issue.path}:${issue.line}:${issue.kind}`),
        )
        const stale = cassette.manifest.expectedParseIssues
          .filter(issue => !observed.has(`${issue.path}:${issue.line}:${issue.kind}`))
          .map(issue => `${issue.path}:${issue.line} (${issue.kind}) — ${issue.reason}`)

        assert.deepStrictEqual(
          stale,
          [],
          'These records now decode. Re-bless the cassette so the allowance list matches reality.',
        )
      })

      it('matches the record count each manifest entry declares', () => {
        const declared = Object.fromEntries(
          cassette.manifest.entries
            .filter(entry => isTranscript(entry.path))
            .map(entry => [entry.path, entry.records]),
        )
        const counted = Object.fromEntries(
          Object.entries(conformance.census.byFile).map(([path, file]) => [path, file.records]),
        )
        assert.deepStrictEqual(counted, declared)
      })

      it('matches the blessed parse census exactly', () => {
        // The census, not a total: a change from "3 invalid-json" to
        // "3 schema-mismatch" is a different problem with a different owner,
        // and a total would hide it.
        assert.deepStrictEqual(
          conformance.census,
          decodeParseCensus(cassette.expected('parse')),
        )
      })

      it('carries every file its manifest lists, byte for byte', () => {
        assertEntriesMatchFiles(cassette)
      })
    })
  }
})

function assertEntriesMatchFiles(cassette: Cassette): void {
  for (const entry of cassette.manifest.entries) {
    const content = cassette.files.get(entry.path)
    assert.ok(content !== undefined, `${cassette.id} lists ${entry.path} but the file is absent`)
    assert.strictEqual(
      Buffer.byteLength(content),
      entry.bytes,
      `${cassette.id}/${entry.path} byte count disagrees with its manifest entry`,
    )
  }
}
