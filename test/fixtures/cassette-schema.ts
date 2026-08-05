import { Schema } from 'effect'
import { NonNegativeInt } from '#shared/schemas/parse'
import { CASSETTE_SOURCES } from '../cassettes/redaction/rules'

/**
 * The `cassette.json` manifest.
 *
 * A cassette is external data consumed by tests — written by an operator tool,
 * read back by three replay tiers — so it is parsed with a Schema like any
 * other external data. It is not app-facing, which is why it lives beside the
 * loader rather than in `shared/schemas/`.
 *
 * Unlike the transcript schemas this one is *strict*: excess properties are a
 * hand-edit or a recorder/loader version skew, and a cassette that carries a
 * field nothing reads is a cassette whose expectations nobody has checked.
 */

/**
 * Excess properties fail rather than being stripped. A manifest key nothing
 * reads is a recorder/loader version skew or a hand-edit, and both are exactly
 * what this schema exists to catch.
 */
const STRICT = { onExcessProperty: 'error' } as const

export const CassetteSourceSchema = Schema.Literals(CASSETTE_SOURCES)
export type CassetteSource = typeof CassetteSourceSchema.Type

/** How a cassette's session was produced; only `sandbox` may be committed. */
export const CassetteProvenanceSchema = Schema.Literals(['sandbox', 'adhoc'])

export const CassetteProducerSchema = Schema.Struct({
  /** `claude-code`, `codex-cli`, `copilot-cli`, `vscode-copilot-chat`. */
  tool: Schema.NonEmptyString,
  /** The producing tool's own version string, or `unknown` when it wrote none. */
  version: Schema.NonEmptyString,
  /** `process.platform` of the capture machine; see spec §14 on Windows. */
  platform: Schema.NonEmptyString,
})

export type CassetteProducer = typeof CassetteProducerSchema.Type

export const CassetteRedactionSchema = Schema.Struct({
  version: NonNegativeInt,
  /** The `rules.ts` table version this cassette was produced under, e.g. `claude@1`. */
  rules: Schema.NonEmptyString,
  identities: NonNegativeInt,
  clippedValues: NonNegativeInt,
  droppedValues: NonNegativeInt,
})

export const CassetteTruncationSchema = Schema.Struct({
  keptRecords: NonNegativeInt,
  droppedRecords: NonNegativeInt,
  clipLimitBytes: NonNegativeInt,
})

export const CassetteEntrySchema = Schema.Struct({
  /** Path below `files/`, always POSIX-separated. */
  path: Schema.NonEmptyString,
  bytes: NonNegativeInt,
  records: NonNegativeInt,
  /**
   * Seconds since epoch, fed straight into `FakeEntry.mtime`. Real mtimes are
   * preserved under the cassette-wide time shift so freshness filtering is
   * exercised rather than bypassed.
   */
  mtime: NonNegativeInt,
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
})

export type CassetteEntry = typeof CassetteEntrySchema.Type

/**
 * The only sanctioned way a cassette may contain unparseable records.
 *
 * Each must be enumerated with a human reason, and L1 fails both on an
 * unlisted issue and on a listed one that now decodes — a stale allowance
 * means the schema was widened and nobody removed the note.
 */
export const ExpectedParseIssueSchema = Schema.Struct({
  path: Schema.NonEmptyString,
  line: NonNegativeInt,
  kind: Schema.Literals(['invalid-json', 'schema-mismatch', 'unsupported-shape']),
  reason: Schema.NonEmptyString,
})

export type ExpectedParseIssue = typeof ExpectedParseIssueSchema.Type

export const CassetteManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  /** `<source>/<scenario>`, matching the directory path. */
  id: Schema.NonEmptyString,
  /** More than one when a scenario spans tools. */
  source: Schema.Array(CassetteSourceSchema).check(Schema.isMinLength(1)),
  producer: CassetteProducerSchema,
  capturedAt: Schema.NonEmptyString,
  /**
   * The instant tests pin `TestClock` to. Every derived value that depends on
   * "now" — `LIVE_WINDOW`, `statsNow`, `ago`, freshness cutoffs — becomes
   * deterministic against it; without one, `expected/scan.json` cannot be
   * stable.
   */
  clockAnchor: Schema.NonEmptyString,
  scenario: Schema.NonEmptyString,
  provenance: CassetteProvenanceSchema,
  notes: Schema.String,
  /** Whether the slow L3 tier replays this cassette. One per source suffices. */
  e2e: Schema.Boolean,
  /** Whether the Playwright tiers materialize this cassette into their root. */
  browser: Schema.Boolean,
  redaction: CassetteRedactionSchema,
  truncation: CassetteTruncationSchema,
  entries: Schema.Array(CassetteEntrySchema).check(Schema.isMinLength(1)),
  expectedParseIssues: Schema.Array(ExpectedParseIssueSchema),
})

export type CassetteManifest = typeof CassetteManifestSchema.Type

/**
 * Throwing rather than returning a `Result`: every caller is a test or an
 * operator script, and a manifest that does not decode is a broken cassette
 * with no useful degraded behavior.
 */
export const decodeCassetteManifest = Schema.decodeUnknownSync(CassetteManifestSchema, STRICT)

/** The per-file parse census committed as `expected/parse.json`. */
export const ParseCensusSchema = Schema.Struct({
  byFile: Schema.Record(Schema.String, Schema.Struct({
    records: NonNegativeInt,
    'invalid-json': NonNegativeInt,
    'schema-mismatch': NonNegativeInt,
    'unsupported-shape': NonNegativeInt,
  })),
})

export type ParseCensus = typeof ParseCensusSchema.Type

export const decodeParseCensus = Schema.decodeUnknownSync(ParseCensusSchema, STRICT)
