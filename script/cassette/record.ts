/**
 * The cassette recorder.
 *
 *   pnpm cassette:record --source claude --scenario fanout-with-subagents \
 *     --session 01J8X... [--keep-repo-name] [--limit 400] [--unsafe-adhoc]
 *
 * A developer tool, not server domain code, so the repository's rule about
 * using the Effect filesystem does not bind it: this is plain TypeScript on
 * `node:fs`, run by a bare Node process with type stripping.
 *
 * The pipeline runs in order and aborts on the first failure, writing nothing
 * until every check has passed. Read `docs/transcript-cassettes-spec.md` §7 for
 * why each step exists and `docs/cassette-scenarios.md` for how to produce a
 * session worth recording.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, platform, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CASSETTE_CLOCK_ANCHOR,
  CLIP_LIMIT_BYTES,
  DEFAULT_RECORD_LIMIT,
  isCassetteSource,
  NEWEST_RECORD_LEAD_MS,
  RULES_VERSION,
} from '../../test/cassettes/redaction/rules.ts'
import {
  collectEnvironmentSecrets,
  chunksForFile,
  formatResidueHits,
  scanChunks,
} from '../../test/cassettes/redaction/scanners.ts'
import { integerOption, parseArguments, requiredString, runScript, UsageError } from './args.ts'
import { sha256 } from './hash.ts'
import { IdentityTable } from './identity.ts'
import { assertSlugsConsistent, learnIdentities, newestTimestamp, redact } from './redact.ts'
import { resolveRoots, SOURCES } from './sources.ts'
import { describeSelection, selectSession } from './select.ts'

const USAGE = `Usage:
  pnpm cassette:record --source <claude|codex|copilot|copilot-cli>
                       --scenario <name> --session <id>
                       [--keep-repo-name] [--limit N] [--clip-limit N]
                       [--notes "..."] [--producer-version X]
                       [--skip-e2e] [--skip-browser]
                       [--unsafe-adhoc --i-have-reviewed]

See docs/cassette-scenarios.md for the capture protocol.`

const ADHOC_CHECKLIST = `--unsafe-adhoc records a session that was NOT run against the sandbox
repository, so its free text is real work rather than disposable content.
Before re-running with --i-have-reviewed, confirm every line:

  [ ] No credential, token, or .env content appears in any prompt, tool
      result, or command output in this session.
  [ ] No proprietary source code was read or written during this session.
  [ ] No third party is named or identifiable in the prompts or replies.
  [ ] No client, employer, or repository name appears that should not be public.
  [ ] You have read the recorder's review summary, not skimmed it.

The resulting cassette is LOCAL ONLY. \`pnpm cassette:verify\` fails on a
committed manifest with "provenance": "adhoc".`

/**
 * Where each tool stamps its own version.
 *
 * `version` is listed alongside the specific keys because Claude Code uses it
 * for a semantic version while Copilot CLI and VS Code use it for a schema
 * revision — the `SEMVER` guard is what tells those apart, so a `"version": 1`
 * never becomes a producer version.
 */
const VERSION_KEYS = new Set([
  'version',
  'cli_version',
  'cliVersion',
  'appVersion',
  'copilotVersion',
])
const SEMVER = /^\d+\.\d+\.\d+/

const cassetteRoot = fileURLToPath(new URL('../../test/cassettes/', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))

/** The version the producing tool stamped into its own records, if any. */
function detectProducerVersion(files: readonly { content: string }[]): string {
  for (const file of files) {
    for (const line of file.content.split('\n')) {
      if (!line.trim()) continue
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        continue
      }
      const found = findVersion(value)
      if (found) return found
    }
  }
  return ''
}

function findVersion(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  for (const [key, nested] of Object.entries(value)) {
    if (VERSION_KEYS.has(key) && typeof nested === 'string' && SEMVER.test(nested)) return nested
    const deeper = findVersion(nested)
    if (deeper) return deeper
  }
  return ''
}

await runScript(USAGE, () => {
  const { options } = parseArguments(process.argv.slice(2), {
    string: ['source', 'scenario', 'session', 'limit', 'clip-limit', 'notes', 'producer-version'],
    boolean: ['keep-repo-name', 'unsafe-adhoc', 'i-have-reviewed', 'skip-e2e', 'skip-browser'],
  })

  const source = requiredString(options, 'source')
  if (!isCassetteSource(source)) {
    throw new UsageError(`--source must be one of claude, codex, copilot, copilot-cli (got ${source})`)
  }
  const scenario = requiredString(options, 'scenario')
  const sessionId = requiredString(options, 'session')
  const limit = integerOption(options, 'limit', DEFAULT_RECORD_LIMIT)
  const clipLimit = integerOption(options, 'clip-limit', CLIP_LIMIT_BYTES)
  const adhoc = options['unsafe-adhoc'] === true

  if (adhoc && options['i-have-reviewed'] !== true) {
    throw new UsageError(ADHOC_CHECKLIST)
  }

  const id = `${source}/${scenario}`
  const directory = join(cassetteRoot, source, scenario)

  // 1. Resolve roots — the same precedence the server uses.
  const roots = resolveRoots()

  // 2. Select the session and everything the tool associates with it.
  const selection = selectSession(source, sessionId, roots)
  process.stderr.write(`Selected ${selection.files.length} file(s):\n${describeSelection(selection)}\n\n`)

  // 3. Build the identity table, in one pass, before any substitution.
  //
  // The secrets are collected once and reused by the residue scan in step 7:
  // each collection shells out to `git config`, and nothing between the two
  // steps can change the answer.
  const secrets = collectEnvironmentSecrets(repositoryRoot)
  const table = new IdentityTable(id)
  table.observe('user', userInfo().username)
  table.observe('host', hostname())
  for (const secret of secrets) {
    if (secret.name === 'git user.name') table.alias(secret.value, table.primaryUser, 'user')
    if (secret.name === 'git user.email') table.observe('email', secret.value)
  }
  learnIdentities(selection.files, table, { keepRepoName: options['keep-repo-name'] === true })
  table.assertInjective()

  // 4-6. Redact, truncate, clip, and shift time by one constant offset.
  const capturedAt = Date.now()
  const clockAnchor = Date.parse(CASSETTE_CLOCK_ANCHOR)
  const newest = newestTimestamp(selection.files)
  const timeOffsetMs = clockAnchor - NEWEST_RECORD_LEAD_MS - newest
  const result = redact(selection.files, {
    source,
    table,
    limit,
    clipLimit,
    timeOffsetMs,
  })
  assertSlugsConsistent(result.files, result.directories)

  // The review summary comes before the write, not after it: this is the last
  // point at which something unexpected is cheap to catch.
  printReviewSummary({ id, table, result, selection })

  // 7. Scan for residue. Any hit aborts and writes nothing.
  const hits = scanChunks(
    result.files.flatMap(file => [...chunksForFile(source, file.cassettePath, file.content)]),
    secrets,
  )
  if (hits.length) {
    throw new Error(
      `Residue scan found ${hits.length} problem(s); nothing was written:\n`
      + `${formatResidueHits(hits)}\n\n`
      + 'Fix the capture (see docs/cassette-scenarios.md) or extend the redaction rules.',
    )
  }

  // 8. Write the manifest and the native file layout.
  const producerVersion = typeof options['producer-version'] === 'string'
    ? options['producer-version']
    : detectProducerVersion(selection.files) || 'unknown'

  const manifest = {
    schemaVersion: 1,
    id,
    source: [source],
    producer: {
      tool: SOURCES[source].producerTool,
      version: producerVersion,
      platform: platform(),
    },
    capturedAt: new Date(capturedAt).toISOString(),
    clockAnchor: new Date(clockAnchor).toISOString(),
    scenario,
    provenance: adhoc ? 'adhoc' : 'sandbox',
    notes: typeof options.notes === 'string' ? options.notes : '',
    e2e: options['skip-e2e'] !== true,
    browser: options['skip-browser'] !== true,
    redaction: {
      version: 1,
      rules: RULES_VERSION[source],
      identities: table.size,
      clippedValues: result.stats.clippedValues,
      droppedValues: result.stats.droppedValues,
    },
    truncation: {
      keptRecords: result.stats.keptRecords,
      droppedRecords: result.stats.droppedRecords,
      clipLimitBytes: clipLimit,
    },
    entries: result.files.map(file => ({
      path: file.cassettePath,
      bytes: Buffer.byteLength(file.content),
      records: file.records,
      mtime: file.mtime + Math.round(timeOffsetMs / 1_000),
      sha256: sha256(file.content),
    })),
    // Populated by the bless step below, which runs the real parsers rather
    // than guessing which lines they will reject.
    expectedParseIssues: [] as unknown[],
  }

  rmSync(directory, { recursive: true, force: true })
  mkdirSync(join(directory, 'files'), { recursive: true })
  for (const file of result.files) {
    const path = join(directory, 'files', file.cassettePath)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, file.content)
  }
  writeFileSync(join(directory, 'cassette.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  // The decode table, for a maintainer debugging a cassette locally. Gitignored
  // and asserted absent from the index by `pnpm cassette:verify`.
  writeFileSync(
    join(directory, '.identities.local.json'),
    `${JSON.stringify(
      { id, recordedAt: manifest.capturedAt, identities: table.entries() },
      null,
      2,
    )}\n`,
  )

  // 9. Bless, so a fresh cassette arrives with its expectations computed by the
  //    same code path the replay specs use.
  process.stderr.write('\nBlessing…\n')
  execFileSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--import', fileURLToPath(new URL('./ts-resolve.mjs', import.meta.url)),
      fileURLToPath(new URL('./bless.ts', import.meta.url)),
      '--id', id,
    ],
    { stdio: 'inherit', cwd: repositoryRoot },
  )

  process.stderr.write(
    `\nWrote test/cassettes/${id}\n`
    + `Review the diff, then run: pnpm cassette:verify && pnpm test:unit\n`
    + (adhoc
      ? '\nThis cassette is marked "provenance": "adhoc" and MUST NOT be committed.\n'
      : ''),
  )
})

function printReviewSummary(input: {
  id: string
  table: IdentityTable
  result: ReturnType<typeof redact>
  selection: ReturnType<typeof selectSession>
}): void {
  const { table, result } = input
  const lines: string[] = []

  lines.push(`Cassette ${input.id}`)
  lines.push('')
  lines.push(`Identity table (${table.size} entries, terminal only — never committed):`)
  lines.push(table.toReviewTable())
  lines.push('')
  lines.push('Files:')
  for (const file of result.files) {
    lines.push(`  ${file.cassettePath}  ${file.records} record(s), ${Buffer.byteLength(file.content)} bytes`)
  }
  lines.push('')
  lines.push(
    `Records kept ${result.stats.keptRecords}, dropped ${result.stats.droppedRecords}; `
    + `values clipped ${result.stats.clippedValues}, dropped ${result.stats.droppedValues}`,
  )

  if (result.stats.unclassified.size) {
    lines.push('')
    lines.push('Unclassified keys — scrubbed by default. Classify them in')
    lines.push('test/cassettes/redaction/rules.ts before committing this cassette:')
    for (const [key, count] of [...result.stats.unclassified].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
      lines.push(`  ${key} ×${count}`)
    }
  }

  lines.push('')
  lines.push('Longest free-text values — this is what you are about to commit:')
  for (const sample of result.stats.longestTexts) {
    lines.push(`  ${sample.length} bytes  ${sample.label}`)
    lines.push(`      ${sample.preview}`)
  }

  process.stderr.write(`${lines.join('\n')}\n\n`)
}
