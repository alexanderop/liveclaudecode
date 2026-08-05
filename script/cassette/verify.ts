/**
 * Cassette gates 1 to 3.
 *
 *   pnpm cassette:verify
 *
 * Runs inside `pnpm check` and in CI. Gate 4 — blessing sync — needs no
 * separate step: it is L1 to L3 running, and any drift fails them.
 *
 * Every failure here is reported with the whole list rather than the first
 * offender, because these are the checks an operator hits at the end of a
 * capture and a one-at-a-time gate turns that into four round trips.
 */
import { execFileSync } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CASSETTE_BYTE_BUDGET,
  CASSETTE_SOURCES,
  RULES_VERSION,
} from '../../test/cassettes/redaction/rules.ts'
import {
  allCassettes,
  CASSETTE_DIRECTORY,
  COMBINED_API_EXPECTATION,
} from '../../test/fixtures/cassette.ts'
import { runScript } from './args.ts'
import { sha256 } from './hash.ts'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))

/** Constant-time comparison, so a hash check cannot leak position by timing. */
function hashesMatch(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex')
  const b = Buffer.from(right, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Files git actually tracks below `test/cassettes`, as repository-relative paths. */
function trackedCassetteFiles(): readonly string[] {
  try {
    return execFileSync('git', ['ls-files', '--', 'test/cassettes'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    }).split('\n').filter(Boolean)
  } catch {
    // Not a git checkout — a tarball, or a sandbox without git. The other gates
    // still apply; only the "is this committed?" question becomes unanswerable.
    return []
  }
}

/**
 * Bytes of *cassette data* — recordings and their blessed expectations.
 *
 * `redaction/` is source code that happens to live under the same directory;
 * counting it would let a comment in `rules.ts` eat into the recording budget,
 * which is not a trade anyone should be asked to make.
 */
function cassetteBytes(directory: string): number {
  let total = 0
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    if (relative(directory, path).replaceAll('\\', '/').startsWith('redaction/')) continue
    total += statSync(path).size
  }
  return total
}

await runScript('Usage: pnpm cassette:verify', () => {
  const problems: string[] = []
  const cassettes = allCassettes()

  // -- Gate 1: coverage -----------------------------------------------------

  for (const source of CASSETTE_SOURCES) {
    const forSource = cassettes.filter(cassette => cassette.manifest.source.includes(source))
    if (!forSource.length) {
      problems.push(
        `No cassette for source ${source}. Record one following docs/cassette-scenarios.md — `
        + 'until then, a format change in that tool fails no test.',
      )
      continue
    }
    if (!forSource.some(cassette => cassette.manifest.e2e)) {
      problems.push(
        `No cassette for source ${source} is marked "e2e": true, so the L3 tier never replays it `
        + 'and discovery, aggregation, and the HTTP contract go unexercised for that source.',
      )
    }
  }

  if (cassettes.some(cassette => cassette.manifest.e2e) && !existsSync(COMBINED_API_EXPECTATION)) {
    problems.push(
      'Cassettes are marked "e2e": true but test/cassettes/expected/api.json is missing, '
      + 'so the L3 tier has nothing to assert against. Run `pnpm cassette:bless:api`.',
    )
  }

  // -- Gate 2: hygiene ------------------------------------------------------
  //
  // The residue scanners themselves run in test/unit/cassette-hygiene.spec.ts,
  // where they are a test rather than a script. What belongs here is the one
  // hygiene question a test cannot answer: what git is tracking.

  const leakedIdentities = trackedCassetteFiles()
    .filter(path => path.endsWith('.identities.local.json'))
  if (leakedIdentities.length) {
    problems.push(
      `Identity decode tables are tracked by git: ${leakedIdentities.join(', ')}. `
      + 'These map pseudonyms back to real values and must never be committed; '
      + 'they are covered by .gitignore, so this means they were force-added.',
    )
  }

  // -- Gate 3: budget and integrity -----------------------------------------

  const bytes = cassetteBytes(CASSETTE_DIRECTORY)
  if (bytes > CASSETTE_BYTE_BUDGET) {
    problems.push(
      `Cassettes total ${(bytes / 1_024).toFixed(0)} KB, over the `
      + `${(CASSETTE_BYTE_BUDGET / 1_024).toFixed(0)} KB budget. Lower --limit on the largest `
      + 'cassette or retire one; raising the cap is a decision, not a fix.',
    )
  }

  for (const cassette of cassettes) {
    const { manifest } = cassette

    if (manifest.provenance !== 'sandbox') {
      problems.push(
        `${cassette.id} is marked "provenance": "${manifest.provenance}". `
        + 'Ad-hoc captures are local-only; reproduce the shape in the sandbox and add a '
        + 'scripted scenario instead.',
      )
    }

    if (manifest.source.length === 1) {
      const source = manifest.source[0]!
      if (manifest.redaction.rules !== RULES_VERSION[source]) {
        problems.push(
          `${cassette.id} was recorded under redaction rules ${manifest.redaction.rules}, but `
          + `${source} is now on ${RULES_VERSION[source]}. Re-record it so the committed data `
          + 'matches the classification it is judged by.',
        )
      }
    }

    for (const entry of manifest.entries) {
      const content = cassette.files.get(entry.path)
      if (content === undefined) {
        problems.push(`${cassette.id} lists ${entry.path} but the file is missing`)
        continue
      }
      if (!hashesMatch(sha256(content), entry.sha256)) {
        problems.push(
          `${cassette.id}/${entry.path} does not match its recorded sha256. `
          + 'A cassette is a recording, never a hand-edit — re-record it.',
        )
      }
      if (Buffer.byteLength(content) !== entry.bytes) {
        problems.push(
          `${cassette.id}/${entry.path} is ${Buffer.byteLength(content)} bytes, `
          + `manifest says ${entry.bytes}`,
        )
      }
    }

    // Every file present must be listed, not only every listed file present:
    // an unlisted file is one nothing hashed and nothing scanned.
    const filesDirectory = join(cassette.directory, 'files')
    const listed = new Set(manifest.entries.map(entry => entry.path))
    for (const entry of readdirSync(filesDirectory, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue
      const path = relative(filesDirectory, join(entry.parentPath, entry.name)).replaceAll('\\', '/')
      if (!listed.has(path)) {
        problems.push(`${cassette.id} carries ${path}, which no manifest entry lists`)
      }
    }

    for (const issue of manifest.expectedParseIssues) {
      if (!issue.reason.trim()) {
        problems.push(
          `${cassette.id} allows a parse issue at ${issue.path}:${issue.line} with no reason. `
          + 'An unexplained allowance is how a real regression gets waved through.',
        )
      }
    }
  }

  if (problems.length) {
    throw new Error(
      `Cassette verification failed (${problems.length}):\n\n`
      + problems.map(problem => `  • ${problem}`).join('\n\n'),
    )
  }

  process.stderr.write(
    `Verified ${cassettes.length} cassette(s), ${(bytes / 1_024).toFixed(0)} KB of `
    + `${(CASSETTE_BYTE_BUDGET / 1_024).toFixed(0)} KB budget.\n`,
  )
})
