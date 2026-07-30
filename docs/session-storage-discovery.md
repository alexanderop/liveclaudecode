# Local session storage discovery

Investigation date: 2026-07-26 (Europe/Berlin)

This document records the read-only storage investigation performed before
adding Codex and VS Code GitHub Copilot Chat support to `liveclaudecode`. The
investigation was intentionally targeted at Claude, Codex, OpenAI, ChatGPT,
VS Code, and GitHub Copilot locations. It inspected directory
structures, filenames, file metadata, JSON key/type shapes, SQLite schemas, and
process open-file information. It did not copy full prompts, responses,
credentials, cookies, account records, or attachment contents.

Counts and versions below are a point-in-time snapshot from this Mac. Active
applications continued appending records while the investigation ran.

## Decision summary

| Source | Canonical location | Decision | Reason |
| --- | --- | --- | --- |
| Claude Code CLI and Claude Code integrations | `/Users/alexanderopalic/.claude/projects` | Supported | Complete, append-only JSONL transcripts with project paths, messages, tools, agents, diagnostics, and file activity are directly readable. This is the application's existing source. |
| Codex CLI, Codex desktop tasks, automations, exec sessions, and Codex subagents | `/Users/alexanderopalic/.codex/sessions` | Supported as one Codex source | All observed producers write the same date-partitioned rollout JSONL format. Session metadata identifies the producer, project, session ID, and subagent parent. |
| Codex SQLite/index metadata | `/Users/alexanderopalic/.codex/state_5.sqlite` and `/Users/alexanderopalic/.codex/session_index.jsonl` | Ancillary evidence; not a second displayed source | These records index the same rollout session IDs and paths. Displaying them separately would duplicate conversations. The rollout remains the canonical event source. |
| Claude prompt history | `/Users/alexanderopalic/.claude/history.jsonl` | Not a session source | It contains prompt-history entries only, not complete assistant/tool transcripts, and duplicates canonical Claude sessions by `sessionId`. |
| Codex prompt history | `/Users/alexanderopalic/.codex/history.jsonl` | Not a session source | It contains prompt text and a session ID only, is incomplete compared with rollouts, and duplicates canonical Codex sessions. |
| Claude desktop Claude Code session metadata | `/Users/alexanderopalic/Library/Application Support/Claude/claude-code-sessions` | Not a transcript source | Small JSON files contain desktop/session settings and pointers such as `cliSessionId`; they do not contain complete conversation events and may describe the same Claude Code sessions. |
| ChatGPT/Codex Chromium profile data | `/Users/alexanderopalic/Library/Application Support/Codex` | Not a conversation source | The profile contains browser history, cache, cookies, Local/Session Storage, and LevelDB data, but no complete, stable, conversation-specific local store was found. Reading it would also cross credential and cookie boundaries. |
| Ordinary ChatGPT conversations | No complete local store found | Unsupported | The installed desktop bundle is `com.openai.codex` and its native Codex app server writes supported Codex tasks to `~/.codex`. Ordinary ChatGPT chats appear cloud-backed or opportunistically cached in browser storage, not completely and stably stored in a safe local format. |
| GitHub Copilot CLI sessions | `/Users/alexanderopalic/.copilot/session-state/*/events.jsonl` | Supported | Copilot CLI writes append-only JSONL with session context, user/assistant messages, tool lifecycle events, model changes, and turn boundaries. The `session.start` event records the session ID and working directory. |
| VS Code-owned local chat session logs | `/Users/alexanderopalic/Library/Application Support/Code/User/{workspaceStorage,globalStorage}` and the corresponding `Code - Insiders` root | Supported only when Copilot metadata is explicit | VS Code writes complete version-3 chat snapshots plus append-only deltas to per-session JSONL. The installed VS Code source contains the replay algorithm. Session responder/participant metadata can identify GitHub Copilot without reading credentials. |
| VS Code `state.vscdb` chat index | Per-workspace `state.vscdb` under Stable and Insiders `workspaceStorage` | Index only; not displayed separately | `chat.ChatSessionStore.index` indexes the same JSONL sessions. It is mutable SQLite state and would duplicate canonical JSONL. |
| VS Code `chatEditingSessions` and extension resource folders | Per-workspace `chatEditingSessions` and `GitHub.copilot-chat` directories | Unsupported as conversation sources | These are derivative edit snapshots, working contents, or referenced resources. Reading them is unnecessary for the conversation and could expose unrelated file contents. |
| GitHub Copilot extension global storage | Stable/Insiders `User/globalStorage/github.copilot-chat` | Unsupported as a conversation source | Observed files are embeddings, agent definitions, CLI shims/metadata, debug helpers, and diff indexes rather than canonical VS Code chat conversations. |

The integration therefore treats Claude Code, Codex rollouts, and GitHub
Copilot logs as three provider sources. Copilot CLI and explicitly identified
VS Code GitHub Copilot Chat logs are producer variants of the Copilot source;
Codex CLI and desktop are producer variants of the Codex source.

## Claude Code

### Canonical transcripts

Absolute root:

```text
/Users/alexanderopalic/.claude/projects
```

Observed layout (identifiers sanitized):

```text
~/.claude/projects/<slugified-absolute-cwd>/
  <session-uuid>.jsonl
  sessions-index.json
  <session-uuid>/subagents/<agent-id>.jsonl
  <session-uuid>/subagents/<agent-id>.meta.json
```

At discovery time, the root contained 262 top-level JSONL transcripts and 21
`sessions-index.json` files. The owning CLI was
`/Users/alexanderopalic/.local/bin/claude`, version `2.1.220`. Claude desktop
also bundles Claude Code binaries under:

```text
/Users/alexanderopalic/Library/Application Support/Claude/claude-code/2.1.219
/Users/alexanderopalic/Library/Application Support/Claude/claude-code-vm/2.1.219
```

The project directory name is Claude's slugification of the absolute working
directory. Transcript records additionally carry `cwd`, `sessionId`, ISO-8601
`timestamp`, `gitBranch`, `version`, UUID parentage, and entrypoint metadata, so
project association does not have to rely only on the slug.

Sanitized record shapes include:

```json
{"type":"user","timestamp":"<iso>","sessionId":"<uuid>","cwd":"/project","message":{"role":"user","content":[{"type":"text","text":"<redacted>"}]}}
{"type":"assistant","timestamp":"<iso>","sessionId":"<uuid>","message":{"role":"assistant","model":"<model>","content":[{"type":"tool_use","id":"<id>","name":"Edit","input":{"file_path":"<path>"}}]}}
{"type":"user","timestamp":"<iso>","message":{"content":[{"type":"tool_result","tool_use_id":"<id>","content":"<redacted>"}]}}
{"type":"system","subtype":"turn_duration","timestamp":"<iso>","durationMs":1234}
```

The format also includes file-history records, session state (`ai-title`,
`last-prompt`, `mode`, `permission-mode`), compaction boundaries, workflow
records, permission denials, and stop-hook summaries. Subagent metadata supplies
the agent type, description, and spawning tool-use ID. UUID and tool-use
relationships preserve causal and spawn hierarchy.

`sessions-index.json` has `version`, optional `originalPath`, and `entries`.
Each entry contains `sessionId`, `fullPath`, `fileMtime`, `firstPrompt`, optional
`summary`, `messageCount`, `created`, `modified`, `gitBranch`, `projectPath`, and
`isSidechain`. It is useful metadata but is not treated as a second copy of the
conversation.

### Completeness, incremental updates, and stability

The JSONL transcript is the complete local execution log observed by the
existing application. Claude appends records while a session is active. File
size and modification time detect change; a last line without a newline is an
in-progress write and must not be decoded until complete. The existing
`TranscriptScan` implements incremental, complete-line parsing and caches by
file size/mtime inside an Effect service layer.

The format is internal and additive rather than a published compatibility
contract. Unknown record and content-block types must be retained or skipped
gracefully. Files are normal user-readable files (the root is mode `0700`, and
prompt history is `0600`); no encryption bypass or credential access is needed.
`liveclaudecode` must continue to open them read-only and must never inspect
Claude authentication/configuration files for this feature.

### Non-canonical Claude stores

`/Users/alexanderopalic/.claude/history.jsonl` contains entries shaped like
`{ display, pastedContents, timestamp, project, sessionId }`. It is prompt
history only and not a complete transcript.

`/Users/alexanderopalic/Library/Application Support/Claude/claude-code-sessions`
contained 33 small JSON files (about 320 KiB total) with fields such as
`sessionId`, `cliSessionId`, `cwd`, timestamps, title, model, permissions,
completed-turn count, worktree/PR metadata, and sometimes
`transcriptUnavailable`. These files are written by Claude desktop, can contain
permission and MCP configuration, and contain no assistant/tool event stream.
They are not read by the integration.

Claude desktop also has an IndexedDB store under
`/Users/alexanderopalic/Library/Application Support/Claude/IndexedDB`. It is a
web cache for `claude.ai`, not the canonical Claude Code transcript tree, and is
outside this integration's safe support scope.

## OpenAI Codex

### Canonical rollouts

Absolute root:

```text
/Users/alexanderopalic/.codex/sessions
```

Observed layout:

```text
~/.codex/sessions/YYYY/MM/DD/
  rollout-YYYY-MM-DDTHH-MM-SS-<thread-uuid>.jsonl
```

The snapshot contained 640 JSONL rollouts (about 432 MiB). A concurrently
updated SQLite index contained 641 unique thread IDs and 641 unique rollout
paths, demonstrating that index updates and file creation can briefly race.
Every indexed thread had a rollout path.

The first record is `session_meta`. A sanitized example is:

```json
{"timestamp":"<iso>","type":"session_meta","payload":{"id":"<uuid>","timestamp":"<iso>","cwd":"/project","originator":"Codex Desktop","cli_version":"<version>","source":"vscode","thread_source":"user","model_provider":"openai","git":{"branch":"<branch>","commit_hash":"<sha>","repository_url":"<redacted>"}}}
```

Observed top-level record families and representative payloads:

```json
{"type":"turn_context","payload":{"turn_id":"<uuid>","cwd":"/project","model":"<model>","effort":"<effort>","approval_policy":"<mode>","sandbox_policy":{},"workspace_roots":[]}}
{"type":"response_item","payload":{"type":"message","role":"user|assistant|developer","content":[{"type":"input_text|output_text","text":"<redacted>"}]}}
{"type":"response_item","payload":{"type":"function_call","name":"<tool>","call_id":"<id>","arguments":"<redacted-json>"}}
{"type":"response_item","payload":{"type":"function_call_output","call_id":"<id>","output":"<redacted>"}}
{"type":"response_item","payload":{"type":"custom_tool_call","name":"<tool>","call_id":"<id>","input":"<redacted>"}}
{"type":"event_msg","payload":{"type":"token_count","info":{},"rate_limits":{}}}
```

Other observed payload types include reasoning (with optional encrypted
content), agent reasoning/messages, task start/finish, user messages, goal and
plan updates, tool approval events, tool results, errors, compaction/context
events, and world-state snapshots. Unknown payload types are expected as Codex
evolves.

The `session_meta.source` value distinguishes `cli`, `vscode`, `exec`, and a
structured subagent source. The structured form includes the parent thread ID,
depth, agent path, nickname, and role. In the SQLite metadata snapshot, 169
child threads had explicit spawn edges (140 open and 29 closed), which
corroborates the source-embedded hierarchy.

Observed producers in rollout metadata included:

- `codex-tui` with source `cli`;
- `Codex Desktop` and `codex_work_desktop` with source `vscode`;
- `codex_exec` with source `exec`;
- structured subagent sources with parent thread IDs;
- desktop `thread_source` values `user` and `automation`.

The running `/Applications/ChatGPT.app` process launched
`/Applications/ChatGPT.app/Contents/Resources/codex ... app-server`. `lsof`
showed that process holding multiple files in `~/.codex/sessions` open for
append, including the active desktop tasks. This directly establishes ownership
for desktop-created Codex rollouts. CLI metadata independently identifies
`codex-tui` as the producer for CLI sessions.

### Metadata indexes and duplicates

`/Users/alexanderopalic/.codex/state_5.sqlite` is a readable SQLite database.
Its relevant tables are:

```text
threads(id PRIMARY KEY, rollout_path, created_at[_ms], updated_at[_ms],
        recency_at[_ms], source, thread_source, model_provider, cwd, title,
        preview, sandbox_policy, approval_mode, tokens_used, archived,
        git metadata, cli_version, model, reasoning_effort, agent metadata, ...)
thread_spawn_edges(parent_thread_id, child_thread_id PRIMARY KEY, status)
thread_dynamic_tools(thread_id, position, name, description, input_schema, ...)
backfill_state(...)
```

The database is a mutable index, not an additional logical conversation store.
At discovery time its 641 rows had 641 unique IDs and 641 unique rollout paths.
The supported adapter deduplicates on the rollout/session ID and does not show a
separate SQLite entry.

`/Users/alexanderopalic/.codex/session_index.jsonl` contained 190 records shaped
as `{ id, thread_name, updated_at }`. It is a partial title index and also refers
to the same IDs. It may enrich a rollout title but cannot establish completeness
or replace rollouts.

Copies under `/Users/alexanderopalic/.codex/sqlite` had closely related schemas,
including a development database with local thread catalog and timeline ledger
tables. These are application/internal indexes, can lag or migrate, and are not
treated as distinct sessions.

### Completeness, incremental updates, and stability

Rollouts contain the complete locally recorded task event stream for the Codex
sessions observed here. Writers append JSONL records during an active task.
File size/mtime and complete-line ingestion are sufficient for polling-based
updates. A session can be considered active when its last event is recent and/or
the indexed spawn state or task events have not closed it; live status must be a
hint because an abandoned process may leave no explicit final record.

The outer envelope (`timestamp`, `type`, `payload`) is consistent across CLI,
desktop, exec, and subagents, but payloads are internal, additive, and versioned
only indirectly through `cli_version`. External data must be decoded with Effect
Schema, unknown event types tolerated, malformed lines reported without taking
down other sessions, and incomplete trailing lines deferred.

The rollout and metadata files are readable without decrypting anything or
accessing credentials. The integration must never read
`/Users/alexanderopalic/.codex/auth.json`, cookies, OAuth locks, browser login
databases, shell snapshots, memories, or attachment bodies. Reasoning records
may contain opaque encrypted content; the adapter must not attempt to decrypt
it.

## ChatGPT desktop and ordinary ChatGPT chats

The installed app at `/Applications/ChatGPT.app` reported:

```text
CFBundleIdentifier = com.openai.codex
CFBundleShortVersionString = 26.721.41059
```

Its Chromium-based process uses this profile:

```text
/Users/alexanderopalic/Library/Application Support/Codex
```

The profile (about 311 MiB) contains standard Chromium artifacts: `Cache`,
`Cookies`, `Login Data`, `Local Storage/leveldb`, `Session Storage`, `History`,
`Web Data`, service-worker state, crash reports, and browser feature databases.
The `History` SQLite schema contains generic browser `urls`, `visits`,
`downloads`, and related tables; it has no conversation/message tables. A
targeted filename search found no conversation-, thread-, or chat-specific
JSON/JSONL/SQLite store (apart from an unrelated Sentry session file).

These browser artifacts can contain cookies, authentication state, account
information, and incomplete cached page data. They are neither a complete nor a
stable conversation API and may be evicted at any time. Parsing them would
couple the app to browser internals and cross the explicit security boundary.
They are not supported.

On this device, Codex desktop tasks launched from that app are fully represented
by the canonical `~/.codex/sessions` rollouts and are supported there. No
evidence established that ordinary ChatGPT cloud conversations are completely
stored locally. They are therefore explicitly excluded; the product must not
claim ordinary ChatGPT history support.

## GitHub Copilot CLI

Copilot CLI writes one append-only event log per session:

```text
~/.copilot/session-state/<session-id>/events.jsonl
```

Known events include `session.start`, `user.message`, `assistant.message`,
`tool.execution_start`, `tool.execution_complete`, model changes, and turn
boundaries. The adapter reads only complete JSONL lines, decodes external
records with Effect Schema, tolerates unknown event types, and derives project
association from `session.start.data.context.cwd`. It does not need to read
credentials or contact GitHub.

## VS Code GitHub Copilot Chat

### Locations and application variants inspected

The following absolute roots were inspected read-only:

```text
/Users/alexanderopalic/Library/Application Support/Code/User
/Users/alexanderopalic/Library/Application Support/Code - Insiders/User
/Users/alexanderopalic/.vscode/extensions
/Users/alexanderopalic/.vscode-insiders/extensions
/Applications/Visual Studio Code.app/Contents/Resources/app
/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app
```

VS Code Stable and Insiders both store workspace sessions at:

```text
<User>/workspaceStorage/<workspace-id>/chatSessions/<session-uuid>.jsonl
<User>/workspaceStorage/<workspace-id>/workspace.json
```

Empty-window sessions are stored at:

```text
<User>/globalStorage/emptyWindowChatSessions/<session-uuid>.jsonl
```

VS Code source also defines `globalStorage/transferredChatSessions` and a legacy
`workspaceStorage/no-workspace/chatSessions` migration source. The adapter reads
the former when present and naturally discovers the latter as a workspace entry.
It deduplicates migrated or copied files only when the decoded stable session ID
matches.

Profile-aware empty-window and workspace locations are supported at:

```text
<User>/profiles/<profile-id>/globalStorage/emptyWindowChatSessions/*.jsonl
<User>/profiles/<profile-id>/workspaceStorage/*/chatSessions/*.jsonl
```

On this device, Stable had no `profiles` directory. Insiders had a `profiles`
directory but no stored profile data at discovery time. This absence is normal
and does not degrade the source. Stable contained 24 workspace chat JSONL files
and no empty-window JSONL files; Insiders contained 155 workspace chat JSONL
files and 8 empty-window JSONL files. These are point-in-time counts, not
completeness guarantees.

`workspace.json` files used either `folder` (161 observed) or `workspace` (one
observed) and contained file URIs in the inspected sample. The adapter accepts
file URIs as local project paths and retains non-file remote or virtual URIs as
workspace identities without connecting to them. Unreadable, deleted, empty,
untitled, or unidentified workspaces are grouped as **Unassigned**. No remote
system was contacted during discovery.

### Ownership and canonical format

The installed VS Code workbench source defines `ChatSessionStore` itself. It
selects `workspaceStorage/<workspace-id>/chatSessions` for workspaces and
`globalStorage/emptyWindowChatSessions` for empty windows. It writes a JSONL log
using a `ChatModel` serializer and stores `chat.ChatSessionStore.index` in the
workspace SQLite state database. This establishes VS Code, rather than the
Copilot extension, as owner of the canonical local store.

The first JSONL record is a full version-3 snapshot:

```json
{"kind":0,"v":{"version":3,"sessionId":"<uuid>","creationDate":0,"responderUsername":"GitHub Copilot","requests":[],"pendingRequests":[]}}
```

Later complete lines are deltas:

```json
{"kind":1,"k":["requests",0,"result"],"v":{"<field>":"<redacted>"}}
{"kind":2,"k":["requests",0,"response"],"i":0,"v":[{"kind":"<part-kind>"}]}
{"kind":3,"k":["optionalField"]}
```

VS Code's installed replay code defines kind `0` as snapshot replacement,
kind `1` as path assignment, kind `2` as array truncate/append, and kind `3` as
path deletion. It compacts a long log by replacing it with another kind-0
snapshot. The adapter implements those exact operations, ignores an incomplete
trailing line, and resets replay when a compacted file shrinks.

Snapshot fields observed and supported include session ID, creation date,
custom title, responder name, initial location, working directory, pending edit
state, pending requests, and requests. Requests contain a stable request ID,
timestamp, user message, participant/agent metadata, mode, model, model state,
response parts, explicit result/error details, token metadata, elapsed time,
and edited-file events.

Supported response parts include Markdown, thinking, serialized tool
invocations, and text edit groups. Other structurally valid future kinds are
counted as unsupported events rather than malformed data. Tool records expose a
stable call ID, tool ID, completion flag, invocation/result labels, optional
result details, and tool-specific data. `run_in_terminal` records can contain
the exact command and a terminal state with an explicit exit code. The adapter
does not treat `isComplete` as success: command/tool success is derived only
from explicit error, success, status, or exit-code fields.

Text edit groups contain a file URI and explicit edit ranges/text. Those power
the changed-file view. File references and edited-file events may also be
present, but referenced attachment or resource contents are not opened. No
separate Copilot subagent nodes are invented: a `runSubagent` tool call remains
a tool event unless VS Code provides a distinct local conversation with stable
parentage.

### Copilot classification, activity, and duplicates

The installed built-in extensions were:

```text
/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/copilot
  GitHub.copilot-chat 0.53.1
/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/extensions/copilot
  GitHub.copilot-chat 0.55.2026062901
```

Their manifests register participant IDs including
`github.copilot.default`, `github.copilot.editingSession`,
`github.copilot.editsAgent`, notebook participants, VS Code, and terminal
participants. Observed canonical snapshots used `responderUsername` equal to
`GitHub Copilot` and Copilot agent IDs. A session is classified as Copilot only
when the responder is exactly GitHub Copilot, an agent ID begins with
`github.copilot.`, or GitHub publisher plus Copilot extension metadata is
present. Generic VS Code chat sessions are explicitly excluded.

`pendingRequests` and request `modelState` provide explicit activity state.
State zero or a pending request is treated as active; explicitly sealed states
remain completed even if the file is recent. File size and mtime detect writes,
while the cached replay state ingests only new complete lines. Event polling
uses the selected session's cached path and never performs full Stable,
Insiders, profile, or workspace discovery.

The stable decoded `sessionId` is the deduplication key across workspace
transitions, indexes, profiles, and application variants. Similar titles,
timestamps, or prompts are not sufficient evidence and are never deduplicated.

### Indexed, derivative, and unsupported stores

Stable had 29 and Insiders had 142 per-workspace `state.vscdb` SQLite files in
the inspected snapshot. Each sampled database had only `ItemTable(key TEXT
UNIQUE, value BLOB)`. Relevant keys included `chat.ChatSessionStore.index`,
`GitHub.copilot-chat`, and chat UI mementos. Values were not needed or read for
the integration. The database is an index and mutable UI/extension state, not a
second transcript source.

Stable contained 36 and Insiders 234 `chatEditingSessions/*/state.json`
snapshots plus `contents/*` files. These overlap the canonical chat's edit state
and can contain source-file snapshots. They are deliberately excluded: the
canonical JSONL already records supported edit groups, and opening snapshot
contents would expand the privacy boundary.

The following extension-owned roots were also inspected by filenames and file
metadata only:

```text
<User>/globalStorage/github.copilot-chat
<User>/workspaceStorage/<workspace-id>/GitHub.copilot-chat
```

Observed global files included command/settings embeddings, agent Markdown,
Copilot CLI shims and metadata, debug helpers, binary tool caches, and
`vscode-sessions-<id>` diff/path indexes. They are caches, indexes, helpers, or
separate CLI metadata rather than complete canonical VS Code chat logs. The
workspace extension roots can hold referenced chat resources; the adapter does
not read them. Cloud-only Copilot or remote-coding-agent conversations without a
complete local VS Code JSONL are unsupported, and no undocumented API is
queried.

The supported JSONL is plain user-readable text, not compressed, encrypted, or
credential-gated. No security bypass is required. The format is nevertheless
an internal VS Code persistence contract: it may change with VS Code schema
versions, extension participant metadata, or response-part additions. Strict
Effect Schema decoding, unknown-kind tolerance, per-file isolation, and source
health reporting limit the impact of that instability.

## Privacy and read-only operating rules

- Open provider files only for read and stat operations; never lock, migrate,
  rewrite, move, or delete them.
- Never access authentication files, cookies, browser login databases, OAuth
  locks, account tables, or encrypted reasoning material.
- Do not index attachment contents, shell snapshots, memories, paste caches, or
  unrelated files merely because a rollout references them.
- Keep sanitized fixtures synthetic. Unit tests use the repository's in-memory
  Effect filesystem and never inspect the real user filesystem.
- Bind the server locally, introduce no runtime network dependency, upload, or
  telemetry, and return only the session data the local user requested to view.
- Treat provider formats as unstable external input. Decode defensively, make
  unavailable fields explicit, and never invent unsupported diagnostics or
  changed-file data.

## Supportability conclusion

There is a safe, reliable path for the requested unified browser using these
canonical adapters:

1. Claude Code project JSONL, retaining the existing rich run model.
2. Codex date-partitioned rollout JSONL, shared by CLI, desktop, exec,
   automations, and subagents.
3. Copilot CLI append-only session event JSONL.
4. VS Code-owned local chat JSONL, restricted to sessions with explicit GitHub
   Copilot responder or participant metadata.

The adapters must deduplicate each logical session by provider plus session ID.
Codex metadata mirrors and indexes may enrich or corroborate a rollout but must
not create duplicate list items. Browser caches and ordinary ChatGPT cloud
conversations remain unsupported unless OpenAI later exposes a complete,
documented, locally readable store that does not require credentials or bypass
application protections.
