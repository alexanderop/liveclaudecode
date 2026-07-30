# liveclaudecode

A local, live Nuxt dashboard for Claude Code, OpenAI Codex, GitHub Copilot CLI,
and VS Code GitHub Copilot Chat sessions, including subagents providers explicitly record. It
reads the providers' local JSONL transcripts directly from disk and combines
them into one project-oriented browser.

Use it to see the real run hierarchy, parallel timeline, current activity,
plans, diagnostics, changed files, command outcomes, and event feed. Every
session and agent is visibly tagged **Claude**, **Codex**, or **Copilot**, and the sidebar can
filter by provider and project.

The observer APIs are read-only, bind to localhost by default, perform no
telemetry, and need no network access at runtime. The optional **Ask** panel
launches a user-selected local coding agent with full permissions, which may
modify local files, run commands, and contact its configured model provider.

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
| `--hours` | `168` (7 days) | Ignore transcripts older than this |
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
LCC_COPILOT_SESSIONS=/path/to/copilot/session-state \
LCC_VSCODE_USER_DATA='/path/to/Code/User:/path/to/Code - Insiders/User' \
./bin/liveclaudecode
```

`LCC_PROJECT` can separately hold a repository path or Claude project-storage
slug to restrict all providers to one project.

### Ask a local agent about a session

Open a session and select **Ask** (keyboard shortcut `Q`) to start a follow-up
conversation backed by ACP, the Agent Client Protocol. Claude and Codex are
available through adapters, and GitHub Copilot is available through Copilot
CLI's native ACP server. A separate ACP conversation remains attached to the
observed session while the panel is closed, and **New** discards it.

By default the server launches these local ACP agents on demand:

```text
npx -y @agentclientprotocol/claude-agent-acp
npx -y @agentclientprotocol/codex-acp
copilot --acp --stdio --allow-all
```

The first Claude or Codex use can therefore download an adapter. Claude uses
the machine's existing Claude credentials; Codex uses its existing login or
API-key environment. Copilot requires the `copilot` command to be installed and
authenticated. Launch commands can be overridden when an executable is
installed or lives somewhere else:

```bash
LCC_ACP_CLAUDE='claude-agent-acp' \
LCC_ACP_CODEX='codex-acp' \
LCC_ACP_COPILOT='copilot --acp --stdio --allow-all' \
./bin/liveclaudecode
```

Ask approves every ACP permission request. Codex starts in
`agent-full-access` mode, and Copilot CLI starts with `--allow-all`. The ACP
client still advertises no client-hosted filesystem or terminal capabilities
because each coding agent uses its own local tools. Run Ask only on a trusted
computer: its agents have the operating-system permissions of the dashboard
process.

## What it shows

- **Combined session browser:** recent Claude, Codex, and Copilot sessions grouped by
  working directory, with provider/project filters plus subagent-count filtering
  and sorting.
- **Run tree:** sessions and subagents nested by recorded spawn parentage.
- **Agent canvas:** dimension-aware ranked branches, expandable workstream
  summaries, direct child counts, and a minimap for dense all-agent views.
- **Agent timeline:** a lane per agent, positioned by actual start and end time.
- **Live status:** agents with an active task or tool call and their current tool.
- **Plan and phases:** the latest todo state and phase markers across a run.
- **Diagnostics:** explicit API/tool failures, denials, aborts, native timing when
  available, context/cache pressure, compaction boundaries, and agent summaries.
- **Changed work:** files written across the run and command outcomes per agent.
- **Event feed:** compact, normal, and raw densities with an errors-only filter.
- **Session chat:** follow-up questions answered by a local Claude, Codex, or
  Copilot ACP agent with full tool permissions and the selected transcript as
  context.

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

GitHub Copilot CLI sessions are read from their append-only local event logs:

```text
~/.copilot/session-state/<session-id>/events.jsonl
```

The working directory and Git metadata come from the recorded `session.start`
event. VS Code GitHub Copilot Chat sessions are also read from VS Code-owned
version-3 snapshot/delta logs under Stable, Insiders, and profile storage:

```text
~/Library/Application Support/Code/User/workspaceStorage/*/chatSessions/*.jsonl
~/Library/Application Support/Code/User/globalStorage/emptyWindowChatSessions/*.jsonl
~/Library/Application Support/Code - Insiders/User/{workspaceStorage,globalStorage}/...
```

Workspace association comes from `workspace.json` or a recorded working
directory. Empty-window and unidentified sessions remain under **Unassigned**.
Only VS Code sessions with explicit GitHub Copilot responder or participant
metadata are included; generic VS Code chat and derivative edit/resource stores
are not. The sidebar date-range filter can switch between 24 hours, 7 days,
30 days, and all locally retained history without restarting the server.

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
  browser/          production hydration, accessibility, and keyboard smoke tests
  fixtures/         synthetic Claude, Codex, and Copilot transcript builders
```

The provider transcript scans cache each parsed file and ingest only
complete new lines. A trailing line without a newline is considered an
in-progress append. The unified server catalog loads each provider independently,
so missing or malformed storage for one provider is reported without hiding the
other providers' sessions. Copilot event polling refreshes only the selected
CLI or VS Code session file rather than rescanning every storage root.

The browser polls three read-only endpoints:

| Endpoint | Returns |
| --- | --- |
| `/api/tree` | Combined recent projects, run trees, and provider health |
| `/api/run?project=&key=` | Timeline, files, phases, and diagnostics |
| `/api/events?project=&key=&since=` | Incremental events after index `since` |
| `GET /api/chat?project=&key=&since=` | Incremental chat events after index `since` |
| `POST /api/chat` | Send, cancel, or reset a session chat |

This application must run as a Node server on the same machine as the local
transcripts. Static, edge, or remote deployments cannot read them.

## Development and testing

```bash
pnpm dev          # Nuxt development server
pnpm test         # all Vitest projects
pnpm test:unit    # schemas, parsers, hierarchy, catalog, filters, CLI
pnpm test:nuxt    # Nuxt-mounted component behavior
pnpm test:e2e     # real Nitro endpoints with synthetic JSONL fixtures
pnpm test:browser # production Chromium smoke test with synthetic JSONL
pnpm test:types   # strict Nuxt/Vue TypeScript checks
pnpm build        # production Node server build
pnpm check        # tests, typecheck, production build, and browser smoke test
```

Automated tests never depend on private real sessions. They construct synthetic
Claude, Codex, and Copilot logs and cover complete and partial lines, malformed and
unknown records, tool/result pairing, active updates, spawn hierarchy, project
grouping, deduplication, combined filters, diagnostics, pagination, and source
failure isolation. The production-browser smoke test blocks external requests and
fails on Vue hydration mismatches.

## Limitations and privacy

- The client polls rather than watching the filesystem.
- The transcript formats are internal and may change; unknown record kinds are
  skipped, while malformed known records degrade the source health indicator.
- Some fields are provider-specific. Codex and Copilot do not expose every
  Claude-native timing or agent-outcome record, so unsupported panels stay empty.
- Command success is shown only when the transcript records an explicit outcome;
  no result is treated as unknown, not success.
- Local transcripts can contain prompts, tool arguments, file paths, and outputs.
  Run the server on a trusted machine and keep its default localhost binding.
- Asking a question starts the selected ACP adapter and can send the question,
  transcript evidence, and referenced file contents to that agent's configured
  model provider. Ask agents can also modify local files and run commands with
  the dashboard process's permissions. No agent process starts until a message
  is sent.
- Cloud-only chats, prompt-history indexes, Chromium caches, and generic desktop
  metadata are intentionally unsupported because they are incomplete or not a
  stable canonical session store.

## License

MIT
