# TIL: How a Local Website Can Run Codex or Claude Code from Your Disk

A normal website cannot start Codex, run Claude Code, or freely read files from
your computer. The browser sandbox deliberately prevents that.

The trick is that `liveclaudecode` is not only a web page. It is a local
application with two halves:

1. A Nuxt page displayed in the browser.
2. A Node.js server running on the same computer as the browser, files, and
   coding-agent credentials.

The Node server is the part that can read local session files and start a local
process. The browser is only the interface.

```text
┌──────────────────────── Browser ────────────────────────┐
│  http://127.0.0.1:8787                                 │
│                                                        │
│  Select session -> Ask -> type a question              │
└───────────────────────────┬────────────────────────────┘
                            │ HTTP on localhost
                            v
┌──────────────────── Local Node server ──────────────────┐
│  Finds the JSONL session on disk                        │
│  Starts the selected ACP adapter as a child process     │
└───────────────────────────┬────────────────────────────┘
                            │ ACP over stdin/stdout
                   ┌────────┴────────┐
                   v                 v
          claude-agent-acp       codex-acp       copilot --acp
                   │                 │                 │
                   └─────────────────┼─────────────────┘
                            v
                 configured model provider
```

Everything above the final provider call happens on the user's machine.

## What runs when I start the site?

From the repository:

```bash
pnpm install
./bin/liveclaudecode --open
```

The launcher starts a local Nuxt/Node server and opens
`http://127.0.0.1:8787`. Binding to `127.0.0.1` means the server is reachable
from the local computer, not automatically from other machines on the network.

The server scans the local session stores used by the coding agents, including:

```text
~/.claude/projects/...
~/.codex/sessions/...
```

It parses those transcript files and sends safe, structured data to the browser
for the session list, timeline, tools, errors, and changed files. Opening the
dashboard does not start Claude, Codex, or Copilot.

## What happens when I click Ask?

Suppose I am viewing a failed Claude Code session and ask:

> Why did the last command fail, and what should I try next?

The following happens:

1. The browser sends the question and selected session ID to the local
   `/api/chat` endpoint.
2. The Node server resolves that ID to the actual JSONL transcript and the
   session's original working directory.
3. The server starts the selected Claude, Codex, or Copilot ACP agent:

   ```text
   npx -y @agentclientprotocol/claude-agent-acp
   npx -y @agentclientprotocol/codex-acp
   copilot --acp --stdio --available-tools=view,rg,glob
   ```

4. The agent inherits the local environment, including the user's existing
   Claude login or Codex login/API-key configuration.
5. The server creates a new ACP conversation and gives it a read-only
   instruction containing the transcript path and working directory.
6. The agent reads the transcript and any relevant project files using local
   tools, then answers the question.
7. Text, reasoning, and tool-status updates travel back through ACP to the Node
   server. The browser polls the local API and displays them in the chat.

The website is therefore not remotely controlling an already-running terminal.
It starts a **new local agent process** and gives that agent the recorded
session as context.

## Why ACP is useful

The Agent Client Protocol gives the local server one interface for different
agents. Instead of teaching the Vue UI how Claude, Codex, and Copilot each work,
the server speaks the same JSON-RPC protocol to every agent.

ACP messages are newline-delimited JSON sent through the child process's stdin
and stdout:

```text
Node server  -- session/prompt -->  ACP adapter
Node server  <-- session/update --  ACP adapter
Node server  <-- permission ask --  ACP adapter
Node server  -- allow/reject ---->  ACP adapter
```

This last exchange is important. The agent cannot silently assume every tool is
allowed; the local client gets a chance to approve or reject requested actions.

## The observed session and chat are different

There are two separate histories:

- The original Claude, Codex, or Copilot JSONL transcript is evidence being inspected.
- The Ask conversation is a new ACP session stored in the running dashboard
  server's memory.

The original transcript is never appended to or resumed. The first Ask message
includes the transcript path as context. Later questions reuse the new ACP
conversation, so the answering agent remembers the discussion. Clicking
**New** closes that agent process and discards the in-memory chat.

## How read-only access works

The local server has the operating-system permissions of the user who launched
it, so safety cannot come from the browser sandbox alone. `liveclaudecode`
enforces a narrower policy for the agent:

- It advertises no filesystem-writing or terminal capabilities through ACP.
- It approves only read, search, fetch, and thinking tool kinds.
- It rejects edits, command execution, and unknown permission kinds.
- It launches Codex in read-only mode with browser access disabled.
- It limits Copilot CLI to file viewing, text search, and file discovery.
- Its first prompt explicitly instructs the agent not to modify files.

The JSONL transcript remains read-only. This is a defense-in-depth policy, but
the server should still only be run on a trusted computer and kept bound to
localhost.

## Local does not necessarily mean offline

The dashboard can read and display transcripts without network access. Asking a
new question is different: Claude, Codex, or Copilot normally contacts its
configured model provider.

That means the provider may receive:

- the new question;
- relevant evidence from the selected transcript; and
- contents of project files the agent reads to answer it.

No agent process starts until the user submits a message. This keeps passive
session browsing local while making the network boundary explicit when Ask is
used.

## Can a hosted website do the same thing?

Not by itself. A page served from the internet still cannot call `spawn()`, read
`~/.claude`, or access `~/.codex`. It would need a trusted local companion such
as:

- a localhost daemon;
- a desktop application;
- a browser extension with explicit native-host permissions; or
- an agent running in a remote workspace where the files also live.

`liveclaudecode` chooses the simplest version: serve both the UI and API from a
local Node process. The browser provides the convenient website experience,
while the local backend provides controlled access to the disk and coding-agent
processes.

That is the main idea: **the website does not run the local agent—the local
server behind the website does.**
