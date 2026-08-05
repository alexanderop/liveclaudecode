/**
 * Key classification for transcript cassettes.
 *
 * Every key in every recorded record falls into exactly one class. The tables
 * are versioned (`claude@1`) and stamped into each manifest, so a cassette
 * always names the rules it was produced under.
 *
 * Shared by the recorder (`script/cassette/record.ts`) and the hygiene test
 * (`test/unit/cassette-hygiene.spec.ts`) so a hand-constructed cassette is
 * judged by the same tables that produced the recorded ones.
 */

export const CASSETTE_SOURCES = ['claude', 'codex', 'copilot', 'copilot-cli'] as const
export type CassetteSource = (typeof CASSETTE_SOURCES)[number]

export function isCassetteSource(value: string): value is CassetteSource {
  return (CASSETTE_SOURCES as readonly string[]).includes(value)
}

/**
 * - `preserve`   — the scanners read this key's semantics. Passes through
 *                  untouched, and is exempt from clipping and from the
 *                  high-entropy residue scanner.
 * - `pseudonymize` — identifies a person, machine, or project. The value must
 *                  come out the other side carrying no real identity; the
 *                  recorder asserts that.
 * - `scrub`      — free text. Passes through under the sandbox capture
 *                  protocol, but is clipped and residue-scanned.
 * - `drop`       — an opaque binary payload with no test value. Replaced with
 *                  a size marker rather than clipped, because a clipped base64
 *                  blob is still a high-entropy blob.
 */
export type KeyClass = 'preserve' | 'pseudonymize' | 'scrub' | 'drop'

/** The rules version stamped into `manifest.redaction.rules`. */
export const RULES_VERSION: Readonly<Record<CassetteSource, string>> = {
  'claude': 'claude@1',
  'codex': 'codex@1',
  // @2 drops VS Code's rendered-prompt payloads, which carry the operator's
  // instruction files rather than the session (see COPILOT_RENDERED_CONTEXT).
  'copilot': 'copilot@2',
  'copilot-cli': 'copilot-cli@1',
}

/** Any string value longer than this is clipped. Structure is never clipped. */
export const CLIP_LIMIT_BYTES = 4_096

/** Records kept per session unless `--limit` says otherwise. */
export const DEFAULT_RECORD_LIMIT = 400

/**
 * The instant every cassette's newest record is shifted to sit five minutes
 * before, and the instant L2 pins `TestClock` to.
 *
 * A fixed constant rather than a value derived from when the recording ran.
 * Deriving it from capture time — the obvious reading of the specification —
 * makes a re-record of the *same* session produce a wholly different cassette
 * as soon as it crosses an hour boundary: every timestamp, every mtime, and
 * every hash change, and the diff a reviewer is supposed to read becomes
 * unreadable. Measured, not assumed: two recordings of one session fifteen
 * minutes apart shared no file bytes.
 *
 * A constant also conceals the real capture times more completely than a
 * derived anchor does, because the offset is then unknowable from the manifest
 * rather than merely unstated.
 *
 * The cost is that cassettes recorded months apart read as concurrent when
 * several are materialized into one root. That is the desirable direction: the
 * browser and e2e tiers want several sessions live on one project, which is
 * what a real dashboard shows.
 */
export const CASSETTE_CLOCK_ANCHOR = '2026-01-01T12:00:00.000Z'

/** How far before the anchor the newest record lands. */
export const NEWEST_RECORD_LEAD_MS = 5 * 60_000

/** Total committed cassette bytes, enforced by `pnpm cassette:verify`. */
export const CASSETTE_BYTE_BUDGET = 2 * 1_024 * 1_024

/**
 * Keys whose entire subtree is preserved, whatever the leaf names are.
 *
 * `usage` is the whole point of the cost tests and gains new counters every
 * few releases, so enumerating its leaves would mean a warning per release for
 * no benefit. `cache_creation` is its nested sibling.
 */
const PRESERVE_SUBTREES: ReadonlySet<string> = new Set([
  'usage',
  'cache_creation',
  'total_token_usage',
  'last_token_usage',
  'info',
  'token_usage',
  // Copilot CLI's per-tool telemetry bag: scalars only, and it gains
  // properties release to release for the same reason `usage` does.
  'toolTelemetry',
  'modelCacheState',
])

/**
 * Keys whose entire subtree is dropped. Only opaque payloads belong here —
 * a cassette that drops a subtree stops testing whatever read it.
 */
const DROP_SUBTREES: ReadonlySet<string> = new Set([
  // Inline image bytes on a `content[].source` block, and the equivalent
  // Copilot/Codex attachment payloads. Clipping leaves 4 KB of base64, which
  // is still indistinguishable from a leaked credential to the scanners.
  'source',
])

/**
 * Opaque model state: encrypted reasoning blobs and thinking signatures.
 *
 * Dropped rather than preserved. Nothing in this repository reads them, they
 * are the only values in a real capture that score above the entropy
 * threshold — a recorded Copilot CLI session put `reasoningOpaque` at 5.8 bits
 * per character — and a value nobody reads is pure leak surface.
 */
const OPAQUE_MODEL_STATE: ReadonlySet<string> = new Set([
  // Codex's copy of the operator's installed skill bundles.
  'host_skills',
  // VS Code Copilot Chat's provider continuation token and encrypted thinking,
  // measured at 5.0 to 5.6 bits per character — the highest-entropy values in
  // any recorded cassette, and read by nothing.
  'statefulMarker',
  'encrypted',
  'reasoningOpaque',
  'reasoning_opaque',
  'encrypted_content',
  'signature',
])

/**
 * Claude attachment payloads that inventory the *capture machine* rather than
 * the session: the installed skill list, configured MCP servers, available
 * agent types, the deferred-tool roster.
 *
 * The sandbox capture protocol cannot reach these. Claude Code injects the
 * operator's global configuration into every transcript regardless of the
 * working directory, so a session run against a throwaway repository still
 * carries the operator's private skill descriptions and MCP instructions.
 *
 * Dropped, not clipped — four kilobytes of someone's skill list is still
 * someone's skill list. `transcript.ts` reads only the hook, diagnostics,
 * budget, truncation-notice, and goal-status attachment types, none of which
 * use these keys, so nothing under test loses coverage.
 */
const CLAUDE_ENVIRONMENT_ATTACHMENT_KEYS: ReadonlySet<string> = new Set([
  'content',
  'names',
  'addedLines',
  'addedBlocks',
  'addedNames',
  'addedTypes',
  'readdedNames',
  'removedNames',
  'removedTypes',
  'needsAuthMcpServers',
  'pendingMcpServers',
])

/**
 * VS Code Copilot Chat's *rendered* prompt payloads.
 *
 * `renderedUserMessage` is the user's turn after VS Code has spliced in every
 * instruction file, hook output, and global rule the operator has configured;
 * `renderedGlobalContext` is the `<environment_info>`/`<workspace_info>`
 * preamble. A measured capture put four kilobytes of the operator's private
 * skill definitions in the first and the machine description in the second, and
 * the sandbox protocol cannot prevent it — VS Code injects them regardless of
 * which folder is open.
 *
 * Dropped for the same reason as Claude's attachment listings: nothing in
 * `copilot-transcript.ts` or `shared/schemas/copilot.ts` reads either key, so
 * the drop costs no coverage, and the unrendered `message.text` beside them is
 * the prompt a cassette actually exists to preserve.
 */
const COPILOT_RENDERED_CONTEXT: ReadonlySet<string> = new Set([
  'renderedUserMessage',
  'renderedGlobalContext',
])

/**
 * Injected preamble blocks that inventory the capture machine.
 *
 * Codex writes its skill, plugin, and connector rosters into ordinary
 * `payload.content.text` user-message blocks, so they cannot be caught by key
 * name the way Claude's attachment listings can — the same key also carries
 * the operator's real prompts, which are exactly what the cassette exists to
 * preserve. They are matched by their marker instead.
 *
 * `<environment_context>` is deliberately absent: it carries `cwd`, shell, and
 * date, all of which are pseudonymized or harmless, and it is worth keeping
 * because it is real session context rather than a machine inventory.
 */
const ENVIRONMENT_INVENTORY_MARKER
  = /^\s*(?:<(?:skills_instructions|plugins_instructions|apps_instructions|recommended_plugins)>|## Skills\b)/

/** Whether a free-text value is an injected inventory of the capture machine. */
export function isEnvironmentInventory(text: string): boolean {
  return ENVIRONMENT_INVENTORY_MARKER.test(text)
}

/** Leaf keys classified the same way regardless of source. */
const COMMON: ReadonlyMap<string, KeyClass> = new Map<string, KeyClass>([
  // Structure and discriminants.
  ['type', 'preserve'],
  ['kind', 'preserve'],
  ['role', 'preserve'],
  ['timestamp', 'preserve'],
  ['ts', 'preserve'],
  ['model', 'preserve'],
  ['version', 'preserve'],
  ['status', 'preserve'],
  ['state', 'preserve'],
  ['exitCode', 'preserve'],
  ['exit_code', 'preserve'],
  ['success', 'preserve'],
  ['error', 'preserve'],
  ['durationMs', 'preserve'],
  ['duration_ms', 'preserve'],
  ['startTime', 'preserve'],
  ['endTime', 'preserve'],

  // Identity-bearing.
  ['cwd', 'pseudonymize'],
  ['workingDirectory', 'pseudonymize'],
  ['gitBranch', 'pseudonymize'],
  ['branch', 'pseudonymize'],
  ['sessionId', 'pseudonymize'],
  ['session_id', 'pseudonymize'],
  ['path', 'pseudonymize'],
  ['file_path', 'pseudonymize'],
  ['filePath', 'pseudonymize'],
  ['filename', 'pseudonymize'],
  ['fsPath', 'pseudonymize'],
  ['uri', 'pseudonymize'],
  ['external', 'pseudonymize'],
  ['authority', 'pseudonymize'],
  ['folder', 'pseudonymize'],
  ['workspace', 'pseudonymize'],
  ['workspaceFolder', 'pseudonymize'],

  // Free text.
  ['text', 'scrub'],
  ['content', 'scrub'],
  ['message', 'scrub'],
  ['title', 'scrub'],
  ['description', 'scrub'],
  ['summary', 'scrub'],
  ['command', 'scrub'],
  ['cmd', 'scrub'],
  ['output', 'scrub'],
  ['stdout', 'scrub'],
  ['stderr', 'scrub'],
  ['value', 'scrub'],
])

const CLAUDE: ReadonlyMap<string, KeyClass> = new Map<string, KeyClass>([
  ['uuid', 'preserve'],
  ['parentUuid', 'preserve'],
  ['logicalParentUuid', 'preserve'],
  ['isSidechain', 'preserve'],
  ['isMeta', 'preserve'],
  ['isCompactSummary', 'preserve'],
  ['isApiErrorMessage', 'preserve'],
  ['agentId', 'preserve'],
  ['agentType', 'preserve'],
  ['stop_reason', 'preserve'],
  ['stop_sequence', 'preserve'],
  ['service_tier', 'preserve'],
  ['inference_geo', 'preserve'],
  ['speed', 'preserve'],
  ['entrypoint', 'preserve'],
  ['userType', 'preserve'],
  ['messageCount', 'preserve'],
  ['requestId', 'preserve'],
  ['toolUseID', 'preserve'],
  ['tool_use_id', 'preserve'],
  ['toolUseId', 'preserve'],
  ['isAsync', 'preserve'],
  ['level', 'preserve'],
  ['subtype', 'preserve'],
  ['permissionMode', 'preserve'],
  ['mode', 'preserve'],
  ['prNumber', 'preserve'],
  // `id` on a Claude record is a message or tool-use id, both of which the
  // causal graph and tool statistics key on.
  ['id', 'preserve'],
  ['name', 'preserve'],

  ['lastPrompt', 'scrub'],
  ['aiTitle', 'scrub'],
  ['customTitle', 'scrub'],
  ['thinking', 'scrub'],
  ['prUrl', 'pseudonymize'],
])

const CODEX: ReadonlyMap<string, KeyClass> = new Map<string, KeyClass>([
  ['id', 'preserve'],
  ['call_id', 'preserve'],
  ['payload', 'preserve'],
  ['effort', 'preserve'],
  ['reasoning_effort', 'preserve'],
  ['reasoning_summary', 'preserve'],
  ['summary_text', 'scrub'],
  ['originator', 'preserve'],
  ['source', 'preserve'],
  ['cli_version', 'preserve'],
  ['approval_policy', 'preserve'],
  ['sandbox_policy', 'preserve'],
  ['input_tokens', 'preserve'],
  ['output_tokens', 'preserve'],
  ['cached_input_tokens', 'preserve'],
  ['reasoning_output_tokens', 'preserve'],
  ['total_tokens', 'preserve'],
  ['step', 'scrub'],
  ['plan', 'preserve'],
  ['changes', 'pseudonymize'],
  ['arguments', 'scrub'],
  ['aggregated_output', 'scrub'],
  ['formatted_output', 'scrub'],
  ['nickname', 'pseudonymize'],
])

/**
 * VS Code Copilot Chat.
 *
 * As with Copilot CLI, every leaf here was surfaced as unclassified by the
 * recorder against a real capture. The bulk is the chat *snapshot*: the model
 * picker's configuration schema, the agent's slash-command roster, and the
 * terminal tool's command plumbing, none of which the replay reads but all of
 * which it must round-trip without tripping a detector.
 */
const COPILOT: ReadonlyMap<string, KeyClass> = new Map<string, KeyClass>([
  // A tool-call id, not a session id — `copilot-transcript.ts` pairs
  // invocations on it, and the chat session's own id is `sessionId`.
  ['id', 'preserve'],
  ['resolveId', 'preserve'],
  ['terminalToolSessionId', 'preserve'],
  ['terminalCommandId', 'preserve'],
  ['ctorName', 'preserve'],
  ['containerName', 'preserve'],
  ['initialLocation', 'preserve'],
  ['phase', 'preserve'],
  ['stopReason', 'preserve'],
  ['language', 'preserve'],
  ['background', 'preserve'],
  ['foreground', 'preserve'],
  ['enum', 'preserve'],
  ['enumItemLabels', 'preserve'],
  ['enumDescriptions', 'preserve'],
  // The append-log's own record discriminant: `k` is `kind`, `v` the payload.
  ['k', 'preserve'],

  ['generatedTitle', 'scrub'],
  ['category', 'scrub'],
  ['examples', 'scrub'],
  ['sampleRequest', 'scrub'],
  ['modelDescription', 'scrub'],
  ['originLabel', 'scrub'],
  ['query', 'scrub'],
  ['commandLine', 'scrub'],
  ['original', 'scrub'],
  ['forDisplay', 'scrub'],
  ['toolEdited', 'scrub'],
  ['arguments', 'scrub'],

  ['requestId', 'preserve'],
  ['responseId', 'preserve'],
  ['modelId', 'preserve'],
  ['modelState', 'preserve'],
  ['completedAt', 'preserve'],
  ['isComplete', 'preserve'],
  ['complete', 'preserve'],
  ['toolId', 'preserve'],
  ['toolCallId', 'preserve'],
  ['toolSpecificData', 'preserve'],
  ['requests', 'preserve'],
  ['response', 'preserve'],
  ['pendingRequests', 'preserve'],
  ['creationDate', 'preserve'],
  ['lastMessageDate', 'preserve'],
  ['customTitle', 'scrub'],
  ['scheme', 'preserve'],
])

/**
 * Classified against a real capture, not guessed.
 *
 * Every key here was reported as unclassified by the recorder while recording
 * `copilot-cli/turn-with-tool-failure`. That is the mechanism working: an
 * unlisted key is scrubbed and named in the review summary, and the operator
 * classifies it before the cassette is committed. Keeping this list current is
 * what makes a *newly added* vendor field visible in the next capture.
 */
const COPILOT_CLI: ReadonlyMap<string, KeyClass> = new Map<string, KeyClass>([
  ['id', 'preserve'],
  ['parentId', 'preserve'],
  ['turnId', 'preserve'],
  ['toolCallId', 'preserve'],
  ['toolName', 'preserve'],
  ['data', 'preserve'],
  ['inputTokens', 'preserve'],
  ['outputTokens', 'preserve'],
  ['totalTokens', 'preserve'],
  ['reason', 'preserve'],

  // Identifiers and enumerations the replay reads or groups by.
  ['messageId', 'preserve'],
  ['interactionId', 'preserve'],
  ['requestId', 'preserve'],
  ['clientRequestId', 'preserve'],
  ['serviceRequestId', 'preserve'],
  ['apiCallId', 'preserve'],
  ['hookInvocationId', 'preserve'],
  ['parentAgentTaskId', 'preserve'],
  ['resultType', 'preserve'],
  ['shutdownType', 'preserve'],
  ['delivery', 'preserve'],
  ['newModel', 'preserve'],
  ['currentModel', 'preserve'],
  ['producer', 'preserve'],
  ['copilotVersion', 'preserve'],
  ['contextTier', 'preserve'],
  ['alreadyInUse', 'preserve'],
  ['remoteSteerable', 'preserve'],
  ['rte', 'preserve'],
  ['headCommit', 'preserve'],

  ['gitRoot', 'pseudonymize'],
  ['repository', 'pseudonymize'],

  ['result', 'scrub'],
  ['args', 'scrub'],
  ['toolArgs', 'scrub'],
  ['textResultForLlm', 'scrub'],
  ['detailedContent', 'scrub'],
  ['displayCommand', 'scrub'],
  ['transformedContent', 'scrub'],
  ['initialPrompt', 'scrub'],
  ['sessionLog', 'scrub'],
  ['intentionSummary', 'scrub'],
])

const BY_SOURCE: Readonly<Record<CassetteSource, ReadonlyMap<string, KeyClass>>> = {
  'claude': CLAUDE,
  'codex': CODEX,
  'copilot': COPILOT,
  'copilot-cli': COPILOT_CLI,
}

export interface Classification {
  readonly keyClass: KeyClass
  /**
   * True when no table named this key and it fell through to `scrub`. The
   * recorder prints these so a newly added vendor field announces itself
   * before the cassette is committed — the field-level analogue of opencode's
   * `--fail-on-missing`.
   */
  readonly unclassified: boolean
}

/**
 * Classify a leaf by its key path, outermost key first. Array indices are not
 * part of the path: `content[3].text` is `['content', 'text']`.
 *
 * Subtree rules win over leaf rules, and the source table wins over the common
 * table, so a source can reclassify a shared key (Copilot's `id` identifies a
 * chat session, Claude's identifies a message) without editing the common one.
 */
export function classifyKey(
  source: CassetteSource,
  keyPath: readonly string[],
): Classification {
  for (const key of keyPath) {
    if (DROP_SUBTREES.has(key) || OPAQUE_MODEL_STATE.has(key)) {
      return { keyClass: 'drop', unclassified: false }
    }
    if (source === 'copilot' && COPILOT_RENDERED_CONTEXT.has(key)) {
      return { keyClass: 'drop', unclassified: false }
    }
    if (PRESERVE_SUBTREES.has(key)) return { keyClass: 'preserve', unclassified: false }
  }

  const leaf = keyPath.at(-1)
  if (leaf === undefined) return { keyClass: 'scrub', unclassified: false }

  if (
    source === 'claude'
    && keyPath[0] === 'attachment'
    && CLAUDE_ENVIRONMENT_ATTACHMENT_KEYS.has(leaf)
  ) {
    return { keyClass: 'drop', unclassified: false }
  }

  const specific = BY_SOURCE[source].get(leaf)
  if (specific) return { keyClass: specific, unclassified: false }
  const common = COMMON.get(leaf)
  if (common) return { keyClass: common, unclassified: false }
  return { keyClass: 'scrub', unclassified: true }
}
