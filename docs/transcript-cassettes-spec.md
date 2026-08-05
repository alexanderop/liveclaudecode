# Transcript Cassettes

## Engineering specification

**Status:** Proposal, not started
**Product:** liveclaudecode
**Audience:** Backend / test engineering
**Scope:** Replace synthetic transcript fixtures as the primary source of
truth for parser and scanner tests with recorded, redacted sessions captured
from the real tools; add record/replay for the ACP agent boundary
**Prior art:** `@opencode-ai/http-recorder` and the golden scenario matrix in
`anomalyco/opencode`

## 1. Summary

Every transcript test in this repository today asserts against records that
this repository wrote. `test/fixtures/transcripts.ts` builds a Claude record
as `{ type: 'assistant', message: { content, model: 'claude-opus-5' } }`,
`test/fixtures/codex.ts` builds a rollout line, and so on for Copilot and
Copilot CLI. Those fixtures encode *our belief* about each format. They cannot
detect the failure mode this product is most exposed to: a vendor changes the
shape of a field and the dashboard silently degrades — a tool disappears from
the run tree, a cost column reads zero, a milestone stops firing — with a
green test suite.

opencode solved the equivalent problem for LLM providers by recording real
HTTP traffic once into JSON cassettes and replaying it deterministically. The
same idea transfers here with the transport swapped: our external interface is
not HTTP, it is *files that other programs write to disk*, plus one JSON-RPC
stdio conversation with an ACP agent.

This document specifies a cassette system with three parts:

1. **Capture** — a recorder that copies a real session from its native
   location, redacts it, and writes a self-describing cassette directory.
2. **Replay** — a loader that serves a cassette through the existing
   `testFileSystem()` in-memory filesystem, or materializes it on disk for
   e2e, at three levels of assertion.
3. **Gates** — CI checks that keep cassette coverage from rotting: every
   supported tool must have a cassette, every cassette must be replayed,
   every golden must be in sync, and no cassette may contain residue.

It also specifies a second, smaller cassette family for the ACP boundary
(§11), where the same record/replay shape applies to a live subprocess.

## 2. Why the current fixtures are insufficient

Three concrete gaps, each with an existing code path that would not catch it.

**Schema drift passes silently.** `shared/schemas/claude.ts` decodes with
`onExcessProperty: 'preserve'`, which is correct — the tool adds fields over
time and we must not break. The consequence is that a *renamed* field does not
fail a decode; it produces a record that parses and means less. A synthetic
fixture written against the old name keeps passing forever. Only a real
transcript from a newer tool version surfaces this.

**Parse-issue accounting is never exercised at scale.** `ParseIssueLog`,
`recordSchemaMismatch`, and the `/api/debug` parse-health report exist to tell
a user why records were skipped. Today no test feeds them a few thousand real
records. We do not know our real-world malformed rate, so we cannot notice it
changing.

**Discovery is tested against layouts we invented.** `test/e2e/api.spec.ts`
constructs `rollout-2026-07-26T08-00-00-<uuid>.jsonl` under
`<root>/2026/07/26/` because that is what we believe Codex writes. If Codex
moves to a different directory grouping, `codexRunDiagnostics` finds nothing
and the e2e test still passes, because it also constructs the input.

Synthetic fixtures remain valuable and are **not** being deleted — they are
how we test edge cases that no real session conveniently contains (a
zero-token turn, a malformed line, a `PermissionDenied` on read). Cassettes
answer a different question: *does this still work against what the tools
actually emit?* The two coexist; §9.6 states the division.

## 3. What transfers from opencode, and what does not

| opencode piece | Transfers? | Our analogue |
| --- | --- | --- |
| Record real traffic once, replay from JSON | **Yes** | Record real session files once, replay from a cassette directory |
| Cassette carries redaction of headers/keys/JSON fields | **Yes** | Redaction of paths, identities, and free text (§6) |
| Golden matrix: provider × protocol × transport × scenario | **Yes** | tool × session-shape × scenario (§9) |
| `--fail-on-missing --fail-on-skip` coverage gate | **Yes** | Cassette + route coverage gate (§12) |
| HTTP/WebSocket interception layer (1,540 LOC) | **No** | We have no runtime network I/O; the transport is the filesystem |
| Request matching, header allowlists | **No** | Files have no request shape to match |
| Record-on-miss (first run hits the real API) | **Partly** | There is no API to hit; capture is an explicit operator action (§7) |

The single most important thing to copy is not the code — it is the
*discipline*: the fixture is a recording of reality, produced by a repeatable
command, reviewed as data, and regenerated rather than hand-edited.

## 4. Goals

1. Every supported source (Claude Code, Codex, Copilot Chat, Copilot CLI)
   has at least one cassette recorded from a real, current version of the tool.
2. A vendor format change produces a **failing test with a readable diff**,
   not a silent behavior change.
3. Cassettes contain no personal data, no credentials, and no proprietary
   source. Safety is enforced by construction *and* by a scanner, not by
   reviewer attention.
4. Re-recording is a one-command operation, and the resulting diff is
   reviewable — stable pseudonyms, canonical ordering, no gratuitous churn.
5. Replay is deterministic: no wall-clock dependence, no real filesystem in
   unit tests, no network anywhere.
6. No new runtime dependency. No change to the read-only server contract.

## 5. Non-goals

- Recording HTTP traffic. The server makes no outbound requests.
- Replacing synthetic fixtures. See §9.6.
- Capturing sessions from other people's machines, or any automated upload.
  Recording is a local, manual, opt-in developer action.
- Byte-exact reproduction of a session. Cassettes are truncated and redacted;
  they are representative, not archival.
- Cross-platform capture parity in v1. See §14 for the Windows caveat.

## 6. The cassette model

### 6.1 Definition

A cassette is a directory containing (a) a manifest, (b) session files laid
out exactly as the producing tool lays them out on disk, and (c) blessed
expectation files derived from replaying it.

Laying the files out natively — rather than flattening them into one blob —
is deliberate: it means the cassette exercises *discovery* (`session-catalog`,
`codex-runs`, `copilot-runs`) and not only parsing. A cassette that only
carried record arrays would leave `freshFilesIn`, the day-directory walk, and
the `subagents/` convention untested.

### 6.2 On-disk layout

```
test/cassettes/
  redaction/
    rules.ts                 # key classification tables, shared by recorder and hygiene test
    scanners.ts              # residue detectors
  claude/
    fanout-with-subagents/
      cassette.json          # manifest
      files/                 # native layout, rooted at the tool's root directory
        projects/
          -Users-user-1-Projects-repo-1/
            01J8X....jsonl
            01J8X.../
              subagents/
                agent-1.jsonl
                agent-1.meta.json
      expected/
        parse.json           # L1: per-file record counts and parse-issue census
        scan.json            # L2: normalized scanner projection
        api.json             # L3: normalized /api/tree + /api/run projection
  codex/
    tool-loop-with-reasoning/
      ...
  copilot/
    vscode-chat-basic/
      ...
  copilot-cli/
    turn-with-tool-failure/
      ...
```

The `files/` subtree root maps onto the tool's root `Context.Reference`:

| Source | Reference | `files/` subtree | Native layout |
| --- | --- | --- | --- |
| `claude` | `ProjectsDirectory` | `files/projects` | `<slug>/<sessionId>.jsonl`, `<sessionId>/subagents/<agentId>.jsonl` + `.meta.json` |
| `codex` | `CodexSessionsDirectory` | `files/sessions` | `YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` |
| `copilot` | `VsCodeUserDataDirectories` | `files/vscode-user` | `workspaceStorage/<id>/chatSessions/<uuid>.jsonl` |
| `copilot-cli` | `CopilotSessionStateDirectory` | `files/session-state` | `<sessionId>/events.jsonl` |

A cassette may populate more than one subtree when the scenario spans tools
(e.g. a project opened in both Claude Code and Codex). `manifest.source` then
becomes an array.

### 6.3 Manifest

`cassette.json`, parsed at load time with an Effect `Schema` living in
`test/fixtures/cassette-schema.ts`. It is external data consumed by tests, so
it gets a schema like any other external data; it is not app-facing, so it
does not belong in `shared/schemas/`.

```jsonc
{
  "schemaVersion": 1,
  "id": "claude/fanout-with-subagents",
  "source": ["claude"],
  "producer": { "tool": "claude-code", "version": "2.0.31", "platform": "darwin" },
  "capturedAt": "2026-08-04T09:12:44.000Z",
  "clockAnchor": "2026-08-04T10:00:00.000Z",
  "scenario": "fanout-with-subagents",
  "notes": "Three-way subagent fan-out against the sandbox repo. Contains one compaction, one hook failure, and one background Bash.",
  "redaction": { "version": 1, "rules": "claude@1", "identities": 4, "clippedValues": 17 },
  "truncation": { "keptRecords": 400, "droppedRecords": 122, "clipLimitBytes": 4096 },
  "entries": [
    {
      "path": "projects/-Users-user-1-Projects-repo-1/01J8X....jsonl",
      "bytes": 284913,
      "records": 361,
      "mtime": 1785931200,
      "sha256": "…"
    }
  ],
  "expectedParseIssues": [
    { "path": "projects/…/01J8X….jsonl", "line": 118, "kind": "invalid-json", "reason": "truncated write observed in the wild" }
  ]
}
```

Three fields carry weight:

- **`clockAnchor`** — the instant tests pin `TestClock` to. Every derived value
  that depends on "now" (`LIVE_WINDOW`, `statsNow`, `ago`, freshness cutoffs)
  becomes deterministic. Without it, `expected/scan.json` cannot be stable.
- **`entries[].mtime`** — seconds since epoch, fed straight into
  `FakeEntry.mtime` in `testFileSystem()`. Real mtimes are preserved
  (shifted, see §7.3) so freshness filtering is exercised.
- **`expectedParseIssues`** — the *only* sanctioned way a cassette may contain
  unparseable records. Each must be enumerated with a human reason. An
  unlisted parse issue fails L1. This turns "our malformed rate" from unknown
  into a reviewed constant.

### 6.4 Naming and identity

`id` is `<source>/<scenario>`, matching the directory path. Scenario names are
descriptive of the *transcript shape*, not the task: `fanout-with-subagents`,
`long-single-turn`, `compaction-mid-session`, `tool-failure-and-retry`,
`interrupted-turn`. A reviewer should be able to guess what a cassette
exercises from its name alone.

Cassettes are immutable artifacts. They are never hand-edited. To change one,
re-record it; to add a variation, add a new cassette.

## 7. Capture

### 7.1 The safety model: generate, then redact

The honest answer to "how do we ship a real transcript without leaking
anything" is **not** "redact hard enough." Free-text prompt and assistant
content is the whole point of half these tests — milestone detection, markdown
rendering, title extraction, `compactText` previews — and scrubbing it to
lorem destroys what the cassette is for.

So the primary control is the capture environment, and redaction is the second
net:

> **Cassettes are recorded from sessions deliberately run against a public
> sandbox repository, using prompts from a published scenario script, on a
> machine with no proprietary code in scope.**

`docs/cassette-scenarios.md` (new) holds the scripts. Each entry gives the
sandbox repo, the exact prompts to type, and the transcript shape it is meant
to produce. Anyone with the supported tool installed can reproduce a cassette
by following it.

This mirrors opencode: their cassettes are real provider traffic, but the
prompts are theirs and trivial ("stream some text", "call one tool"). The
traffic is real; the content is disposable.

Recording an ad-hoc real work session is permitted only with the
`--unsafe-adhoc` flag, which forces a full manual review checklist to be
acknowledged and stamps `"provenance": "adhoc"` into the manifest. Reviewers
should treat those PRs accordingly.

### 7.2 The recorder

`script/cassette/record.ts`, run as:

```sh
pnpm cassette:record --source claude --scenario fanout-with-subagents \
  --session 01J8X... [--keep-repo-name] [--limit 400] [--unsafe-adhoc]
```

Architecture note: this is a developer tool, not server domain code, so the
CLAUDE.md rule requiring the Effect filesystem does not bind it. It is plain
TypeScript on `node:fs` with **relative imports only** — `#server`/`#shared`
are Vite aliases with no `imports` entry in `package.json`, so a bare Node
process cannot resolve them. Run it with `node --experimental-strip-types`
(pinned in the `package.json` script) rather than adding a TS runner
dependency.

Pipeline, in order, aborting on the first failure:

1. **Resolve roots.** Same precedence the server uses: `LCC_*` if set,
   otherwise the platform default. The literal defaults from
   `server/utils/services.ts` are copied into `script/cassette/sources.ts`
   with a comment pointing at the original — the script cannot import the
   module, and a unit test asserts the two agree, over every source, so they
   cannot drift.
2. **Select.** Locate the named session, plus everything the tool associates
   with it (Claude: the `subagents/` directory and `.meta.json` siblings;
   Codex: nothing else; Copilot CLI: the whole session directory).
3. **Build the identity table.** Scan every selected file for identity-bearing
   values (§8.3) and allocate pseudonyms by order of first appearance.
4. **Redact.** Apply the key classification (§8.2) record by record.
5. **Truncate.** Apply `--limit` and the value clip (§7.3).
6. **Shift time.** §7.3.
7. **Scan for residue.** §8.5. Any hit aborts, prints the offending path,
   line, and a masked excerpt, and writes nothing.
8. **Write** `cassette.json` and `files/`.
9. **Bless** by invoking the same code path as `pnpm cassette:bless` (§9.5),
   so a fresh cassette arrives with its expectations already computed.
10. **Print a review summary**: identity table (pseudonym → real value, to the
    terminal only), record counts, clipped-value count, and the ten longest
    free-text values so the operator sees at a glance what is about to be
    committed.

The pseudonym mapping is also written to
`test/cassettes/<id>/.identities.local.json`, which is **gitignored**. It
exists so a maintainer can decode a cassette locally when debugging. It must
never be committed; §12 gate 2 fails if it is.

### 7.3 Truncation, clipping, and time

**Record limit.** `--limit` (default 400) keeps the first N records, then
appends nothing — no synthetic terminator. A truncated transcript is a real
state the scanners must handle (a session in progress looks exactly like
this), so truncation is not a degradation of realism. `truncation` in the
manifest records what was dropped.

**Value clip.** Any single string value over `clipLimitBytes` (default 4096)
is clipped to the limit with a `"…[clipped N bytes]"` suffix. This is
overwhelmingly `tool_result` bodies — a `Read` of a large file, a verbose
`Bash` stdout. Clipping keeps cassettes small and reduces leak surface, and
the clip marker is itself worth testing since `compactText` truncates anyway.
Structured values are never clipped, only strings.

**Time shift.** All timestamps are shifted by a single constant offset so the
newest record lands at `clockAnchor - 5 minutes`. One offset for the whole
cassette preserves every interval, so turn durations, `LIVE_WINDOW`
membership, and context-sample spacing all stay meaningful. File `mtime`s get
the same offset. The offset is not recorded — `capturedAt` and `clockAnchor`
together imply it, and keeping it out of the manifest avoids handing a reader
the real capture times.

### 7.4 Size budget

Total committed cassette bytes are capped at **2 MB**, enforced by `pnpm
cassette:verify`. At the default limit and clip, a Claude session with three
subagents lands around 150–250 KB, so the budget accommodates roughly a dozen
cassettes. When the cap is reached the fix is to lower `--limit` on the
largest cassette or retire one, not to raise the cap without discussion.

## 8. Redaction

### 8.1 Threat model

What must not reach the repository, in descending order of severity:

1. Credentials — API keys, tokens, `Authorization` headers echoed into a
   `Bash` result, `.env` contents read by a `Read` tool.
2. Proprietary source code and file contents.
3. Personal identity — real names, emails, usernames, hostnames.
4. Private paths and repository names that imply an employer or client.
5. Prompt content that is confidential in itself.

The sandbox capture protocol (§7.1) addresses 2 and 5 structurally. Redaction
addresses 1, 3, and 4, and acts as defense in depth for the rest.

### 8.2 Key classification

Every key in every record falls into exactly one of three classes. The tables
live in `test/cassettes/redaction/rules.ts` and are versioned
(`redaction.rules: "claude@1"`).

**`preserve`** — the key carries semantics the scanners read. Its value passes
through untouched. Redacting these would make the cassette test nothing.

> Claude: `type`, `role`, `timestamp`, `uuid`, `parentUuid`,
> `logicalParentUuid`, `isSidechain`, `agentId`, `version`, `model`,
> `stop_reason`, `usage.*`, `content[].type`, `content[].name` (tool name),
> `content[].id`, `content[].tool_use_id`, `toolUseResult.isAsync`,
> `durationMs`, `messageCount`, `service_tier`, `entrypoint`, `userType`.
>
> Codex: `type`, `payload.type`, `timestamp`, `id`, `call_id`, `model`,
> token-count fields.
>
> Copilot / Copilot CLI: the event `type` discriminant, ids, turn ids, tool
> call ids, model names, timestamps.

**`pseudonymize`** — the value identifies a person, machine, or project.
Replaced with a stable pseudonym, structure preserved (§8.3).

> `cwd`, `gitBranch`, any `file_path` / `filePath` / `path` / `uri`,
> `sessionId` / `session_id`, workspace ids, directory slugs in the *file
> layout itself*.

**`scrub`** — free text. Under the sandbox protocol these pass through
verbatim (they are sandbox content by construction) but are subjected to the
residue scanners and to value clipping.

> `content[].text`, `content[].thinking`, prompt bodies, `tool_result`
> content, `Bash` command strings and outputs, `description` fields, generated
> and custom titles, `lastPrompt`.

A key not listed in any table is **`scrub` by default**, and the recorder
prints a warning naming it. That is how a newly added vendor field announces
itself: it shows up as an unclassified key in the record log, and the operator
classifies it before the cassette is committed. This is the same alarm as
opencode's `--fail-on-missing`, applied to fields instead of routes.

### 8.3 Pseudonymization

Not hashing. A keyed hash with a committed salt is reversible by dictionary
attack for exactly the values that matter — a username or hostname has a few
bits of entropy. Instead: **counter allocation by order of first appearance**,
which is deterministic for a given input, stable across a re-record of the
same session, and irreversible.

| Real value | Pseudonym |
| --- | --- |
| `alexanderopalic` (username) | `user-1` |
| `Alexanders-MacBook-Pro.local` | `host-1` |
| `opalicalexander@gmail.com` | `user-1@example.invalid` |
| `liveclaudecode` (repo dir name) | `repo-1` |
| `01J8XQ…` (session id) | `01J8XQ…` → regenerated valid-shaped id |

Paths keep their tail. This matters more than anything else in this section:

```
/Users/alexanderopalic/Projects/liveclaudecode/server/utils/runs.ts
→ /Users/user-1/Projects/repo-1/server/utils/runs.ts
```

The repo-relative suffix is what `recordFileChange` keys on, what the changes
view displays, and what `languageForPath` reads — swapping it would gut the
test. Only the identity-bearing prefix moves. `--keep-repo-name` disables the
repo substitution for public repositories, where the name is not sensitive and
keeping it makes the cassette more readable.

Identifiers that must stay well-formed (ULIDs, UUIDs) are regenerated as
valid values of the same shape from a seeded generator, not replaced with
`session-1` — several code paths parse them, and `basename(path, '.jsonl')`
is used as a fallback key in `copilot-runs.ts`.

Claude's project directory slug (`-Users-alexanderopalic-Projects-…`) is
derived from `cwd`, so it is pseudonymized as a path and the resulting
directory name must be recomputed by the same slug rule, not string-patched.

### 8.4 Referential integrity

The identity table is global to a cassette. The same real path must produce
the same pseudonym in the transcript body, in the `cwd` field, in the file
layout, and in a subagent's `.meta.json`. Getting this wrong produces a
cassette that parses but whose file-change aggregation is nonsense — a subtle
failure that would waste a lot of debugging time.

The recorder enforces it by building the table in one pass (step 3) before any
substitution happens, and by asserting after substitution that no pseudonym
maps to two distinct real values or vice versa.

### 8.5 Residue scanners — fail closed

Run over the fully redacted output, before anything is written. Any match
aborts the recording.

1. **Environment residue.** `homedir()`, `userInfo().username`, `hostname()`,
   `git config user.name`, `git config user.email` (global and local), every
   `LCC_*` value, and the values of every env var whose *name* matches
   `/KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL|COOKIE/i`.
2. **Known credential shapes.** `sk-[A-Za-z0-9]{20,}`, `ghp_`, `gho_`,
   `github_pat_`, `AKIA[0-9A-Z]{16}`, `xox[baprs]-`, JWTs
   (`eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.`), `Bearer [A-Za-z0-9._-]{20,}`,
   PEM block headers.
3. **Email addresses**, other than the `@example.invalid` pseudonyms.
4. **High-entropy tokens.** `[A-Za-z0-9_\-+/=]{32,}` whose Shannon entropy
   exceeds 3.5 bits per character, excluding values matched by the preserve
   list (a base64 image payload in a `content[].source.data` block is expected
   and is dropped by the clip rule instead).
5. **Absolute paths outside the pseudonym space** — any `/Users/`, `/home/`,
   or `C:\Users\` prefix not followed by a `user-N` segment.

The same scanners run as a plain unit test over all committed cassettes
(`test/unit/cassette-hygiene.spec.ts`), so a hand-edited or manually
constructed cassette cannot bypass the recorder. That test is the actual
guarantee; the recorder step is the fast feedback.

## 9. Replay

### 9.1 Loader

`test/fixtures/cassette.ts`:

```ts
export type CassetteSource = 'claude' | 'codex' | 'copilot' | 'copilot-cli'

export interface Cassette {
  readonly id: string
  readonly manifest: CassetteManifest
  /** Cassette-relative path → file body, as committed. */
  readonly files: ReadonlyMap<string, string>
  /**
   * The cassette served from memory, with every root `Context.Reference`
   * pointed at its subtree and `mtime`s taken from the manifest.
   * Built on `testFileSystem()`, so unit tests stay off the disk.
   */
  readonly layer: Layer.Layer<FileSystem.FileSystem | FileDiscoveryLimiter>
  /** Roots as they will be seen by code under test. */
  readonly roots: Readonly<Record<CassetteSource, string>>
  /** Materialize onto a real directory for e2e, browser, and desktop replay. */
  readonly materialize: (options?: MaterializeOptions) => Promise<CassetteRoots & AsyncDisposable>
  /** The instant tests should pin `TestClock` to. */
  readonly clockAnchor: number
}

export interface MaterializeOptions {
  /**
   * How file `mtime`s are anchored on the materialized copy.
   *
   * - `'recorded'` (default) writes the manifest's mtimes verbatim. Correct
   *   when the test pins its own clock.
   * - `'now'` shifts every mtime by one constant so the newest lands at
   *   `Date.now() - 5 minutes`. Intervals — and therefore ordering and
   *   freshness relative to each other — are preserved, but the cassette
   *   reads as recent no matter when it was recorded.
   *
   * @default 'recorded'
   */
  anchor?: 'recorded' | 'now'
  /** Write into this directory instead of a fresh temp one. */
  into?: string
}

export function loadCassette(id: string): Cassette
export function cassettesFor(source: CassetteSource): readonly Cassette[]
export function allCassettes(): readonly Cassette[]
```

`layer` composes `testFileSystem()` from `test/fixtures/filesystem.ts` with a
`Context` carrying `ProjectsDirectory`, `CodexSessionsDirectory`,
`CopilotSessionStateDirectory`, and `VsCodeUserDataDirectories` set to the
in-memory roots. No new filesystem fake is written; the existing one already
supports the `stream({ offset, bytesToRead })` reads that
`incremental-jsonl.ts` performs, and its `FakeEntry.mtime` is exactly what the
manifest supplies.

Cassettes are read from disk at module load with `node:fs` — this is test
support code, not server domain code, and it must be synchronous so
`describe`-time enumeration works.

### 9.2 Level 1 — schema conformance

`test/unit/cassette-conformance.spec.ts`. Table-driven over `allCassettes()`.

For each record in each file: decode with the source's parser
(`parseClaudeRecord`, and the Codex/Copilot equivalents). Then assert:

- Every record either decodes, or appears in `manifest.expectedParseIssues`
  with a matching line and kind.
- No record in `expectedParseIssues` decodes successfully (a stale allowance
  is itself a failure — it means the schema was widened and nobody removed
  the note).
- The per-file record count matches `entries[].records`.
- The parse-issue census matches `expected/parse.json` exactly.

This is the format-drift alarm and the cheapest of the three levels. It should
run in well under a second for the whole corpus.

`expected/parse.json` holds the census rather than only a total, so a change
from "3 invalid-json" to "3 schema-mismatch" fails:

```json
{
  "byFile": {
    "projects/…/01J8X….jsonl": { "records": 361, "invalid-json": 1, "schema-mismatch": 0, "unsupported-shape": 0 }
  }
}
```

### 9.3 Level 2 — scanner golden

`test/unit/cassette-scan.spec.ts`. For each cassette, run the source's scanner
(`TranscriptScan`, `CodexTranscriptScan`, `CopilotTranscriptScan`,
`CopilotCliTranscriptScan`) over the cassette layer under `TestClock` pinned
to `clockAnchor`, then project the scan into a canonical JSON document and
compare to `expected/scan.json`.

The projection is explicit and stable — not a serialization of the whole
object:

```ts
interface ScanProjection {
  counts: Record<string, number>          // sorted keys
  errors: number
  malformed: number
  parseIssues: { total: number, byKind: Record<string, number> }
  firstTs: string | null
  lastTs: string | null
  tokensOut: number
  cwd: string
  titles: { ai: string, custom: string }
  files: Array<{ path: string, ops: number, tools: string[] }>   // sorted by path
  commands: Array<{ command: string, exit: number | null }>      // order preserved
  milestones: Array<{ kind: string, at: string, label: string }>
  incidents: Array<{ id: string, category: string, severity: string }>
  turns: Array<{ index: number, durationMs: number }>
  context: Array<{ at: string, used: number, limit: number }>
  compactions: number
  skills: string[]
  outcomes: Array<{ agent: string, status: string }>
  budget: BudgetReport | null
}
```

Rules for the projection:

- **Sort anything whose order is not semantic** (file map entries, tool name
  lists, count keys). Map iteration order is insertion order, which is stable
  today, but a refactor that changes ingest order should not produce a 400-line
  diff.
- **Keep order where order *is* the assertion** (commands, milestones, turns,
  context samples).
- **Never include absolute paths** beyond the pseudonymized ones already in
  the cassette.
- **Never include a duration derived from wall clock** — `TestClock` at
  `clockAnchor` makes `statsNow` deterministic, and that is the only clock
  read in the scan path.

Deliberately *not* `toMatchSnapshot()`. A committed JSON file is reviewable in
a PR diff, survives a test-runner change, and makes blessing an explicit
command rather than a side effect of `-u`.

### 9.4 Level 3 — catalog and API replay

`test/e2e/cassette-api.spec.ts`. Materializes each cassette onto a temp
directory, starts the Nuxt e2e server with `LCC_CLAUDE_PROJECTS`,
`LCC_CODEX_SESSIONS`, `LCC_COPILOT_SESSIONS`, and `LCC_VSCODE_USER_DATA`
pointed at it, then asserts a normalized projection of:

- `/api/tree` — run count, hierarchy shape, source attribution, labels
- `/api/run` for each root — the summary block, changed files, diagnostics
- `/api/costs` — totals per source
- `/api/debug` — the parse-health report, which must agree with L1

against `expected/api.json`.

This is the level that covers discovery, aggregation, and the HTTP contract —
the parts L1 and L2 skip entirely. It is also the slowest, so it runs against
one cassette per source (marked `"e2e": true` in the manifest) rather than the
whole corpus.

One wrinkle: the e2e project needs deterministic responses, but the server
reads the real clock. Committed `mtime`s are anchored to `clockAnchor`, so a
cassette recorded in August looks stale in December and drops out of the
default `LCC_HOURS` window. L3 therefore materializes with `anchor: 'now'`,
which re-bases every mtime against the current instant while preserving the
intervals between them.

That handles *freshness* but not *rendered relative time*: `statsNow` reads
the server's `Clock`, so `ago` and `live` are computed server-side and land in
whatever bucket the test happens to run in. The `api.json` projection
therefore omits every wall-clock-derived field — `ago`, `live`, `lastSeen`
deltas — and those are asserted at L2 instead, where `TestClock` makes them
free. **Rule: anything derived from "now" is an L2 assertion, never an L3 or
L4 one.**

### 9.5 Blessing

```sh
pnpm cassette:bless [--id claude/fanout-with-subagents]
```

Recomputes `expected/parse.json`, `expected/scan.json`, and `expected/api.json`
for one or all cassettes and writes them. The three replay specs and the bless
script share one projection implementation
(`test/fixtures/cassette-projection.ts`) so a blessed file cannot disagree
with what the test computes.

Blessing is never automatic and never runs in CI. A PR that changes a blessed
file must explain the change in its description — that diff is the entire
point of the system.

### 9.6 Where synthetic fixtures still belong

| Use | Fixture kind |
| --- | --- |
| Does the parser accept what the tool emits today? | **Cassette** |
| Does discovery find sessions in the real layout? | **Cassette** |
| Does the aggregate view of a real session look right? | **Cassette** |
| A malformed line, a truncated write, a `PermissionDenied` | Synthetic |
| A zero-token turn, a negative duration, an absurd token count | Synthetic |
| Exactly the boundary of `LIVE_WINDOW` | Synthetic |
| A specific tool's output shape in isolation | Synthetic |
| Component and composable tests | Synthetic (`mockLiveApi`, `runs.ts` builders) |

Cassettes answer *"is this still true of reality?"*. Synthetic fixtures answer
*"is this branch correct?"*. Neither replaces the other, and the existing
`test/fixtures/*.ts` builders stay exactly as they are.

## 10. Level 4 — browser and desktop replay (Playwright)

This is the level with the largest payoff, and it is nearly free once
`materialize()` exists.

### 10.1 What the browser suite tests today

`playwright.config.ts` already boots the real preview server against a real
directory of transcripts:

```ts
env: {
  LCC_PROJECT: fixturesDirectory,               // test/fixtures/browser
  LCC_CODEX_SESSIONS: join(fixturesDirectory, 'missing-codex'),
  LCC_VSCODE_USER_DATA: join(fixturesDirectory, 'missing-vscode'),
  LCC_HOURS: '99999',
}
```

That is genuinely full-stack — disk → Effect scanners → h3 → Nitro → SSR →
hydration → DOM. The problem is the data: `browser-session.jsonl` is **12
hand-written records**, and the Codex and VS Code roots deliberately point at
directories that do not exist. So the browser suite renders a nearly empty
dashboard, and everything downstream of "there is real content here" is
untested in a browser: the run canvas with a real subagent tree, the changes
view with real diffs, the timeline with real turns, diagnostics with real
incidents, the multi-source filter with more than one source present.

A cassette is exactly the missing input.

### 10.2 Wiring

`globalSetup` (`test/browser/global-setup.ts`) materializes every cassette
marked `"browser": true` into one shared root under
`test-results/.cassette-root/` with `anchor: 'now'`, then writes the resolved
paths where the config can read them.

One root, one server, many cassettes. Because each Claude cassette
materializes into its own `projects/<slug>/` directory, several cassettes
coexist naturally and the dashboard renders *multiple projects* — closer to
what a real user sees than the single-project fixture is. This requires
switching the browser config from `LCC_PROJECT` (one directory) to
`LCC_CLAUDE_PROJECTS` (a root of many), and populating
`LCC_CODEX_SESSIONS` / `LCC_VSCODE_USER_DATA` / `LCC_COPILOT_SESSIONS` with
the real subtrees instead of `missing-*` paths.

`fullyParallel: true` stays safe: the server is read-only with respect to
transcript data, so parallel workers sharing one materialized root cannot
interfere. That is a property worth stating out loud — it is why this design
is cheap here and would not be in a read-write product.

The desktop suite (`test/desktop/shell.spec.ts`) points at the same root, so
the Electron shell gets real data at no extra cost.

### 10.3 What this unlocks

**Content-bearing assertions.** The current `dashboard.spec.ts` asserts on a
cost region whose numbers it patched into the response by hand
(`route.fetch()` then rewriting `body.costs`). With a cassette the numbers are
derived from real `usage` blocks by the real `cost.ts` — so the test asserts
the pipeline, not the patch.

**Multi-source UI.** Source filters, per-source badges, and degraded-source
messaging currently only ever render in mocked states. A multi-source cassette
renders them from real data.

**Accessibility auditing with real content.** `dashboard.spec.ts` already
injects `axe-core`. Auditing a near-empty page finds near-nothing; auditing a
populated run canvas, an expanded tool disclosure, and a diff view is where
the real violations are.

**Visual regression becomes viable.** Deterministic data plus a pinned
viewport makes `toHaveScreenshot()` meaningful for the run canvas, the
timeline, and the changes view — none of which can be screenshot-tested today
because there is nothing on them. Constraints (§10.4) apply.

**A performance guardrail.** Record one deliberately large cassette
(`claude/large-session`, `--limit 5000`) and assert budgets against it:
hydration completes under N ms, no long task over 200 ms while scrolling the
canvas, the timeline virtualizer keeps DOM node count bounded. This is the
category opencode carved out into `packages/app/e2e/performance/` with its own
Playwright config, and it is unreachable without a large realistic fixture.

### 10.4 Determinism rules

Playwright is where flake is born, so these are constraints, not suggestions.

1. **Never assert on relative-time text.** `ago`/`live` come from the server's
   real clock (§9.4). Assert them at L2. In the browser, assert that the
   element exists and has the right role, not what it says.
2. **Mask time in screenshots.** Every `toHaveScreenshot()` passes `mask:` for
   the age/live regions. Add `animations: 'disabled'` and a fixed viewport.
3. **Screenshots on one platform only.** Font rasterization differs across
   macOS and Linux; baselines are generated and compared on the Linux CI leg,
   and the screenshot project is skipped locally on darwin unless
   `--update-snapshots` is passed deliberately.
4. **`maxDiffPixelRatio`, not zero tolerance.** Start at `0.01` and tighten
   only if it proves stable.
5. **No `networkidle` for polling pages.** The dashboard polls `/api/events`;
   `waitUntil: 'networkidle'` will either hang or resolve arbitrarily. Wait on
   a locator instead. (The existing `dashboard.spec.ts` uses `networkidle`
   today — worth revisiting when cassettes make the page busier.)
6. **Cost numbers are safe.** They derive from token counts in the cassette
   and are not time-dependent, so they may be asserted exactly.
7. **Ordering is safe.** Session sort is mtime-based and `anchor: 'now'`
   preserves intervals, so relative order is stable.

### 10.5 What cassettes must not replace

`test/browser/dashboard-api-states.spec.ts` and `mockDashboardApi` stay
exactly as they are. Route interception is the correct — and only — way to
test a slow response, a 500, an empty tree, or a stale-response race, and
`deferred()` gives that suite precise control a real server cannot. The
division:

| Browser test concern | Mechanism |
| --- | --- |
| Loading, error, empty, degraded-source states | `mockDashboardApi` |
| Stale-response and race handling | `mockDashboardApi` + `deferred()` |
| Does real data render correctly end to end | **Cassette** |
| Accessibility of populated views | **Cassette** |
| Visual regression | **Cassette** |
| Performance budgets | **Cassette** (large variant) |
| Chat send / cancel over a live agent | **Cassette** (ACP, §11) |

### 10.6 Chat in the browser

`POST /api/chat` currently needs `LCC_ACP_*` pointed at
`test/fixtures/acp-agent.mjs`, which answers with one hand-written message
chunk. Once ACP cassettes exist (§11), the browser suite can drive a full chat
turn — streamed updates, a permission prompt, a cancel — against recorded real
agent behavior, which is the one interactive flow the dashboard has and
currently the thinnest-tested.

## 11. ACP cassettes

The ACP boundary is the one place the server talks to a live external program
at runtime, and it is the closest structural match to opencode's HTTP
recorder.

`AcpConnector` (`server/utils/acp-connection.ts`) depends only on
`ChildProcessSpawner.ChildProcessSpawner`, which makes record/replay clean:
swap the spawner.

**Cassette format** — `test/cassettes/acp/<scenario>/conversation.json`:

```jsonc
{
  "schemaVersion": 1,
  "agent": { "command": "claude-code-acp", "version": "0.4.2" },
  "messages": [
    { "dir": "out", "message": { "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { … } } },
    { "dir": "in",  "message": { "jsonrpc": "2.0", "id": 1, "result": { "protocolVersion": 1 } } },
    { "dir": "out", "message": { "jsonrpc": "2.0", "id": 2, "method": "session/new", "params": { … } } },
    { "dir": "in",  "message": { "jsonrpc": "2.0", "id": 2, "result": { "sessionId": "…" } } },
    { "dir": "out", "message": { "jsonrpc": "2.0", "id": 3, "method": "session/prompt", "params": { … } } },
    { "dir": "in",  "message": { "jsonrpc": "2.0", "method": "session/update", "params": { … } } },
    { "dir": "in",  "message": { "jsonrpc": "2.0", "id": 4, "method": "session/request_permission", "params": { … } } },
    { "dir": "out", "message": { "jsonrpc": "2.0", "id": 4, "result": { "outcome": { … } } } },
    { "dir": "in",  "message": { "jsonrpc": "2.0", "id": 3, "result": { "stopReason": "end_turn" } } }
  ]
}
```

`dir` is from the dashboard's perspective: `out` is client→agent, `in` is
agent→client.

**Replay semantics — no timing dependence.** The replay spawner walks the
message list:

- An `out` entry is a **barrier**. Replay waits for the connector to write a
  message, then asserts it matches (see **Matching** below), then advances.
- Consecutive `in` entries following a barrier are emitted immediately, in
  order, without waiting.
- End of list closes stdout, which makes `AcpConnector` fail pending requests
  with `agent exited` — itself a path worth testing.

No sleeps, no wall-clock, compatible with `TestClock`. A mismatch reports the
expected and actual message side by side.

**Matching.** Compare `method` exactly. Compare `params` after
dropping keys listed in the scenario's `volatile` array (session ids the agent
minted, timestamps, cwd). Request ids match naturally — `nextId` is a
per-connection counter starting at 1, so a deterministic client produces
deterministic ids; if that ever stops being true, fall back to a
bidirectional id map keyed by arrival order.

**Recording.** `pnpm cassette:record --source acp --scenario <name>` wraps the
real spawner, tees both directions into the cassette, and applies the same
identity pseudonymization and residue scanning as transcript cassettes. Prompt
and result text go through the sandbox protocol.

**`acp-agent.mjs` stays.** It exercises real `spawn`, real stdio, real process
teardown, and the `hang`/cancel path — things a fake spawner cannot cover.
Cassettes add unit-level coverage of the connector and `chat.ts` against
*actual agent behavior*, which the hand-written script by definition cannot
provide. The two are complementary:

| Concern | `acp-agent.mjs` (e2e) | ACP cassette (unit) |
| --- | --- | --- |
| Process spawn, stdio, teardown | ✅ | ❌ |
| Cancel / hang path | ✅ | ✅ |
| Real agent's actual message shapes | ❌ | ✅ |
| Permission-request round trip | partial | ✅ |
| Runs without the agent installed | ✅ | ✅ |

## 12. CI gates

All four run inside `pnpm check` and in the existing `.github/workflows/ci.yml`
job. A new `pnpm cassette:verify` script implements gates 1–3.

**Gate 1 — coverage.** Fails when:
- a `CassetteSource` has zero cassettes;
- a cassette directory is not referenced by any of the three replay specs
  (checked by enumerating `allCassettes()` against the ids the specs
  consumed — the specs register what they ran, so this is a runtime check in
  a final `afterAll`, not a grep);
- a source has no cassette marked `"e2e": true`;
- a file exists under `server/api/` with no corresponding assertion in the
  e2e suite. This is the direct analogue of opencode's
  `--fail-on-missing --fail-on-skip`, and it is worth having even
  independently of cassettes: today a new endpoint can ship with no test at
  all.

**Gate 2 — hygiene.** `test/unit/cassette-hygiene.spec.ts` runs the §8.5
scanners over every committed cassette byte, and fails if any
`.identities.local.json` is tracked by git.

**Gate 3 — budget and integrity.** Total cassette bytes ≤ 2 MB; every
`entries[].sha256` matches; every manifest parses under the schema; every
`expectedParseIssues` entry has a non-empty reason.

**Gate 4 — blessing sync.** Recompute all three projections and diff against
the committed `expected/*.json`. Any difference fails with the diff printed.
This is just L1–L3 running; it needs no separate step.

**Not a gate — freshness.** A scheduled weekly workflow compares each
`manifest.producer.version` against the newest release of that tool and opens
(or updates) a single tracking issue listing stale cassettes. It never fails a
build: a cassette recorded against an older version is still a valid
regression test, and a red CI on someone else's release cadence is noise. The
issue is the nudge to re-record.

## 13. Repository changes

The system lives in four places, each of which is its own listing — a file
inventory copied into this document would be one more thing to keep in step
with the directory it describes, and it would lose that race.

- `script/cassette/` — the operator tools: record, bless, verify, and the
  sandbox generator, plus the root resolution and redaction they share.
- `test/cassettes/` — the recordings themselves, their blessed expectations,
  and `redaction/` (key classification and residue detectors).
- `test/fixtures/cassette*.ts` — the loader, the manifest Schema, and the
  projections the replay tiers and `bless.ts` share.
- `test/{unit,e2e}/cassette-*.spec.ts` — the replay tiers and the hygiene gate.

Modified:

- `package.json` — the `cassette:*` scripts; `cassette:verify` added to the
  `check` chain.
- `.gitignore` — `test/cassettes/**/.identities.local.json`.
- `AGENTS.md` — a short **Cassettes** section: what they are, when to add one,
  that they are never hand-edited, and that blessing is explicit.
- `README.md` — what cassettes are, and a security note that
  `test/cassettes/` holds recorded third-party output.
- `tsconfig.test.json` — add `script/cassette` and `test/cassettes/redaction`
  so the recorder is typechecked by `pnpm test:types` like the rest of the
  test sources.

No changes to `server/`, `shared/`, `app/`, or `electron/`. The system is
additive and test-only, which is a large part of its appeal — it can be built
incrementally without touching product code.

## 14. Risks and open decisions

**Windows path capture.** Cassettes recorded on macOS encode POSIX
separators and `/Users/...` roots. Replayed on a Windows CI leg they exercise
POSIX path handling on Windows, which is *not* what Windows users experience.
Two options: (a) record a Windows-native cassette per source, requiring a
Windows capture machine; (b) have the loader rewrite separators and root
prefixes when materializing on Windows, which tests the rewrite rather than
reality. **Recommendation: (a), deferred.** Until then, note in the manifest
that cassettes are `platform: "darwin"` and do not claim Windows coverage
from them. (Adding a Windows CI leg at all is a separate, larger gap — see the
opencode comparison — and cassettes make it *more* valuable, not less.)

**Blessed-file churn.** A legitimate change to milestone detection rewrites
several `expected/scan.json` files at once. Mitigations: canonical sorting,
one projection implementation, and a projection deliberately narrower than the
full scan object. Accepted cost — the churn *is* the signal.

**Re-record diff size.** Pseudonyms are allocated by order of first
appearance, so a re-record of the *same* session is stable. A re-record of a
*new* session against the same scenario is a wholesale replacement. That is
expected and correct; review it as new data, not as a diff.

**Free-text policy.** The sandbox protocol is the recommendation and the
default. `--unsafe-adhoc` exists because someone will eventually need to
capture a bug they cannot reproduce in the sandbox. It is a documented, marked
escape hatch, not the normal path. **Open question:** should `--unsafe-adhoc`
be allowed to commit at all, or only to produce a local cassette for
debugging? Leaning toward local-only.

**Cassettes as a leak of tool behavior.** A cassette publishes the exact
record shapes a vendor's tool emits. These are already on every user's disk
and are read by this open-source project by design, so this is not a new
disclosure — but it is worth a line in the README noting that
`test/cassettes/` contains recorded third-party output.

**Effort.** Realistically two to three days for phases 1–3, most of it in
redaction and the projection design, plus an ongoing per-cassette cost of
maybe twenty minutes. That is only worth paying because the alternative —
finding out from a user that Codex changed its rollout format — is much more
expensive.

## 15. Remaining work

Phases 0 to 4 — the protocol and sandbox, redaction and recorder, L1 across
all four sources, L2 and blessing, and L3 plus the gates wired into
`pnpm check` — are built. What is left:

**Phase 5 — ACP cassettes.** Replay spawner, recorder mode, connector and
chat-store specs. *Deliverable: the live-agent boundary is tested against real
agent behavior.*

**Phase 6 — freshness workflow.** The scheduled staleness issue. *Deliverable:
cassettes get re-recorded on purpose rather than when someone remembers.*

## 16. Appendix — worked redaction example

Input record, as Claude Code wrote it:

```json
{
  "type": "assistant",
  "uuid": "b4c1…",
  "parentUuid": "9f22…",
  "timestamp": "2026-08-04T09:14:02.117Z",
  "cwd": "/Users/alexanderopalic/Projects/acme-billing",
  "gitBranch": "aopalic/invoice-rounding",
  "sessionId": "01J8XQ7N4M2K9V3R8T5W1Y6Z0A",
  "version": "2.0.31",
  "message": {
    "model": "claude-opus-5",
    "usage": { "input_tokens": 2, "output_tokens": 411, "cache_read_input_tokens": 3289 },
    "content": [
      { "type": "text", "text": "I'll fix the rounding in the invoice total." },
      { "type": "tool_use", "id": "toolu_01A", "name": "Edit",
        "input": { "file_path": "/Users/alexanderopalic/Projects/acme-billing/src/invoice.ts" } }
    ]
  }
}
```

After redaction — note what moved and what did not:

```json
{
  "type": "assistant",
  "uuid": "b4c1…",
  "parentUuid": "9f22…",
  "timestamp": "2026-08-04T09:59:31.117Z",
  "cwd": "/Users/user-1/Projects/repo-1",
  "gitBranch": "user-1/invoice-rounding",
  "sessionId": "01J9K2M8P4Q6R8T0V2X4Z6B8D0",
  "version": "2.0.31",
  "message": {
    "model": "claude-opus-5",
    "usage": { "input_tokens": 2, "output_tokens": 411, "cache_read_input_tokens": 3289 },
    "content": [
      { "type": "text", "text": "I'll fix the rounding in the invoice total." },
      { "type": "tool_use", "id": "toolu_01A", "name": "Edit",
        "input": { "file_path": "/Users/user-1/Projects/repo-1/src/invoice.ts" } }
    ]
  }
}
```

- `type`, `uuid`, `parentUuid`, `version`, `model`, `usage.*`, tool `id` and
  `name` — **preserved**. The causal graph, cost accounting, and tool stats
  are the things under test.
- `cwd`, `gitBranch`, `file_path`, `sessionId` — **pseudonymized**, with
  `src/invoice.ts` kept intact so `recordFileChange` and the changes view
  still have something real to key on.
- `text` — **scrubbed class, passed through**, because this session was run
  against the sandbox repo per the capture protocol.
- `timestamp` — shifted by the cassette-wide offset. The interval to the next
  record is unchanged.

The employer name (`acme-billing`) is gone from every occurrence, including
the directory slug in the file layout, because the identity table is built
before substitution and applied globally.
