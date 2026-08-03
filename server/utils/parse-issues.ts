import { Formatter, Predicate, type Schema } from 'effect'
import type {
  ParseIssue,
  ParseIssueCounts,
  ParseIssueReason,
  SessionParseSummary,
} from '#shared/types/run'

/**
 * Per-scan record of *why* records were skipped, alongside the count the
 * scanners already kept.
 *
 * A bare count cannot be acted on: "30 malformed records skipped" reads as a
 * data problem even when the real cause is a schema this repository has not
 * caught up with. The scanners already have the file, the line, and the decode
 * failure at the point they skip — this keeps a bounded sample of that instead
 * of dropping it into a debug log nobody reads.
 *
 * Bounded on purpose. A transcript whose format we mis-model can fail on every
 * one of tens of thousands of lines, and these logs live for as long as the
 * scan cache does; the first few samples identify the shape, and the counts
 * carry the scale.
 */
export const PARSE_ISSUE_SAMPLE_LIMIT = 8

/** Excerpts are for recognising a record's shape, not for reading its content. */
const EXCERPT_LENGTH = 240

/** Detail strings are one-liners in a table cell; decode errors can be long. */
const DETAIL_LENGTH = 200

export function emptyParseIssueCounts(): ParseIssueCounts {
  return { invalidJson: 0, schemaMismatch: 0, unsupportedShape: 0 }
}

const COUNT_KEY: Record<ParseIssueReason, keyof ParseIssueCounts> = {
  'invalid-json': 'invalidJson',
  'schema-mismatch': 'schemaMismatch',
  'unsupported-shape': 'unsupportedShape',
}

export function totalParseIssues(counts: ParseIssueCounts): number {
  return counts.invalidJson + counts.schemaMismatch + counts.unsupportedShape
}

/** Add `source`'s parse counters into `target`, in place. */
export function addParseIssueCounts(target: ParseIssueCounts, source: ParseIssueCounts): void {
  target.invalidJson += source.invalidJson
  target.schemaMismatch += source.schemaMismatch
  target.unsupportedShape += source.unsupportedShape
}

export function emptyParseSummary(): SessionParseSummary {
  return { skipped: 0, counts: emptyParseIssueCounts() }
}

function truncate(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed
}

/**
 * A record's discriminator, when it has one. Claude and Codex key on `type`,
 * Copilot CLI on `kind`; a record missing both is reported without a type
 * rather than guessed at.
 */
export function recordTypeOf(value: unknown): string {
  if (!Predicate.isReadonlyObject(value)) return ''
  const discriminator = value.type ?? value.kind
  return typeof discriminator === 'string' ? discriminator : ''
}

/**
 * `Formatter.format` rather than `JSON.stringify`: it survives circular
 * references and redacts `Redactable` values, and an excerpt of a record we
 * failed to model is exactly the case where the shape is unknown.
 */
export function excerptOf(value: unknown): string {
  return truncate(typeof value === 'string' ? value : Formatter.format(value), EXCERPT_LENGTH)
}

/**
 * `SchemaError.message` renders the issue with its path — e.g.
 * `Missing key\n  at ["message"]["content"]` — which is the single most useful
 * thing to show, so it is collapsed to one line rather than picked apart.
 */
export function schemaErrorDetail(error: Schema.SchemaError): string {
  return truncate(error.message, DETAIL_LENGTH) || 'Record did not match the expected shape'
}

/** The message of a thrown `JSON.parse` failure, for `invalid-json` issues. */
export function jsonErrorDetail(error: unknown): string {
  return truncate(error instanceof Error ? error.message : String(error), DETAIL_LENGTH)
    || 'Line was not valid JSON'
}

/**
 * Issue constructors, for scanners that rebuild their whole issue set on each
 * refresh and so collect issues into an array rather than recording them one
 * at a time.
 */

/** A line that failed `JSON.parse`. */
export function invalidJsonIssue(line: number, raw: string, error: unknown): ParseIssue {
  return {
    reason: 'invalid-json',
    line,
    recordType: '',
    detail: jsonErrorDetail(error),
    excerpt: excerptOf(raw),
  }
}

/** A record that parsed as JSON but failed its schema. */
export function schemaMismatchIssue(
  line: number,
  value: unknown,
  error: Schema.SchemaError,
): ParseIssue {
  return {
    reason: 'schema-mismatch',
    line,
    recordType: recordTypeOf(value),
    detail: schemaErrorDetail(error),
    excerpt: excerptOf(value),
  }
}

/**
 * A record we can read but cannot model. `recordType` may be given explicitly
 * for a failure inside a record, where the useful label (a tool name, say) is
 * not on the offending value itself.
 */
export function unsupportedShapeIssue(
  line: number,
  value: unknown,
  detail: string,
  recordType = '',
): ParseIssue {
  return {
    reason: 'unsupported-shape',
    line,
    recordType: recordType || recordTypeOf(value),
    detail: truncate(detail, DETAIL_LENGTH),
    excerpt: excerptOf(value),
  }
}

/**
 * A scan's skipped-record log. Counts every issue; retains the first
 * `PARSE_ISSUE_SAMPLE_LIMIT` of them.
 *
 * Two buckets, because the scanners produce issues two ways. Lines are
 * consumed once and never revisited, so line-level issues accumulate. The
 * Copilot scanners instead re-derive their session state from the whole replay
 * on each refresh, so the issues that fall out of *that* are replaced wholesale
 * — accumulating them would multiply one bad record by the poll count.
 */
export class ParseIssueLog {
  private readonly incremental: ParseIssueCounts = emptyParseIssueCounts()
  private readonly derived: ParseIssueCounts = emptyParseIssueCounts()
  private readonly incrementalSamples: ParseIssue[] = []
  private derivedSamples: ParseIssue[] = []

  get counts(): ParseIssueCounts {
    const total = { ...this.incremental }
    addParseIssueCounts(total, this.derived)
    return total
  }

  get skipped(): number {
    return totalParseIssues(this.incremental) + totalParseIssues(this.derived)
  }

  get samples(): ReadonlyArray<ParseIssue> {
    return [...this.incrementalSamples, ...this.derivedSamples]
      .slice(0, PARSE_ISSUE_SAMPLE_LIMIT)
  }

  get summary(): SessionParseSummary {
    return { skipped: this.skipped, counts: this.counts }
  }

  record(issue: ParseIssue): void {
    this.incremental[COUNT_KEY[issue.reason]] += 1
    if (this.incrementalSamples.length < PARSE_ISSUE_SAMPLE_LIMIT) this.incrementalSamples.push(issue)
  }

  /**
   * Replace the issues derived from a full rebuild. Callers pass everything
   * their latest rebuild found; anything from the previous one is discarded.
   */
  replaceDerived(issues: ReadonlyArray<ParseIssue>): void {
    this.derived.invalidJson = 0
    this.derived.schemaMismatch = 0
    this.derived.unsupportedShape = 0
    for (const issue of issues) this.derived[COUNT_KEY[issue.reason]] += 1
    this.derivedSamples = issues.slice(0, PARSE_ISSUE_SAMPLE_LIMIT)
  }

  /** Record a line that failed `JSON.parse`. */
  recordInvalidJson(line: number, raw: string, error: unknown): void {
    this.record(invalidJsonIssue(line, raw, error))
  }

  /** Record a record that parsed as JSON but failed its schema. */
  recordSchemaMismatch(line: number, value: unknown, error: Schema.SchemaError): void {
    this.record(schemaMismatchIssue(line, value, error))
  }

  /** Record a record we can decode but cannot safely apply. */
  recordUnsupportedShape(line: number, value: unknown, detail: string, recordType = ''): void {
    this.record(unsupportedShapeIssue(line, value, detail, recordType))
  }

  /** Drop everything, for a scanner that rewound to re-read a rewritten file. */
  reset(): void {
    this.incremental.invalidJson = 0
    this.incremental.schemaMismatch = 0
    this.incremental.unsupportedShape = 0
    this.incrementalSamples.length = 0
    this.replaceDerived([])
  }
}
