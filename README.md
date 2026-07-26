# liveclaudecode

A local, live Nuxt dashboard for Claude Code and OpenAI Codex sessions,
including the subagents they spawn. It reads the providers' append-only JSONL
transcripts directly from disk and combines them into one project-oriented
browser.

Use it to see the real run hierarchy, parallel timeline, current activity,
plans, diagnostics, changed files, command outcomes, and event feed. Every
session and agent is visibly tagged **Claude** or **Codex**, and the sidebar can
filter by provider and project.

The server is read-only, binds to localhost by default, performs no telemetry,
and needs no network access at runtime.

## Run it

Requirements: Node.js 22 or newer and pnpm 11.

```bash
pnpm install
./bin/liveclaudecode --open
```

From a source checkout, the launcher starts Nuxt in development mode. After a
production build it automatically uses the built Node server:

```bash
pnpm build
./bin/liveclaudecode --open
```

You can symlink the launcher onto your path:

```bash
ln -s ~/Projects/liveclaudecode/bin/liveclaudecode ~/bin/liveclaudecode
liveclaudecode --open
```

### Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `project` | all projects | Repository path or Claude project-storage slug; also filters Codex sessions to the matching working directory |
| `-p, --port` | `8787` | Port to bind |
| `--host` | `127.0.0.1` | Host to bind |
| `--hours` | `24` | Ignore transcripts older than this |
| `--open` | off | Open the viewer in a browser |

Examples:

```bash
liveclaudecode ~/code/other
liveclaudecode --hours 3
liveclaudecode --port 9000 --open
```

The storage roots can be overridden for tests or nonstandard installations:

```bash
LCC_CODEX_SESSIONS=/path/to/codex/sessions \
LCC_CLAUDE_PROJECTS=/path/to/claude/projects \
./bin/liveclaudecode
```

`LCC_PROJECT` can separately hold a repository path or Claude project-storage
slug to restrict both providers to one project.

## What it shows

- **Combined session browser:** recent Claude and Codex sessions grouped by
  working directory, with a single recency ordering and provider/project filters.
- **Run tree:** sessions and subagents nested by recorded spawn parentage.
- **Agent timeline:** a lane per agent, positioned by actual start and end time.
- **Live status:** agents with an active task or tool call and their current tool.
- **Plan and phases:** the latest todo state and phase markers across a run.
- **Diagnostics:** explicit API/tool failures, denials, aborts, native timing when
  available, context/cache pressure, compaction boundaries, and agent summaries.
- **Changed work:** files written across the run and command outcomes per agent.
- **Event feed:** compact, normal, and raw densities with an errors-only filter.

Fields that a provider does not record are left empty. The viewer does not
decrypt Codex encrypted reasoning or infer private content from unrelated stores.

## Storage support

Claude Code sessions are read from:

```text
~/.claude/projects/<slugified-cwd>/<session-id>.jsonl
~/.claude/projects/<slugified-cwd>/<session-id>/subagents/<agent-id>.jsonl
~/.claude/projects/<slugified-cwd>/<session-id>/subagents/<agent-id>.meta.json
```

Codex CLI, Codex Desktop, `codex exec`, automations, and spawned Codex agents all
write the same rollout family under:

```text
~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<session-id>.jsonl
```

Codex subagent links come from the structured `session_meta.payload.source`
thread-spawn metadata. Project grouping uses recorded working directories.
Projectless sessions are retained in an **Unassigned** group. Duplicate Codex
rollouts with the same session id are deduplicated by newest file modification
time.

The complete local-storage investigation, evidence, schema notes, and supported
versus unsupported sources are in
[`docs/session-storage-discovery.md`](docs/session-storage-discovery.md).
Notably, prompt-history files and browser caches are not treated as canonical
transcripts, and ordinary cloud ChatGPT conversations are out of scope.

## Architecture

```text
app/
  components/       provider-neutral Vue dashboard components
  composables/      polling, selection, and combined filtering state
  utils/            display and pure session-filter helpers
server/
  api/              thin Nitro/Effect adapters
  utils/            provider adapters, transcript scans, and unified catalog
shared/
  schemas/          Effect Schema definitions for external transcript data
  types/            shared API and domain contracts
test/
  unit/             schema, parser, hierarchy, catalog, filter, and CLI tests
  nuxt/             mounted component behavior
  e2e/              built server/API integration tests with synthetic JSONL
  fixtures/         synthetic Claude and Codex transcript builders
```

`TranscriptScan` and `CodexTranscriptScan` cache each parsed file and ingest only
complete new lines. A trailing line without a newline is considered an
in-progress append. The unified server catalog loads each provider independently,
so missing or malformed storage for one provider is reported without hiding the
other provider's sessions.

The browser polls three read-only endpoints:

| Endpoint | Returns |
| --- | --- |
| `/api/tree` | Combined recent projects, run trees, and provider health |
| `/api/run?project=&key=` | Timeline, files, phases, and diagnostics |
| `/api/events?project=&key=&since=` | Incremental events after index `since` |

This application must run as a Node server on the same machine as the local
transcripts. Static, edge, or remote deployments cannot read them.

## Development and testing

```bash
pnpm dev          # Nuxt development server
pnpm test         # all Vitest projects
pnpm test:unit    # schemas, parsers, hierarchy, catalog, filters, CLI
pnpm test:nuxt    # Nuxt-mounted component behavior
pnpm test:e2e     # real Nitro endpoints with synthetic JSONL fixtures
pnpm test:types   # strict Nuxt/Vue TypeScript checks
pnpm build        # production Node server build
pnpm check        # tests, typecheck, and production build
```

Automated tests never depend on private real sessions. They construct synthetic
Claude and Codex rollouts and cover complete and partial lines, malformed and
unknown records, tool/result pairing, active updates, spawn hierarchy, project
grouping, deduplication, combined filters, diagnostics, pagination, and source
failure isolation.

## Limitations and privacy

- The client polls rather than watching the filesystem.
- Both transcript formats are internal and may change; unknown record kinds are
  skipped, while malformed known records degrade the source health indicator.
- Some fields are provider-specific. Codex currently does not expose Claude's
  native turn-duration or agent-outcome records, so those panels are empty.
- Command success is shown only when the transcript records an explicit outcome;
  no result is treated as unknown, not success.
- Local transcripts can contain prompts, tool arguments, file paths, and outputs.
  Run the server on a trusted machine and keep its default localhost binding.
- Cloud-only chats, prompt-history indexes, Chromium caches, and generic desktop
  metadata are intentionally unsupported because they are incomplete or not a
  stable canonical session store.

## License

MIT
