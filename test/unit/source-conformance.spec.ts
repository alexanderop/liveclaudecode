import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import type * as Layer from 'effect/Layer'
import type * as FileSystem from 'effect/FileSystem'
import type * as PlatformError from 'effect/PlatformError'
import { TranscriptScan } from '#server/utils/transcript'
import { CodexTranscriptScan } from '#server/utils/codex-transcript'
import { CopilotTranscriptScan } from '#server/utils/copilot-transcript'
import { CopilotCliTranscriptScan } from '#server/utils/copilot-cli-transcript'
import type { FileDiscoveryLimiter } from '#server/utils/filesystem-concurrency'
import type {
  ParseIssue,
  SessionParseSummary,
  TranscriptStats,
  TurnTiming,
} from '#shared/types/run'
import * as claude from '../fixtures/transcripts'
import * as codex from '../fixtures/codex'
import * as copilot from '../fixtures/copilot'
import * as copilotCli from '../fixtures/copilot-cli'
import { testFileSystem } from '../fixtures/filesystem'

/**
 * One behavior table for all four transcript formats.
 *
 * The per-source specs (`transcript.spec.ts`, `codex-transcript.spec.ts`,
 * `copilot-transcript.spec.ts`, `copilot-cli-transcript.spec.ts`) cover what is
 * unique to each format in depth. This file covers what they are all supposed
 * to implement, so a behavior added for one source cannot silently miss the
 * others: adding a format means adding one entry to `SOURCES`, not writing a
 * new file and hoping someone remembers.
 *
 * Where a source genuinely cannot satisfy a behavior, it says so as data — see
 * `turnTimings` — and the table asserts the documented absence rather than
 * quietly omitting the case.
 */

const WORKSPACE = '/repo'
const EDITED = `${WORKSPACE}/src/app.ts`
/** The display path every source is expected to reduce `EDITED` to. */
const EDITED_DISPLAY = 'src/app.ts'
const PROMPT = 'Fix the integration'

/** The slice of a scan this table exercises; all four classes satisfy it. */
interface ConformanceScan {
  readonly refresh: () => Effect.Effect<
    unknown,
    PlatformError.PlatformError,
    FileSystem.FileSystem
  >
  readonly statsAt: (now: number) => TranscriptStats
  readonly diagnostics: () => { readonly turns: ReadonlyArray<TurnTiming> }
  readonly parseIssues: {
    readonly summary: SessionParseSummary
    readonly samples: ReadonlyArray<ParseIssue>
  }
}

interface SourceFixture {
  readonly scan: ConformanceScan
  readonly layer: Layer.Layer<FileSystem.FileSystem | FileDiscoveryLimiter>
  /** The label this source shows for the session, read the way the app reads it. */
  readonly label: () => string
}

interface SourceCase {
  readonly source: 'claude' | 'codex' | 'copilot' | 'copilot-cli'
  /** A well-formed transcript exercising every behavior below. */
  readonly clean: () => SourceFixture
  /** The same transcript with one unreadable record appended. */
  readonly corrupted: () => SourceFixture
  /**
   * `'emitted'` when the format records per-turn timings, otherwise the reason
   * it cannot — asserted as an absence rather than skipped.
   */
  readonly turnTimings: 'emitted' | { readonly unsupported: string }
}

// --- claude -----------------------------------------------------------------

const CLAUDE_PATH = '/claude/projects/repo/session.jsonl'

const claudeRecords = [
  claude.userText(PROMPT),
  claude.assistant([
    claude.text('On it'),
    claude.tool('Edit', 'edit-1', { file_path: EDITED }),
  ], { usage: { output_tokens: 11 } }),
  claude.userResult('edit-1', 'ok'),
  claude.system('turn_duration', { durationMs: 4_000, messageCount: 2 }),
]

function claudeFixture(content: string): SourceFixture {
  const scan = new TranscriptScan(CLAUDE_PATH)
  return {
    scan,
    layer: testFileSystem({ [CLAUDE_PATH]: { content, mtime: 100 } }),
    // `runs.ts` labels a Claude session by its harness title when there is one
    // and by the opening prompt otherwise.
    label: () => scan.customTitle
      || scan.aiTitle
      || scan.events.find(event => event.kind === 'prompt')?.body
      || '',
  }
}

// --- codex ------------------------------------------------------------------

const CODEX_PATH = '/codex/sessions/2026/07/26/rollout-2026-07-26T08-00-00-session-1.jsonl'

const codexRecords = [
  codex.sessionMeta('session-1', { cwd: WORKSPACE }),
  codex.turnContext({ cwd: WORKSPACE }),
  codex.message('user', PROMPT),
  codex.event('patch_apply_end', {
    call_id: 'patch-1',
    success: true,
    changes: { [EDITED]: { kind: 'update' } },
  }, codex.C0(5)),
  codex.event('token_count', {
    info: { total_token_usage: { input_tokens: 30, cached_input_tokens: 10, output_tokens: 12 } },
  }, codex.C0(6)),
  codex.event('task_complete', {}, codex.C0(7)),
]

function codexFixture(content: string): SourceFixture {
  const scan = new CodexTranscriptScan(CODEX_PATH)
  return {
    scan,
    layer: testFileSystem({ [CODEX_PATH]: { content, mtime: 100 } }),
    label: () => scan.firstPrompt,
  }
}

// --- copilot (VS Code) ------------------------------------------------------

const COPILOT_PATH = '/vscode/chatSessions/copilot.jsonl'

const copilotSnapshot = copilot.snapshot({
  id: 'copilot-session',
  requests: [copilot.request('request-1', PROMPT, {
    mode: 'agent',
    elapsedMs: 2_500,
    promptTokens: 11,
    response: [
      copilot.textEdit(EDITED),
      copilot.markdown('Done.'),
    ],
  })],
})

function copilotFixture(content: string): SourceFixture {
  const scan = new CopilotTranscriptScan(COPILOT_PATH, 'VS Code', WORKSPACE)
  return {
    scan,
    layer: testFileSystem({ [COPILOT_PATH]: { content, mtime: 100 } }),
    label: () => scan.title,
  }
}

// --- copilot cli ------------------------------------------------------------

const COPILOT_CLI_PATH = '/home/test/.copilot/session-state/session-1/events.jsonl'

const copilotCliRecords = [
  copilotCli.sessionStart(),
  copilotCli.modelChange(),
  copilotCli.userMessage(PROMPT),
  copilotCli.turnStart(),
  copilotCli.assistantMessage({
    toolRequests: [copilotCli.toolRequest('edit', 'edit-1', { path: EDITED, old_str: 'a', new_str: 'b' })],
  }),
  copilotCli.toolStart('edit', 'edit-1', { path: EDITED }, 6),
  copilotCli.toolComplete('edit-1', { success: true, content: 'updated', second: 6 }),
  copilotCli.turnEnd('turn-1', 7),
]

function copilotCliFixture(content: string): SourceFixture {
  const scan = new CopilotCliTranscriptScan(COPILOT_CLI_PATH, 'GitHub Copilot CLI', WORKSPACE)
  return {
    scan,
    layer: testFileSystem({ [COPILOT_CLI_PATH]: { content, mtime: 100 } }),
    label: () => scan.title,
  }
}

// --- the table --------------------------------------------------------------

const SOURCES: ReadonlyArray<SourceCase> = [
  {
    source: 'claude',
    clean: () => claudeFixture(claude.transcript(claudeRecords)),
    corrupted: () => claudeFixture(`${claude.transcript(claudeRecords)}{bad json\n`),
    turnTimings: 'emitted',
  },
  {
    source: 'codex',
    clean: () => codexFixture(codex.rollout(codexRecords)),
    corrupted: () => codexFixture(codex.rollout(codexRecords, { malformed: true })),
    turnTimings: {
      unsupported: 'Codex rollouts carry no per-turn duration, so '
        + 'CodexTranscriptScan.diagnostics() reports an empty turns list',
    },
  },
  {
    source: 'copilot',
    clean: () => copilotFixture(copilot.log([copilot.initial(copilotSnapshot)])),
    corrupted: () => copilotFixture(
      copilot.log([copilot.initial(copilotSnapshot)], { malformed: true }),
    ),
    turnTimings: 'emitted',
  },
  {
    source: 'copilot-cli',
    clean: () => copilotCliFixture(copilotCli.jsonl(copilotCliRecords)),
    corrupted: () => copilotCliFixture(copilotCli.jsonl(copilotCliRecords, { malformed: true })),
    turnTimings: 'emitted',
  },
]

/** Refresh a fixture's scan against its own in-memory filesystem. */
const scanned = (fixture: SourceFixture) =>
  fixture.scan.refresh().pipe(Effect.provide(fixture.layer))

describe('transcript source conformance', () => {
  it.effect.each(SOURCES)('$source reports a session label', ({ clean }) =>
    Effect.gen(function*() {
      const fixture = clean()
      yield* scanned(fixture)
      assert.strictEqual(fixture.label(), PROMPT)
    }))

  it.effect.each(SOURCES)('$source aggregates file changes by short display path', ({ clean }) =>
    Effect.gen(function*() {
      const fixture = clean()
      yield* scanned(fixture)
      assert.deepStrictEqual(
        fixture.scan.statsAt(1_000).files.map(file => file.path),
        [EDITED_DISPLAY],
      )
    }))

  it.effect.each(SOURCES)('$source produces a cost sample when usage is present', ({ clean }) =>
    Effect.gen(function*() {
      const fixture = clean()
      yield* scanned(fixture)
      assert.isAbove(
        fixture.scan.statsAt(1_000).tokensOut,
        0,
        'a turn that produced output must report output tokens',
      )
    }))

  it.effect.each(SOURCES)('$source reports zero parse issues on a clean transcript', ({ clean }) =>
    Effect.gen(function*() {
      const fixture = clean()
      yield* scanned(fixture)
      assert.deepStrictEqual(fixture.scan.parseIssues.summary.counts, {
        invalidJson: 0,
        schemaMismatch: 0,
        unsupportedShape: 0,
      })
      assert.strictEqual(fixture.scan.parseIssues.summary.skipped, 0)
    }))

  it.effect.each(SOURCES)('$source counts a malformed record into the parse census', ({ corrupted }) =>
    Effect.gen(function*() {
      const fixture = corrupted()
      yield* scanned(fixture)
      const summary = fixture.scan.parseIssues.summary
      assert.strictEqual(summary.skipped, 1)
      assert.strictEqual(summary.counts.invalidJson, 1)
      assert.strictEqual(fixture.scan.parseIssues.samples[0]?.reason, 'invalid-json')
    }))

  it.effect.each(SOURCES)('$source emits turn timings, or documents why it cannot', ({ clean, turnTimings }) =>
    Effect.gen(function*() {
      const fixture = clean()
      yield* scanned(fixture)
      const turns = fixture.scan.diagnostics().turns

      if (turnTimings === 'emitted') {
        assert.isAbove(turns.length, 0, 'expected at least one turn timing')
        assert.isAbove(turns[0]!.durationMs, 0, 'a turn timing must carry a duration')
        return
      }

      assert.deepStrictEqual(turns, [], turnTimings.unsupported)
    }))
})
