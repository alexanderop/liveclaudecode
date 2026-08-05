# Cassette capture scenarios

The capture protocol for `test/cassettes/`. Read
`docs/transcript-cassettes-spec.md` first for what a cassette is and why it
exists; this document is the operational half — what to run so that a session
*worth recording* exists on disk.

## The rule

> Cassettes are recorded from sessions deliberately run against the sandbox
> repository below, using the prompts in this document, on a machine with no
> proprietary code in scope.

Free text (prompts, assistant messages, tool output) passes into the cassette
verbatim — that is what makes milestone detection, title extraction, markdown
rendering, and `compactText` previews testable. So the control is the *input*,
not the scrubber. Anything you type during a capture session is committed.

Recording an ad-hoc real session requires `--unsafe-adhoc` and produces a
local-only cassette; see the end of this document.

## The sandbox repository

Reproducible without hosting: `script/cassette/sandbox.ts` writes the whole
tree, and the scenarios below are scripted against exactly that tree.

```sh
pnpm cassette:sandbox              # → a fresh temp directory, path printed
pnpm cassette:sandbox --into /tmp/cassette-sandbox
```

It is a five-file TypeScript package — an invoice total with a deliberate
floating-point rounding bug, a failing test that proves the bug, and a README.
Small enough to read in a minute, real enough that an agent has to read files,
run a command, edit, and re-run.

The generator is the source of truth. Do not hand-edit the sandbox; if a
scenario needs different material, change the generator and re-record every
cassette that depends on it.

Name the directory `invoice-sandbox` if you like, but do not pass
`--keep-repo-name` when recording. Every cassette should map its capture
directory to the default `/Users/user-1/Projects/repo-1`, so that cassettes
from different tools land in *one* project when the e2e and browser tiers
materialize them into a shared root — which is what makes cross-source
aggregation testable at all.

Each capture starts from a clean checkout:

```sh
SANDBOX=$(pnpm --silent cassette:sandbox)
cd "$SANDBOX" && git log --oneline    # one commit, "Initial sandbox"
```

## Scenarios

Every scenario names the source, the transcript shape it must produce, the
prompts verbatim, and how to tell it worked before you spend a recording on it.

Three of the four tools can be driven non-interactively, which makes a capture
reproducible rather than a matter of typing carefully:

```sh
claude -p "<prompt>" --permission-mode acceptEdits --allowedTools "Read,Edit,Write,Glob,Grep,Task,Bash(npm test),Bash(npm run typecheck)" < /dev/null
claude -p "<prompt>" --continue --permission-mode acceptEdits --allowedTools "…" < /dev/null

codex exec --sandbox workspace-write "<prompt>"
codex exec resume --last --sandbox workspace-write "<prompt>"

copilot --allow-all-tools --allow-all-paths -p "<prompt>"
copilot --allow-all-tools --allow-all-paths --continue -p "<prompt>"
```

VS Code Copilot Chat has no such mode; that scenario is captured by hand.

Prompts are given as fenced blocks. Type them as written. If the agent goes
somewhere unexpected, discard the session and start over rather than steering
it with an improvised prompt — an off-script prompt is unreviewed free text.

---

### `claude/fanout-with-subagents` — recorded

**Shape:** a root session that spawns concurrent `Task` subagents, so the
cassette carries `<sessionId>/subagents/<agentId>.jsonl` alongside the root
transcript and exercises the subagent discovery convention, `logicalParentUuid`
threading, and agent-outcome aggregation.

**Run:**

```sh
cd "$SANDBOX"
claude
```

Prompt 1:

```
Read src/invoice.ts and test/invoice.test.ts, then run `npm test` and tell me what fails.
```

Prompt 2 — the fan-out:

```
Use three parallel subagents: one to fix the rounding bug in src/invoice.ts, one to add a test for a zero-quantity line item, and one to check README.md matches the code. Report what each found.
```

Prompt 3 — a tool failure worth recording:

```
Run `npm run typecheck` and fix anything it reports.
```

(`typecheck` is not a script in the sandbox `package.json`. The failing command
is deliberate: it produces a non-zero `Bash` exit and a `tool` incident.)

**Verify before recording:**

```sh
ls ~/.claude/projects/$(pwd | sed 's/[^a-zA-Z0-9_-]/-/g')/
```

There must be a `<sessionId>.jsonl` *and* a `<sessionId>/subagents/`
directory containing at least three `.jsonl` files with `.meta.json` siblings.
No subagents means no fan-out — re-run.

**Record:**

```sh
pnpm cassette:record --source claude --scenario fanout-with-subagents \
  --session <sessionId>
```

---

### `codex/short-turn-with-usage-limit` — recorded

**Shape:** the rollout envelope and nothing beyond it: `session_meta`,
`turn_context`, `world_state`, `event_msg:user_message`, `task_started`,
`token_count`, `task_complete`, and the response items around them.

This is what a Codex session looks like when the account hits its usage limit
mid-turn, which is how it came to be recorded. It is a thin cassette, and it is
deliberately named for what it contains rather than for what was asked for.
It still does the L1 job — the envelope, both payload schemas, and the event
union are all exercised — but it does **not** cover the tool loop.

Recorded with the prompts below; the first turn is all that got through.

### `codex/tool-loop-with-reasoning` — not yet recorded

**Shape:** a rollout with `session_meta`, `turn_context`, reasoning items,
a shell tool loop, an `update_plan` call, a `patch_apply_end` with real file
changes, and `token_count` events — the payload types `codex-transcript.ts`
models. Record this when Codex quota allows; it supersedes the thin cassette
above, which should then be retired.

**Run:**

```sh
cd "$SANDBOX"
codex
```

Prompt 1:

```
Run `npm test` and explain the failure.
```

Prompt 2:

```
Fix the rounding bug in src/invoice.ts so the test passes, then run the tests again to confirm.
```

Prompt 3:

```
Update README.md to document the rounding behavior you just fixed.
```

**Verify:** the newest file under `~/.codex/sessions/<YYYY>/<MM>/<DD>/` is a
`rollout-<ts>-<uuid>.jsonl` containing at least one `patch_apply_end` and one
`token_count`:

```sh
grep -c 'patch_apply_end\|token_count' "$(ls -t ~/.codex/sessions/*/*/*/rollout-*.jsonl | head -1)"
```

**Record:**

```sh
pnpm cassette:record --source codex --scenario tool-loop-with-reasoning \
  --session <uuid>
# …or, for the envelope-only variant:
pnpm cassette:record --source codex --scenario short-turn-with-usage-limit \
  --session <uuid>
```

---

### `copilot-cli/turn-with-tool-failure` — recorded

**Shape:** a `session-state/<sessionId>/events.jsonl` carrying
`session.start`, paired `assistant.turn_start` / `assistant.turn_end`, a
`tool.execution_start` whose matching `tool.execution_complete` reports a
failure, and a `session.model_change`.

**Run:**

```sh
cd "$SANDBOX"
copilot
```

Prompt 1:

```
Run `npm test` and summarize the failure.
```

Prompt 2 — the failing tool call:

```
Run `npm run typecheck`.
```

Prompt 3:

```
Fix the rounding bug in src/invoice.ts and re-run the tests.
```

**Verify:** the newest `~/.copilot/session-state/<id>/events.jsonl` contains a
`tool.execution_complete` whose payload reports a non-zero exit.

**Record:**

```sh
pnpm cassette:record --source copilot-cli --scenario turn-with-tool-failure \
  --session <sessionId>
```

---

### `copilot/vscode-chat-basic` — recorded

**Shape:** a `workspaceStorage/<id>/chatSessions/<uuid>.jsonl` — the
`initial` snapshot followed by `set`/`push` log records, which is the append
log `copilot-transcript.ts` replays.

VS Code Copilot Chat is a GUI extension, but `code chat` will start an agent
turn in an open window, which is enough to script the capture:

```sh
code -n "$SANDBOX"                                   # open the sandbox alone
sleep 10                                             # let the window settle
code chat -r -m agent "Fix the rounding bug in src/invoice.ts."
```

Each `code chat` invocation starts a *new* chat session rather than continuing
the last one, so a multi-request session still has to be built by hand in the
chat panel. One agent turn is enough for this scenario: it carries tool
invocations, thinking parts, and a text edit.

**By hand instead:**

1. `code "$SANDBOX"` — open the sandbox as the *only* folder in the window.
2. Open Copilot Chat, agent mode.
3. Send, one at a time, waiting for each to finish:

```
Run `npm test` and explain the failure.
```

```
Fix the rounding bug in src/invoice.ts.
```

```
Run the tests again to confirm the fix.
```

4. Close the window so the extension flushes its log.

**Verify:** exactly one workspace directory under
`~/Library/Application Support/Code/User/workspaceStorage/` has a
`workspace.json` whose `folder` points at `$SANDBOX`, and its `chatSessions/`
holds a `.jsonl` newer than the session you just ran.

**Record:**

```sh
pnpm cassette:record --source copilot --scenario vscode-chat-basic \
  --session <uuid> --producer-version "$(code --version | head -1)"
```

VS Code writes only a schema revision into the chat log, never its own version,
so the editor's version is passed in explicitly.

**What the sandbox rule cannot cover here.** VS Code renders the operator's
configuration into every chat request regardless of which folder is open, in two
distinct ways, and a capture against the sandbox carries both:

- `metadata.renderedUserMessage` and `metadata.renderedGlobalContext` hold the
  prompt *after* every instruction file, hook output, and global rule has been
  spliced in. A measured capture put four kilobytes of the operator's private
  skill definitions in the first. The redaction rules drop both subtrees; no
  code in this repository reads either, and the unrendered `message.text` beside
  them is the prompt the cassette exists to preserve.
- Every applicable instruction file is attached to the request as a content
  reference, so `~/.claude/rules/<name>.md` appears by path, by bare name
  (`prompt:<name>.md`), and often by stem in the model's own prose. The recorder
  maps these to `/Users/user-1/.agent-config/file-N.md` and renames the bare
  name and stem to match, and the `home-config` residue detector fails the
  recording if any survive.

Neither is a capture mistake to be fixed by re-running; they are properties of
the tool. Capturing in a throwaway profile (`code --user-data-dir <tmp>`) avoids
them, at the cost of signing in to Copilot again in that profile.

---

## After recording

The recorder prints a review summary before it writes: the identity table
(pseudonym → real value), per-file record counts, how many values were clipped,
and the ten longest free-text values. Read it. It is the last point at which
something unexpected is cheap to catch.

Then:

```sh
pnpm cassette:verify        # coverage, byte budget, hashes, manifest schema
pnpm test:unit              # L1 conformance, L2 goldens, hygiene scanners
pnpm cassette:bless:api     # only when the L3 projection changes; see below
pnpm test:e2e               # L3 replay against a real server
```

Each cassette's own `expected/parse.json` and `expected/scan.json` arrive
already blessed — the recorder invokes the same code path as
`pnpm cassette:bless`. The L3 projection is different: every `e2e` cassette is
materialized into *one* root and asserted as a combined dashboard, because
cross-source aggregation only exists when the sources are served together. It
therefore lives in one file, `test/cassettes/expected/api.json`, and adding or
re-recording any `e2e` cassette means re-running `pnpm cassette:bless:api`. If a later change to the scanners
moves them, re-bless explicitly and explain the diff in the pull request. That
diff is the entire point of the system.

## Adding a scenario

Cassettes are named for the *transcript shape* they exercise, not the task:
`fanout-with-subagents`, `long-single-turn`, `compaction-mid-session`,
`tool-failure-and-retry`, `interrupted-turn`. A reviewer should be able to
guess what a cassette covers from its name.

Add the scenario to this document — sandbox state, prompts, verification —
*before* recording it. A cassette whose capture is not written down cannot be
reproduced when the tool's format changes, which is exactly when you need to.

If the tool does not stamp a semantic version into its own records, the
manifest's `producer.version` reads `unknown`. Pass `--producer-version` so the
freshness check has something to compare against — VS Code Copilot Chat writes
only a schema revision, so its cassette needs `--producer-version "$(code
--version | head -1)"`.

## Re-recording

Re-record when a tool ships a format change, when the weekly freshness check
flags a stale `producer.version`, or when a scenario's shape stops matching its
name.

Re-recording the *same* session is byte-stable: pseudonyms are allocated by
order of first appearance, and every timestamp is shifted onto the fixed
`CASSETTE_CLOCK_ANCHOR` rather than onto the hour the recording happened. The
diff is one line, `capturedAt`. That is deliberate and load-bearing — with an
anchor derived from capture time, re-recording one unchanged session fifteen
minutes later shared no file bytes with the original, and no reviewer reads a
diff like that.

Re-recording a *new* session against the same scenario is a wholesale
replacement. That is expected and correct; review it as new data, not as a
diff.

## `--unsafe-adhoc`

For a bug that cannot be reproduced in the sandbox. It skips the "was this
session scripted?" check, stamps `"provenance": "adhoc"` into the manifest, and
requires the operator to acknowledge a review checklist.

An ad-hoc cassette is **local-only**. `pnpm cassette:verify` fails when a
committed manifest carries `"provenance": "adhoc"`, so it can be used to debug
and must not be checked in. If an ad-hoc capture turns out to be worth keeping,
reproduce its shape in the sandbox and add a scripted scenario instead.
