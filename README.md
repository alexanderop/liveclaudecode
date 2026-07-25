# liveclaudecode

A live web view of a running Claude Code session — including every subagent it
spawns — read straight from the JSONL transcripts on disk.

When you kick off something long (`/implement`, `/ship`, a fan-out of workers)
the terminal shows you one stream. This shows you the whole run: who is
working, what they are running right now, what phase the orchestrator thinks
it is in, which files have changed, and which commands passed or failed.

No dependencies, no telemetry, no network. Reads `~/.claude/projects/**.jsonl`
and never writes to them.

```bash
python3 -m liveclaudecode          # in your repo; opens on :8787
```

## What it shows

**Run tree** — sessions and the subagents they spawned, nested by their real
spawn hierarchy. Each subagent transcript records the `toolUseId` of the Agent
call that created it, so the parent is whichever transcript issued that call.
Green pulse means the file is still being written to.

**Agent timeline** — a lane per agent, bars placed by actual start and end
time. Parallel waves are obvious at a glance: four bars starting together are
four workers dispatched in one wave. Green bar = running, red = hit errors.

**Status line** — one sentence of plain language: which agents are working and
what the active one is running right now, derived from the tool call that has
no result yet.

**Plan & phases** — the live `TodoWrite` checklist, plus phases announced
anywhere in the run, merged in time order. Explicit `Wave 1` / `Slice B` /
`Phase 2` markers win over incidental bold headings, so an orchestrator's plan
does not get buried under its workers' report formatting.

**What it changed** — every file written across the run with edit counts, and
each agent's shell commands with pass/fail inferred from their output.

**Feed** — the message stream at three densities: `compact` (one line per
action), `normal` (cards with expandable tool input and results), `raw`
(including system reminders). Errors expand by default; "errors only" filters
to just those.

## Usage

```bash
python3 -m liveclaudecode                  # transcripts for the current directory
python3 -m liveclaudecode ~/code/other     # another repo
python3 -m liveclaudecode --hours 3        # only runs touched in the last 3 hours
python3 -m liveclaudecode --port 9000 --open
```

Install it if you want it on your PATH:

```bash
pip install -e .
liveclaudecode --open      # or: lcc --open
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `project` | current directory | repo path, or a slug under `~/.claude/projects` |
| `-p, --port` | `8787` | port to bind |
| `--host` | `127.0.0.1` | bind address — localhost only by default |
| `--hours` | `24` | ignore transcripts older than this |
| `--open` | off | open a browser window |

Two toggles are worth knowing: **follow the active agent** keeps the feed on
whichever agent in *this run* is currently writing while the header and
timeline stay put, and **follow output** pins the feed to the newest message.

## How it works

Claude Code appends JSON Lines to `~/.claude/projects/<slugified-cwd>/`:

```
<session-id>.jsonl
<session-id>/subagents/<agent-id>.jsonl
<session-id>/subagents/<agent-id>.meta.json   # agentType, description, toolUseId
```

`Scan` (in `transcript.py`) keeps a parsed view of one file and only reads the
lines appended since the last poll, so watching a 2 MB transcript costs almost
nothing. A trailing line without a newline is a record mid-write, so it is left
for the next pass rather than parsed as broken JSON.

`runs.py` builds the tree, resolves parents through `toolUseId`, and rolls
subtree totals (agents, tools, errors, files) onto every node. `server.py`
exposes three read-only JSON endpoints that the page polls every 2–6 seconds:

| Endpoint | Returns |
| --- | --- |
| `/api/tree` | every run in the project, nested |
| `/api/run?key=` | timeline lanes, files written, merged phases |
| `/api/events?key=&since=` | transcript events after index `since` |

The page survives the server restarting: fetches never throw, and an offline
badge appears until it reconnects.

## Development

```bash
python3 -m unittest discover -s tests -t .   # 43 tests, no dependencies
```

Tests build synthetic transcripts (`tests/fixtures.py`) rather than depending
on a real session, and cover the parts that are easy to get subtly wrong:
incremental reads against a file being appended to, half-written trailing
lines, tool-call/result pairing, spawn-hierarchy resolution, and phase-marker
precedence.

The UI is plain HTML/CSS/JS in `liveclaudecode/static/` — no build step. Edit
and reload.

## Limitations

- Polling, not file watching. Fine for one project; would want inotify/FSEvents
  for hundreds of transcripts.
- Command pass/fail is inferred from output text, so it is a hint, not a truth.
- Phase detection reads the agent's own prose. Agents that never announce
  phases show only their todos.
- Transcript layout is Claude Code's internal format and may change.

## License

MIT
