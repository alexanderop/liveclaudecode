/**
 * The canonical projections a cassette is judged by.
 *
 * One implementation, three consumers: `cassette-conformance.spec.ts` (L1),
 * `cassette-scan.spec.ts` (L2), and `script/cassette/bless.ts`. Sharing it is
 * the point — a blessed file computed by a second implementation could
 * disagree with what the test computes, and the disagreement would look like a
 * product regression.
 *
 * Both projections are deliberately narrower than the objects they come from.
 * A serialization of the whole scan would turn every internal refactor into a
 * four-hundred-line diff, which trains reviewers to skim exactly the file they
 * are supposed to read.
 */
import { Effect } from 'effect'
import type * as FileSystem from 'effect/FileSystem'
import type * as PlatformError from 'effect/PlatformError'
import type { ParseIssueLog } from '#server/utils/parse-issues'
import { CodexTranscriptScan } from '#server/utils/codex-transcript'
import { CopilotCliTranscriptScan } from '#server/utils/copilot-cli-transcript'
import { CopilotTranscriptScan } from '#server/utils/copilot-transcript'
import { TranscriptScan } from '#server/utils/transcript'
import { parseClaudeRecord } from '#shared/schemas/claude'
import { parseCodexRecord } from '#shared/schemas/codex'
import { parseCopilotCliEvent } from '#shared/schemas/copilot-cli'
import { parseCopilotLogRecord } from '#shared/schemas/copilot'
import type { ParseIssueReason } from '#shared/types/run'
import { SOURCES } from '../../script/cassette/sources.ts'
import { CASSETTE_SOURCES, type CassetteSource } from '../cassettes/redaction/rules'
import type { Cassette } from './cassette'
import type { ParseCensus } from './cassette-schema'

// -- Level 1: schema conformance --------------------------------------------

/**
 * The census, taken from the schema that decodes the committed file rather
 * than restated: `cassette-conformance.spec.ts` compares one against the
 * other, and a field added to only one side would fail there as an unrelated
 * decode error.
 */
type FileCensus = { -readonly [K in keyof ParseCensus['byFile'][string]]: number }

export interface ObservedParseIssue {
  readonly path: string
  readonly line: number
  readonly kind: ParseIssueReason
  readonly detail: string
}

export interface ConformanceResult {
  readonly census: ParseCensus
  readonly issues: readonly ObservedParseIssue[]
}

/** Whether a cassette entry is a line-record transcript rather than a sidecar. */
export function isTranscript(path: string): boolean {
  return path.endsWith('.jsonl')
}

/** What the four parsers agree on, which is all this file needs from them. */
type ParseOutcome =
  | { readonly success: true }
  | { readonly success: false, readonly error: { readonly message: string } }

/**
 * Each source's own parser.
 *
 * Deliberately the *parser*, not the scanner: L1 is the format-drift alarm and
 * has to stay cheap enough to run over the whole corpus on every unit run. An
 * unrecognised record `type` is not a failure — every parser here surfaces
 * those as `unknown` on purpose, because the tools add record kinds over time
 * and the dashboard must not break when they do.
 */
const PARSERS: Readonly<Record<CassetteSource, (value: unknown) => ParseOutcome>> = {
  'claude': parseClaudeRecord,
  'codex': parseCodexRecord,
  'copilot': parseCopilotLogRecord,
  'copilot-cli': parseCopilotCliEvent,
}

function decodeRecord(source: CassetteSource, value: unknown): { ok: boolean, detail: string } {
  const parsed = PARSERS[source](value)
  return parsed.success ? { ok: true, detail: '' } : { ok: false, detail: parsed.error.message }
}

/**
 * The source a given file belongs to.
 *
 * A cassette may populate more than one subtree, so the source cannot be read
 * off the manifest alone — it comes from which subtree the file sits in. The
 * mapping is inverted from the source descriptors rather than restated, so a
 * renamed subtree cannot mean one thing to the recorder and another here.
 */
export function sourceForPath(path: string): CassetteSource {
  const source = CASSETTE_SOURCES.find(candidate =>
    path.startsWith(`${SOURCES[candidate].subtree}/`),
  )
  if (!source) throw new Error(`Cassette path ${path} is not under a known source subtree`)
  return source
}

export function projectConformance(cassette: Cassette): ConformanceResult {
  const byFile: Record<string, FileCensus> = {}
  const issues: ObservedParseIssue[] = []

  for (const path of [...cassette.files.keys()].sort()) {
    if (!isTranscript(path)) continue
    const source = sourceForPath(path)
    const census: FileCensus = {
      records: 0,
      'invalid-json': 0,
      'schema-mismatch': 0,
      'unsupported-shape': 0,
    }

    const lines = cassette.files.get(path)!.split('\n')
    for (const [line, raw] of lines.entries()) {
      if (!raw.trim()) continue
      census.records += 1
      let value: unknown
      try {
        value = JSON.parse(raw)
      } catch (error) {
        census['invalid-json'] += 1
        issues.push({
          path,
          line,
          kind: 'invalid-json',
          detail: error instanceof Error ? error.message : String(error),
        })
        continue
      }
      const decoded = decodeRecord(source, value)
      if (!decoded.ok) {
        census['schema-mismatch'] += 1
        issues.push({ path, line, kind: 'schema-mismatch', detail: decoded.detail })
      }
    }

    byFile[path] = census
  }

  return { census: { byFile }, issues }
}

// -- Level 2: scanner golden ------------------------------------------------

export interface ScanProjection {
  readonly path: string
  readonly records: number
  readonly size: number
  /** Tool-use counts, keys sorted — map order is insertion order and a refactor should not diff. */
  readonly counts: Record<string, number>
  readonly tools: number
  readonly reads: number
  readonly errors: number
  readonly malformed: number
  readonly parseIssues: { readonly total: number, readonly byKind: Record<string, number> }
  readonly firstTs: string
  readonly lastTs: string
  readonly tokensOut: number
  readonly live: boolean
  readonly agoMs: number
  readonly environment: Record<string, string>
  readonly titles: { readonly display: string, readonly ai: string, readonly custom: string }
  readonly files: ReadonlyArray<{ path: string, ops: number, tools: readonly string[] }>
  readonly commands: ReadonlyArray<{ cmd: string, ok: boolean | null }>
  readonly milestones: ReadonlyArray<{ title: string, ts: string, strong: boolean }>
  readonly incidents: ReadonlyArray<{ id: string, category: string, severity: string, tool: string }>
  readonly turns: ReadonlyArray<{ index: number, durationMs: number, messageCount: number }>
  readonly context: ReadonlyArray<{
    ts: string
    model: string
    in: number
    out: number
    cr: number
    cw: number
    stopReason: string | null
  }>
  readonly compactions: number
  readonly skills: readonly string[]
  readonly outcomes: ReadonlyArray<{ toolUseId: string, status: string, childKey: string }>
  readonly todos: ReadonlyArray<{ content: string, status: string }>
  readonly current: { tool: string, summary: string } | null
  readonly finalText: string
  readonly budget: { usedUsd: number, totalUsd: number } | null
  readonly causal: Record<string, number>
}

export interface CassetteScanProjection {
  readonly files: readonly ScanProjection[]
}

/**
 * The four production scanners, as a union rather than a structural interface.
 *
 * A hand-written interface plus a cast would compile against a scanner that had
 * quietly changed shape, which is exactly the drift this file exists to catch.
 * The union costs three `in` checks below and nothing else.
 */
type ProjectableScan =
  | TranscriptScan
  | CodexTranscriptScan
  | CopilotTranscriptScan
  | CopilotCliTranscriptScan

/** Title fields only some scanners record; absent is '' rather than an error. */
function titleOf(scan: ProjectableScan, key: 'title' | 'aiTitle' | 'customTitle'): string {
  return key in scan ? (scan[key as keyof ProjectableScan] as string) ?? '' : ''
}

/**
 * Build the scanner a given cassette file would be read by in production.
 *
 * `copilot-runs.ts` supplies the application and workspace labels from the
 * surrounding directory; here they are fixed, because the cassette's own
 * `workspace.json` is what L3 exercises and L2 is asserting the scanner, not
 * the discovery walk.
 */
type RefreshedScan = Effect.Effect<
  ProjectableScan,
  PlatformError.PlatformError,
  FileSystem.FileSystem
>

/**
 * Each entry builds *and refreshes* its own concrete scanner rather than
 * returning one for a shared `refresh()` call. `refresh` is declared with an
 * explicit `this`, and the four scanners have private members that do not
 * unify, so calling it on the union is not expressible — each closure keeping
 * its own type is the honest way there rather than a cast.
 */
const SCANNERS: Readonly<Record<CassetteSource, (path: string) => RefreshedScan>> = {
  'claude': (path) => {
    const scan = new TranscriptScan(path)
    return Effect.as(scan.refresh(), scan)
  },
  'codex': (path) => {
    const scan = new CodexTranscriptScan(path)
    return Effect.as(scan.refresh(), scan)
  },
  'copilot': (path) => {
    const scan = new CopilotTranscriptScan(path, 'VS Code', '')
    return Effect.as(scan.refresh(), scan)
  },
  'copilot-cli': (path) => {
    const scan = new CopilotCliTranscriptScan(path, 'Copilot CLI', '')
    return Effect.as(scan.refresh(), scan)
  },
}

function sortedCounts(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)))
}

function issueCounts(log: ParseIssueLog): Record<string, number> {
  const { invalidJson, schemaMismatch, unsupportedShape } = log.counts
  return {
    'invalid-json': invalidJson,
    'schema-mismatch': schemaMismatch,
    'unsupported-shape': unsupportedShape,
  }
}

export function projectScan(
  scan: ProjectableScan,
  path: string,
  now: number,
): ScanProjection {
  const stats = scan.statsAt(now)
  const diagnostics = scan.diagnostics()
  const environment = diagnostics.environment

  return {
    path,
    records: stats.records,
    size: stats.size,
    counts: sortedCounts(stats.toolCounts),
    tools: stats.tools,
    reads: stats.reads,
    errors: stats.errors,
    malformed: scan.parseIssues.skipped,
    parseIssues: { total: scan.parseIssues.skipped, byKind: issueCounts(scan.parseIssues) },
    firstTs: stats.firstTs ?? '',
    lastTs: stats.lastTs ?? '',
    tokensOut: stats.tokensOut,
    live: stats.live,
    agoMs: stats.ago,
    environment: {
      cwd: environment.cwd,
      gitBranch: environment.gitBranch,
      version: environment.version,
      entrypoint: environment.entrypoint,
      permissionMode: environment.permissionMode,
      mode: environment.mode,
    },
    titles: {
      display: titleOf(scan, 'title'),
      ai: titleOf(scan, 'aiTitle'),
      custom: titleOf(scan, 'customTitle'),
    },
    // Sorted: the file map's iteration order is ingest order, and a change to
    // ingest order is not a change to what the dashboard shows.
    files: stats.files
      .map(file => ({ path: file.path, ops: file.ops, tools: [...file.tools].sort() }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    // Order preserved: for commands, milestones, turns, and context samples the
    // order *is* the assertion.
    commands: stats.commands.map(command => ({ cmd: command.cmd, ok: command.ok })),
    milestones: stats.milestones.map(milestone => ({
      title: milestone.title,
      ts: milestone.ts ?? '',
      strong: milestone.strong,
    })),
    incidents: diagnostics.incidents.map(incident => ({
      id: incident.id,
      category: incident.category,
      severity: incident.severity,
      tool: incident.tool ?? '',
    })),
    turns: diagnostics.turns.map((turn, index) => ({
      index,
      durationMs: turn.durationMs,
      messageCount: turn.messageCount,
    })),
    context: diagnostics.context.map(sample => ({
      ts: sample.ts ?? '',
      model: sample.model,
      in: sample.usage.in,
      out: sample.usage.out,
      cr: sample.usage.cr,
      cw: sample.usage.cw,
      stopReason: sample.stopReason,
    })),
    compactions: diagnostics.compactions.length,
    skills: stats.skills.map(skill => skill.skill).sort(),
    outcomes: diagnostics.outcomes.map(outcome => ({
      toolUseId: outcome.toolUseId,
      status: outcome.status,
      childKey: outcome.childKey ?? '',
    })),
    todos: (stats.todos ?? []).map(todo => ({
      content: todo.content ?? '',
      status: todo.status,
    })),
    current: stats.current ? { tool: stats.current.tool, summary: stats.current.summary } : null,
    // A bounded prefix: the value is knowing that the final text survived the
    // pipeline, not re-committing it a second time.
    finalText: stats.finalText.slice(0, 200),
    budget: diagnostics.budget
      ? { usedUsd: diagnostics.budget.usedUsd, totalUsd: diagnostics.budget.totalUsd }
      : null,
    causal: { ...diagnostics.causal },
  }
}

/**
 * Run every transcript in a cassette through its production scanner and project
 * the result.
 *
 * `statsAt(clockAnchor)` rather than `stats`: `statsNow` is the only clock read
 * in the scan path, and passing the anchor explicitly makes the projection
 * deterministic without the caller having to own a `TestClock`. The specs pin
 * `TestClock` anyway, so a future clock read cannot silently un-fix it.
 */
export const projectCassetteScan = Effect.fn('projectCassetteScan')(function*(
  cassette: Cassette,
) {
  const files: ScanProjection[] = []

  for (const path of [...cassette.files.keys()].sort()) {
    if (!isTranscript(path)) continue
    const scan = yield* SCANNERS[sourceForPath(path)](`${cassette.memoryBase}/${path}`)
    files.push(projectScan(scan, path, cassette.clockAnchor))
  }

  return { files } satisfies CassetteScanProjection
})

/** Stable JSON for a blessed file: sorted where order is not semantic, newline-terminated. */
export function blessedJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}
