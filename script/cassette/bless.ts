/**
 * Recompute a cassette's blessed expectations.
 *
 *   pnpm cassette:bless [--id claude/fanout-with-subagents]
 *
 * Writes `expected/parse.json` and `expected/scan.json`, and fills in the
 * manifest's `expectedParseIssues` from what the real parsers actually reject.
 * `expected/api.json` is produced by the e2e tier instead — computing it needs
 * a running Nitro server, which is exactly what L3 already stands up.
 *
 * Blessing is never automatic and never runs in CI. A pull request that changes
 * a blessed file has to explain the change in its description; that diff is the
 * entire point of the system.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Effect } from 'effect'
import { allCassettes, type Cassette, loadCassette } from '../../test/fixtures/cassette.ts'
import {
  blessedJson,
  projectCassetteScan,
  projectConformance,
} from '../../test/fixtures/cassette-projection.ts'
import { parseArguments, runScript, UsageError } from './args.ts'

const USAGE = `Usage:
  pnpm cassette:bless [--id <source>/<scenario>]

With no --id, every committed cassette is re-blessed.`

/**
 * The reason attached to a parse issue the recorder found.
 *
 * `expectedParseIssues` exists so that "our real-world malformed rate" is a
 * reviewed constant rather than an unknown. These defaults describe *what* was
 * observed; a reviewer who disagrees with the characterization should be
 * re-recording the cassette, not editing the manifest.
 */
const ISSUE_REASON: Readonly<Record<string, string>> = {
  'invalid-json': 'truncated or interleaved write observed in the recorded session',
  'schema-mismatch': 'record shape this repository does not model yet',
  'unsupported-shape': 'record decoded but could not be applied by the scanner',
}

const blessOne = Effect.fn('blessOne')(function*(cassette: Cassette) {
  const conformance = projectConformance(cassette)
  const scan = yield* projectCassetteScan(cassette).pipe(Effect.provide(cassette.layer))

  const expected = join(cassette.directory, 'expected')
  mkdirSync(expected, { recursive: true })
  writeFileSync(join(expected, 'parse.json'), blessedJson(conformance.census))
  writeFileSync(join(expected, 'scan.json'), blessedJson(scan))

  // The manifest's allowance list is derived, not authored: a hand-written one
  // drifts out of date silently, and L1 fails on a stale entry as loudly as on
  // a new issue.
  const manifestPath = join(cassette.directory, 'cassette.json')
  const manifest: Record<string, unknown> = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.expectedParseIssues = conformance.issues.map(issue => ({
    path: issue.path,
    line: issue.line,
    kind: issue.kind,
    reason: ISSUE_REASON[issue.kind] ?? issue.detail,
  }))
  writeFileSync(manifestPath, blessedJson(manifest))

  const total = conformance.issues.length
  process.stderr.write(
    `  ${cassette.id}: ${scan.files.length} transcript(s), `
    + `${Object.values(conformance.census.byFile).reduce((sum, file) => sum + file.records, 0)} record(s), `
    + `${total} expected parse issue(s)\n`,
  )
})

await runScript(USAGE, async () => {
  const { options } = parseArguments(process.argv.slice(2), { string: ['id'] })

  const cassettes = typeof options.id === 'string'
    ? [loadCassette(options.id)]
    : allCassettes()

  if (!cassettes.length) {
    throw new UsageError('No cassettes found under test/cassettes. See docs/cassette-scenarios.md.')
  }

  for (const cassette of cassettes) {
    await Effect.runPromise(blessOne(cassette))
  }

  process.stderr.write(
    `\nBlessed ${cassettes.length} cassette(s). `
    + 'Review the diff before committing — it is the signal, not the noise.\n',
  )
})
