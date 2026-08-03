# Syntax Highlighting Rollout — Phase 2

## Engineering specification

**Status:** Proposal, not started
**Product:** liveclaudecode
**Audience:** Frontend engineering
**Scope:** Extend the shipped Shiki highlighting to tool result bodies, the
inspector result tab, and the changes view
**Depends on:** Phase 1 (markdown fences and tool input), implemented on
`add-effect-skill`

## 1. Summary

Phase 1 introduced a Shiki highlighting stack and applied it to the two
highest-traffic surfaces: fenced code in assistant markdown, and `tool_use`
payloads (reconstructed as diffs for editing tools). Three surfaces still
render transcript content as unstyled `<pre>` or `<code>`.

This document specifies those three, in the order they should be built. Each
reuses the Phase 1 building blocks; none needs a new dependency.

The three items are not equally valuable. Item A fixes a real rendering
defect — terminal escape codes currently reach the DOM as literal text. Items
B and C are consistency work.

## 2. What already exists

| Piece | Location | Role |
| --- | --- | --- |
| `highlightCode` | `app/utils/highlighter.ts` | Async highlight to HTML; lazy grammar and core loading |
| `useCodeHighlight` | `app/composables/useCodeHighlight.ts` | Reactive wrapper; drops superseded responses |
| `CodeBlock.vue` | `app/components/` | Block renderer, also the Comark `pre` override |
| `ToolInputBlock.vue` | `app/components/` | `tool_use` disclosure; parses only when opened |
| `resolveLanguage`, `languageForPath` | `app/utils/code-language.ts` | Fence info / extension to grammar id |
| `toolCodePreview` | `app/utils/tool-code.ts` | Tool payload to highlightable preview |
| `diffLines` | `app/utils/line-diff.ts` | LCS line diff |

Two Shiki capabilities are reachable today but unused. Item A depends on the
first, item C on the second:

- `ansi` is in `SPECIAL_LANGUAGES`, so `highlightCode(text, { language:
  'ansi' })` works today with no grammar chunk. Shiki's core decodes SGR
  escape codes natively.
- Shiki's `structure: 'inline'` option emits styled spans with no
  `<pre>`/`<code>` wrapper. `highlightCode` does not expose it yet; item C
  needs it.

## 3. Goals

1. Terminal output renders as color, not as escape-code noise.
2. File contents in tool results read as code in their own language.
3. The inspector's prompt and final result get the same markdown treatment as
   the event feed, including fenced code.
4. Shell commands in the changes view are legible at a glance.
5. No new runtime dependency, no network access, no change to the read-only
   server contract.

## 4. Non-goals

- Changing transcript parsing, schemas, or server APIs. Every input needed
  here is already on `TranscriptEvent`.
- Raising the 8,000-character clip in `server/utils/transcript-content.ts`.
  Bodies stay bounded; highlighting must tolerate truncation.
- A full terminal emulator. Shiki's `ansi` grammar covers SGR color and style
  codes; cursor movement and control sequences are out of scope.
- Line-number gutters anywhere except the Read-result case in item A.

## 5. Shared groundwork

Two small changes unblock the items and should land first.

### 5.1 Extract the transcript markdown wrapper

`markdownPlugins` and `markdownComponents` are currently defined identically
in two places:

- `app/components/EventFeed.vue:10-16`
- `app/components/ChatPanel.vue:19-25`

Item B would make a third copy. Extract a `TranscriptMarkdown.vue` that owns
the `security` plugin config and the `{ a: TranscriptMarkdownLink, pre:
CodeBlock }` component map, exposing a single `markdown` prop. Replace both
existing call sites.

This is a refactor with no behavior change, so the existing EventFeed and
ChatPanel markdown tests are the regression net. Do not add new assertions
for it.

### 5.2 Add a synchronous highlight path

`highlightCode` is always async because the first call must load a grammar.
Once loaded, Shiki's `codeToHtml` is synchronous. Item C renders many short
snippets at once and should not pay a microtask and a re-render per row.

Add to `app/utils/highlighter.ts`:

```ts
export function highlightCodeSync(code: string, options?: HighlightOptions): string | null
```

It returns `null` when the grammar is not yet loaded, and the caller falls
back to plain text until the async path warms the singleton. Implement it by
holding the resolved `HighlighterCore` in a module-level variable that
`baseHighlighter()` populates on resolution, so `highlightCodeSync` never
triggers a load itself.

`useCodeHighlight` should try the sync path first and only fall through to
the async watcher when it returns `null`. That removes the empty-then-filled
flash for already-warm languages everywhere, including Phase 1 surfaces.

## 6. Item A — tool result bodies

**Call site:** `app/components/EventFeed.vue:269-274`

```vue
<template v-else-if="event.kind === 'tool_result'">
  <details class="event-details result-details" :open="event.error">
    <summary>{{ resultSummary(event) }}</summary>
    <pre>{{ event.body || '' }}</pre>
  </details>
</template>
```

### 6.1 Why this is a defect, not a polish

Bash results in real transcripts contain SGR escape codes. Confirmed in
`~/.claude/projects/*/*.jsonl`: build output arrives as

```
└  ✨ Build complete![2m[WebServer] [22m[2m$ nuxt preview…
```

Those bytes currently reach the DOM verbatim and render as stray characters.
They also leak into the collapsed summary, because `resultSummary`
(`EventFeed.vue:119-122`) slices the raw body.

Frequency is low — a single result in the sampled file — but the current
output is wrong, not merely plain.

### 6.2 Language selection

`tool_result` events carry `tool` (the originating tool name) and `summary`
(the originating tool's summary string), assigned in
`server/utils/transcript.ts:504-518`. Note that `summary` is itself clipped
to 120 characters, which is ample for a path but truncates long commands.
`toolSummary` prefers `command` then
`file_path`, so:

| `event.tool` | `event.summary` holds | Language |
| --- | --- | --- |
| `Bash` | the command | `ansi` |
| `Read`, `NotebookRead` | the file path | `languageForPath(event.summary)` |
| `Grep`, `Glob` | the pattern | `text` |
| anything else | varies | `ansi` |

Default to `ansi` rather than `text`: it is a superset for output that
happens to contain no escape codes, and it is the common case for tools that
shell out.

Add `languageForToolResult(tool, summary)` to `app/utils/code-language.ts`,
next to `languageForPath`. Pure, unit-tested, no new file.

### 6.3 The Read gutter

Read results are numbered listings, one line per source line:

```
1\timport { MarkerType, type Edge } from '@vue-flow/core'
2\timport type { TimelineLane } from '#shared/types/run'
```

Handing that to the TypeScript grammar tokenizes the line numbers as numeric
literals and shifts every line's indentation. The gutter must come off before
highlighting.

Add `splitNumberedListing(body)` to `app/utils/tool-code.ts`:

```ts
export interface NumberedListing {
  /** Source text with the gutter removed. */
  code: string
  /** Original line number per line, or null when the body was not a listing. */
  numbers: number[] | null
}
```

Treat the body as a listing only when **every** non-empty line matches
`/^\s*\d+\t/`. A single non-matching line means the body is ordinary output
and must pass through untouched — a partial strip would silently corrupt it.
Note that the 8,000-character clip can cut mid-line, so the final line may be
incomplete; exclude the last line from the all-lines check.

Render `numbers` as a non-selectable gutter column in `CodeBlock.vue`, behind
a new optional `lineNumbers?: number[]` prop. When absent, nothing changes.
The gutter must be excluded from copied text — use a `::before` on each
`.line` fed by a CSS custom property, not real DOM text.

### 6.4 Component

Mirror `ToolInputBlock.vue`: a `ToolResultBlock.vue` owning its own `open`
ref, computing the preview only once opened. One difference — result
disclosures open automatically on error (`:open="event.error"`), so the
initial `open` state must be seeded from the prop rather than defaulting to
`false`.

Also strip escape codes from `resultSummary` so the collapsed line is clean.
A small `stripAnsi` in `app/utils/format.ts` covers it; the summary is a
plain string and must not become markup.

## 7. Item B — inspector prompt and final result

**Call site:** `app/components/RunInspector.vue:200-203`

```vue
<section><span class="section-eyebrow">Prompt</span><pre>{{ promptEvent?.body || '…' }}</pre></section>
<section><span class="section-eyebrow">Final result</span><div class="result-copy">{{ selected.finalText || lastText?.body || '…' }}</div></section>
```

Both fields are markdown. The prompt is a user message; the final result is
assistant prose that routinely contains fenced code. The event feed already
renders both content types properly — this tab does not.

Replace both with `<TranscriptMarkdown>` from §5.1. Fenced code then inherits
`CodeBlock` with no extra work, which is the entire point of doing §5.1
first.

Keep the empty-state strings as they are. They are prose, not markdown, and
should stay in plain elements rather than being fed through the renderer.

Watch the styling. `.inspector-result pre, .inspector-result .result-copy`
(`app/assets/main.css:843`) sets the current bordered mono surface, and
neither selector will match a markdown body. `.markdown-body`
(`main.css:1563`) brings `max-width: 760px`, which will look wrong in a
narrow inspector panel. Scope an override under `.inspector-result` rather
than editing either shared rule.

## 8. Item C — changes-view commands

**Call site:** `app/components/RunChanges.vue:88-96`

```vue
<code :title="command.cmd">{{ command.cmd }}</code>
```

`command.cmd` is a single line: whitespace-collapsed and truncated to 160
characters in `server/utils/transcript.ts:417-418`. It is always shell.

Add a `ShellCommand.vue` using `highlightCodeSync` from §5.2 with `structure:
'inline'`, falling back to the current plain `<code>` when the grammar is not
warm. Requires threading a `structure` option through `HighlightOptions`.

Two constraints:

- Keep the `:title` attribute. Truncated commands rely on the native tooltip.
- The list is unbounded — a long session can hold hundreds of rows. This is
  exactly why item C wants the sync path. Do not ship it with a per-row async
  watcher.

This is the lowest-value item of the three. A single-line shell command is
already readable, and the gain is consistency rather than comprehension. If
sequencing pressure appears, drop this one, not the other two.

## 9. Testing

Follow the split already established in Phase 1.

**Unit** (`test/unit/`), no filesystem, no mounting:

- `code-language.spec.ts` — extend with `languageForToolResult`: Bash to
  `ansi`, Read to the path's language, unknown tools to `ansi`, missing
  summary to `ansi`.
- `tool-code.spec.ts` — extend with `splitNumberedListing`: a clean listing,
  a body where one middle line lacks a gutter (must pass through untouched),
  a body whose final line is truncated mid-content (must still parse), an
  empty body, and content that merely starts with digits.
- `highlighter.spec.ts` — extend with `highlightCodeSync` returning `null`
  before load and markup after, and with `structure: 'inline'` emitting no
  `<pre>`.
- `format.spec.ts` — extend with `stripAnsi`: a body with SGR codes, a body
  with none (must return the same string), and an empty body.

**Component** (`test/nuxt/`):

- `tool-result-block.spec.ts` — ANSI input renders colored spans, not literal
  escape text; a Read result renders with a gutter and the gutter is absent
  from `textContent`; an error result starts open.
- `run-inspector.spec.ts` — extend: a fenced block in the final result
  produces a `.shiki` element.
- `run-changes.spec.ts` — extend: a command row renders tokens and keeps its
  `title`.

Assert on rendered classes and text, not on Shiki's inline style strings —
those change with theme versions.

## 10. Risks and decisions to make

**The `ansi` default may over-apply.** A tool result that is plain prose gets
the `ansi` grammar, which is a no-op for text without escape codes but does
put every line through the tokenizer. If profiling shows this matters on
large results, gate it: only use `ansi` when `/\x1b\[/` matches, else `text`.
Prefer measuring over guessing.

**Read gutters may not be universal.** The `\d+\t` shape was confirmed for
Claude transcripts. Codex and Copilot Read equivalents were not sampled. The
all-lines-must-match rule means an unrecognized shape degrades to plain
output rather than corrupting it, which is the correct failure mode — but
someone should sample a Codex and a Copilot session before assuming coverage.

**`highlightCodeSync` adds module-level state.** Phase 1 avoided caching the
highlighter instance directly, deferring to Shiki's own singleton. The sync
path needs a resolved reference. Keep it write-once from within
`baseHighlighter()` and never expose it; the alternative is a per-call
`await` that item C cannot afford.

**Item B changes visual density.** Rendering the prompt as markdown means
headings, lists, and code blocks inside a narrow panel that currently shows
flat text. Worth a look at a real session before merging; the prompt is often
long and structured, and the flat `<pre>` may genuinely read better for
scanning. This is a judgment call, not a correctness one.

## 11. Sequencing

1. §5.1 markdown wrapper extraction — no behavior change, unblocks B.
2. §5.2 sync highlight path — unblocks C, improves Phase 1 surfaces.
3. Item A — the only defect fix in the set.
4. Item B — pending the density question in §10.
5. Item C — droppable.

Items A, B, and C are independent after the groundwork and can be split
across separate changes.
