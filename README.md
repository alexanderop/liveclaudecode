# liveclaudecode

A live Nuxt dashboard for a running Claude Code session—including every
subagent it spawns—read directly from the JSONL transcripts on disk.

When you start a long orchestration run, the terminal shows one stream. This
viewer shows the complete run: its real agent hierarchy, parallel timeline,
current activity, announced phases, changed files, command outcomes, and event
feed.

The server is read-only, binds to localhost by default, performs no telemetry,
and needs no network access at runtime.

## Run it

Requirements: Node.js 22 or newer and pnpm.

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
| `project` | all projects | Repository path, transcript directory, or slug under `~/.claude/projects` |
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

## What it shows

- **Run tree:** sessions and subagents nested by their real spawn hierarchy.
- **Agent timeline:** a lane per agent, positioned by actual start and end time.
- **Live status:** which agents are active and which tool is currently in flight.
- **Plan and phases:** the latest todo state and phase markers merged across the run.
- **Diagnostics:** explicit API/tool failures, denials, timeouts, native turn timing,
  context/cache pressure, compaction boundaries, causal branching, and agent receipts.
- **Changed work:** files written across the run and command outcomes per agent.
- **Change provenance:** structured line deltas plus detected commits, pushes, branches,
  and pull requests linked back to the responsible agent.
- **Event feed:** compact, normal, and raw densities with an errors-only filter.

The viewer can follow the currently active agent while keeping the run-wide
header and timeline stable. A separate control follows new event output.

## Architecture

The port follows Nuxt 4's application/server/shared structure, modeled after
the conventions used by [npmx.dev](https://github.com/npmx-dev/npmx.dev):

```text
app/
  components/       Vue dashboard components
  composables/      polling and selection state
  pages/            file-based routes
  utils/            display-only helpers
server/
  api/              Nitro API endpoints
  utils/            transcript parsing and run aggregation
shared/
  types/            API and domain contracts shared by client and server
test/
  unit/             fast Node tests
  nuxt/             Nuxt-aware component tests
  e2e/              built server/API integration tests
  fixtures/         synthetic transcript builders
```

Claude Code appends JSON Lines under
`~/.claude/projects/<slugified-cwd>/`:

```text
<session-id>.jsonl
<session-id>/subagents/<agent-id>.jsonl
<session-id>/subagents/<agent-id>.meta.json
```

`TranscriptScan` caches the parsed view of each file and only ingests complete
lines it has not seen before. A trailing line without a newline is treated as
an in-progress write. `runs.ts` resolves parentage through each subagent's
`toolUseId` and rolls subtree totals onto every node.

The browser polls three read-only endpoints:

| Endpoint | Returns |
| --- | --- |
| `/api/tree` | Every recent run in the project, nested |
| `/api/run?key=` | Timeline lanes, files written, and merged phases |
| `/api/events?key=&since=` | New transcript events after index `since` |

This application must run as a Node server on the same machine as the Claude
Code transcripts. Static, edge, or remote deployments cannot read those local
files.

## Development and testing

```bash
pnpm dev          # Nuxt development server
pnpm test         # all Vitest projects
pnpm test:unit    # parser, hierarchy, project resolution, CLI
pnpm test:nuxt    # Nuxt-mounted component behavior
pnpm test:e2e     # real Nitro endpoints with synthetic JSONL fixtures
pnpm test:types   # strict Nuxt/Vue TypeScript checks
pnpm build        # production Node server build
```

Tests never depend on a real Claude Code session. They construct synthetic
transcripts and cover the subtle behavior: partial trailing lines, malformed
records, tool/result pairing, current activity, spawn hierarchy, phase
precedence, subtree totals, incremental event pagination, and API errors.

## Limitations

- The client polls rather than watching the filesystem.
- Command success is inferred from output text and is only a hint.
- Phase detection reads the agents' own prose.
- Claude Code's transcript format is internal and may change.

## License

MIT
