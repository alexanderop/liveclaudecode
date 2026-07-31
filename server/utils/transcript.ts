import { Clock, Effect, Predicate } from 'effect'
import { consumeNewRecords } from './incremental-jsonl'
import {
  clip,
  commandOk,
  findMilestones,
  resultText,
  shortPath,
  toolSummary,
} from './transcript-content'
import {
  compactText,
  type MutableFileChange,
  pushIncident,
  recordFileChange,
  recordMilestones,
  toolStatsFromCounts,
} from './transcript-scan-core'
import {
  parseClaudeAssistantBlock,
  parseClaudeRecord,
  parseClaudeUserBlock,
  type ClaudeAssistantRecord,
  type ClaudeSessionStateRecord,
  type ClaudeSystemRecord,
  type ClaudeToolUseBlock,
  type ClaudeUserRecord,
  type ParsedClaudeRecord,
} from '#shared/schemas/claude'
import type {
  AgentOutcome,
  ChangeDetail,
  CommandRun,
  CompactionEvent,
  ContextUsageSample,
  CurrentActivity,
  DiagnosticIncident,
  FileChange,
  GitEvent,
  Milestone,
  ScanDiagnostics,
  SessionEnvironment,
  SkillUse,
  Timestamp,
  Todo,
  ToolStats,
  TranscriptEvent,
  TranscriptStats,
  TurnTiming,
  Usage,
} from '#shared/types/run'

export const LIVE_WINDOW = 45

export const EDIT_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'str_replace_editor',
])
export const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'NotebookRead'])
export const SPAWN_TOOLS = new Set(['Agent', 'Task'])

type JsonRecord = Record<string, unknown>

interface ToolRecord {
  name: string
  summary: string
  ts: Timestamp
  input: JsonRecord
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function toolStats(value: unknown): ToolStats {
  const stats = Predicate.isObject(value) ? value : {}
  return {
    reads: asNumber(stats.readCount),
    searches: asNumber(stats.searchCount),
    commands: asNumber(stats.bashCount),
    edits: asNumber(stats.editFileCount),
    linesAdded: asNumber(stats.linesAdded),
    linesRemoved: asNumber(stats.linesRemoved),
    other: asNumber(stats.otherToolCount),
  }
}

export class TranscriptScan {
  readonly path: string
  line = 0
  malformed = 0
  readonly events: TranscriptEvent[] = []
  readonly toolUses = new Map<string, ToolRecord>()
  readonly openTools = new Map<string, ToolRecord>()
  readonly spawnIds = new Set<string>()
  /**
   * Spawn tool calls whose tool_result was only a background-launch
   * acknowledgement (`toolUseResult.isAsync`). The agent keeps running after
   * the result, so the spawn stays outstanding until a task-notification
   * naming its tool-use-id arrives.
   */
  readonly asyncSpawns = new Set<string>()
  readonly files = new Map<string, MutableFileChange>()
  readonly commands: CommandRun[] = []
  readonly commandByToolId = new Map<string, CommandRun>()
  todos: Todo[] | null = null
  readonly skills: SkillUse[] = []
  readonly milestones: Milestone[] = []
  readonly incidents: DiagnosticIncident[] = []
  readonly turns: TurnTiming[] = []
  readonly context: ContextUsageSample[] = []
  readonly compactions: CompactionEvent[] = []
  readonly outcomes: AgentOutcome[] = []
  readonly changeDetails: ChangeDetail[] = []
  readonly gitEvents: GitEvent[] = []
  readonly counts: Record<string, number> = {}
  readonly environment: SessionEnvironment = {
    cwd: '',
    gitBranch: '',
    version: '',
    entrypoint: '',
    permissionMode: '',
  }
  private readonly causalChildren = new Map<string, number>()
  private causalRecords = 0
  private causalRecordsWithUuid = 0
  private causalBranchPoints = 0
  private causalSidechainRecords = 0
  private causalInterruptions = 0
  errors = 0
  firstTs: Timestamp = null
  lastTs: Timestamp = null
  tokensOut = 0
  finalText = ''
  cwd = ''
  private turnComplete = false
  mtime = 0
  size = 0
  bytesConsumed = 0
  lastLoadedMtime = 0
  lastLoadedSize = -1

  constructor(path: string | URL) {
    this.path = path.toString()
  }

  /** Parse the records appended since the last refresh; see consumeNewRecords. */
  readonly refresh = Effect.fn('TranscriptScan.refresh')(function*(this: TranscriptScan) {
    const { records, next } = yield* consumeNewRecords(this.path, this)
    this.line = next.line
    this.malformed = next.malformed
    this.mtime = next.mtime
    this.size = next.size
    this.bytesConsumed = next.bytesConsumed
    this.lastLoadedMtime = next.lastLoadedMtime
    this.lastLoadedSize = next.lastLoadedSize

    for (const [index, value] of records) {
      const parsed = parseClaudeRecord(value)
      if (parsed.success) {
        this.ingest(parsed.record, index)
      } else {
        yield* Effect.logDebug('Skipping malformed Claude transcript record', {
          path: this.path,
          line: index,
          error: parsed.error,
        })
        this.malformed += 1
      }
    }
    return this
  })

  private ingest(record: ParsedClaudeRecord, line: number): void {
    this.causalRecords += 1
    let timestamp: Timestamp = null

    if (
      record.kind === 'assistant'
      || record.kind === 'user'
      || record.kind === 'system'
      || record.kind === 'attachment'
    ) {
      const data = record.data
      timestamp = data.timestamp ?? null
      if (data.uuid !== undefined) this.causalRecordsWithUuid += 1
      if (typeof data.parentUuid === 'string') {
        const children = (this.causalChildren.get(data.parentUuid) || 0) + 1
        this.causalChildren.set(data.parentUuid, children)
        if (children === 2) this.causalBranchPoints += 1
      }
      if (data.isSidechain === true) this.causalSidechainRecords += 1

      const cwd = data.cwd ?? ''
      this.cwd ||= cwd
      this.environment.cwd = cwd || this.environment.cwd
      this.environment.gitBranch = data.gitBranch || this.environment.gitBranch
      this.environment.version = data.version || this.environment.version
      this.environment.entrypoint = data.entrypoint || this.environment.entrypoint
      if (timestamp) {
        this.firstTs ||= timestamp
        this.lastTs = timestamp
      }
    }

    if (record.kind === 'assistant') this.ingestAssistant(record.data, line, timestamp)
    else if (record.kind === 'user') this.ingestUser(record.data, line, timestamp)
    else if (record.kind === 'system') this.ingestSystem(record.data, line, timestamp)
    else if (record.kind === 'attachment') this.ingestAttachment(record.data.attachment, line, timestamp)
    else if (record.kind === 'session_state') this.ingestSessionState(record.data, line, timestamp)
  }

  private identity(
    record: { uuid?: string, parentUuid?: string | null, isSidechain?: boolean },
  ): Pick<TranscriptEvent, 'uuid' | 'parentUuid' | 'sidechain'> {
    const identity: Pick<TranscriptEvent, 'uuid' | 'parentUuid' | 'sidechain'> = {}
    if (record.uuid !== undefined) identity.uuid = record.uuid
    if (record.parentUuid !== undefined) identity.parentUuid = record.parentUuid
    if (record.isSidechain !== undefined) identity.sidechain = record.isSidechain
    return identity
  }

  private addIncident(incident: Omit<DiagnosticIncident, 'id'>): void {
    pushIncident(this.incidents, incident)
  }

  private ingestSystem(record: ClaudeSystemRecord, line: number, timestamp: Timestamp): void {
    if (record.subtype === 'turn_duration') {
      this.turns.push({
        ts: timestamp,
        durationMs: asNumber(record.durationMs),
        messageCount: asNumber(record.messageCount),
        pendingAgents: asNumber(record.pendingBackgroundAgentCount),
        pendingWorkflows: asNumber(record.pendingWorkflowCount),
      })
    }

    if (record.subtype === 'compact_boundary' && Predicate.isObject(record.compactMetadata)) {
      const metadata = record.compactMetadata
      const preservedMessages = metadata.preservedMessages
      this.compactions.push({
        ts: timestamp,
        durationMs: asNumber(metadata.durationMs),
        preTokens: asNumber(metadata.preTokens),
        postTokens: asNumber(metadata.postTokens),
        droppedTokens: asNumber(metadata.cumulativeDroppedTokens),
        preservedMessages: typeof preservedMessages === 'number'
          ? preservedMessages
          : preservedMessages?.uuids?.length ?? preservedMessages?.allUuids?.length ?? 0,
        trigger: asString(metadata.trigger),
      })
    }

    if (record.subtype === 'agents_killed') {
      this.addIncident({
        severity: 'warning',
        category: 'agent',
        title: 'Agents were stopped',
        detail: 'Claude recorded an agents-killed boundary.',
        ts: timestamp,
        line,
      })
    }
    const hookErrors = Array.isArray(record.hookErrors)
      ? record.hookErrors.length
      : asNumber(record.hookErrors)
    if (record.subtype === 'stop_hook_summary'
      && (hookErrors > 0 || record.preventedContinuation === true)) {
      this.addIncident({
        severity: record.preventedContinuation === true ? 'error' : 'warning',
        category: 'hook',
        title: record.preventedContinuation === true ? 'Stop hook prevented continuation' : 'Stop hook reported errors',
        detail: `${hookErrors} hook errors`,
        ts: timestamp,
        line,
        toolUseId: record.toolUseID || undefined,
      })
    }

    const text = record.content || ''
    if (text.trim()) {
      const [body, full] = clip(text)
      this.events.push({
        role: 'system',
        kind: 'system',
        ts: timestamp,
        body,
        full,
        line,
        ...this.identity(record),
      })
    }
  }

  private ingestAssistant(record: ClaudeAssistantRecord, line: number, ts: Timestamp): void {
    const message = record.message
    if (message.stop_reason === 'end_turn') this.turnComplete = true
    const rawContent = message.content
    const blocks = Array.isArray(rawContent)
      ? rawContent
      : typeof rawContent === 'string'
        ? [{ type: 'text', text: rawContent }]
        : []
    const usageRecord = message.usage || {}
    const cacheCreation = usageRecord.cache_creation
    const serverToolUse = usageRecord.server_tool_use
    this.tokensOut += asNumber(usageRecord.output_tokens)
    const usage = {
      in: asNumber(usageRecord.input_tokens),
      out: asNumber(usageRecord.output_tokens),
      cr: asNumber(usageRecord.cache_read_input_tokens),
      cw: asNumber(usageRecord.cache_creation_input_tokens),
    } satisfies Usage
    if (Object.values(usage).some(Boolean)) {
      this.context.push({
        ts,
        model: message.model || '',
        effort: record.effort || '',
        usage,
        stopReason: message.stop_reason ?? null,
        ...(message.id ? { messageId: message.id } : {}),
        ...(record.requestId ? { requestId: record.requestId } : {}),
        ...(cacheCreation?.ephemeral_5m_input_tokens !== undefined
          ? { cacheWrite5m: asNumber(cacheCreation.ephemeral_5m_input_tokens) }
          : {}),
        ...(cacheCreation?.ephemeral_1h_input_tokens !== undefined
          ? { cacheWrite1h: asNumber(cacheCreation.ephemeral_1h_input_tokens) }
          : {}),
        ...(serverToolUse?.web_search_requests !== undefined
          ? { webSearchRequests: asNumber(serverToolUse.web_search_requests) }
          : {}),
        ...(usageRecord.service_tier ? { serviceTier: usageRecord.service_tier } : {}),
        ...(usageRecord.inference_geo ? { inferenceGeo: usageRecord.inference_geo } : {}),
        ...(usageRecord.speed ? { speed: usageRecord.speed } : {}),
      })
    }
    if (record.isApiErrorMessage || record.error) {
      this.addIncident({
        severity: 'error',
        category: 'api',
        title: `Claude API ${record.error || 'error'}`,
        detail: record.apiErrorStatus ? `HTTP ${record.apiErrorStatus}` : 'The model request failed.',
        ts,
        line,
        code: record.apiErrorStatus ? String(record.apiErrorStatus) : record.error,
      })
    }
    const made: TranscriptEvent[] = []
    const identity = this.identity(record)
    const eventMetadata = {
      ...identity,
      ...(record.requestId ? { requestId: record.requestId } : {}),
      ...(message.stop_reason !== undefined ? { stopReason: message.stop_reason } : {}),
      ...(record.effort ? { effort: record.effort } : {}),
    }

    for (const rawBlock of blocks) {
      const block = parseClaudeAssistantBlock(rawBlock)
      if (!block) continue
      if (block.kind === 'text' && block.data.text.trim()) {
        const text = block.data.text
        this.finalText = text
        const [body, full] = clip(text)
        made.push({ role: 'assistant', kind: 'text', ts, body, full, line, ...eventMetadata })
        recordMilestones(this.milestones, text, ts)
      } else if (block.kind === 'thinking' && block.data.thinking.trim()) {
        const [body, full] = clip(block.data.thinking)
        made.push({ role: 'assistant', kind: 'thinking', ts, body, full, line, ...eventMetadata })
      } else if (block.kind === 'tool_use') {
        made.push({ ...this.ingestToolUse(block.data, line, ts), ...eventMetadata })
      }
    }

    const finalEvent = made.at(-1)
    if (finalEvent && Object.keys(usageRecord).length) {
      finalEvent.usage = usage
    }
    if (finalEvent) finalEvent.model = message.model || ''
    this.events.push(...made)
  }

  private ingestToolUse(block: ClaudeToolUseBlock, line: number, ts: Timestamp): TranscriptEvent {
    const name = block.name || '?'
    const id = block.id
    const input = block.input
    const summary = toolSummary(input)
    const toolRecord = { name, summary, ts, input }
    this.counts[name] = (this.counts[name] || 0) + 1
    this.toolUses.set(id, toolRecord)
    this.openTools.set(id, toolRecord)

    if (name === 'Skill' && typeof input.skill === 'string') {
      this.skills.push({ skill: input.skill, ts })
    }
    if (SPAWN_TOOLS.has(name)) this.spawnIds.add(id)
    if (name === 'TodoWrite' && Array.isArray(input.todos)) {
      this.todos = input.todos.filter(Predicate.isObject).map((todo) => {
        const result: Todo = { status: asString(todo.status) }
        if (typeof todo.content === 'string') result.content = todo.content
        if (typeof todo.activeForm === 'string') result.activeForm = todo.activeForm
        return result
      })
    }
    if (EDIT_TOOLS.has(name)) {
      const filePath = asString(input.file_path) || asString(input.notebook_path) || asString(input.path)
      if (filePath) {
        recordFileChange(this.files, shortPath(filePath, this.cwd), name, ts)
      }
    }
    if (name === 'Bash') {
      const command = asString(input.command).trim().replace(/\s+/g, ' ')
      const run: CommandRun = { cmd: command.slice(0, 160), ts, ok: null, tid: id }
      this.commands.push(run)
      this.commandByToolId.set(id, run)
    }

    let inputText = ''
    try {
      inputText = clip(JSON.stringify(input, null, 2))[0]
    } catch {
      inputText = ''
    }
    return {
      role: 'assistant',
      kind: 'tool_use',
      ts,
      line,
      tool: name,
      id,
      summary,
      input: inputText,
      spawn: SPAWN_TOOLS.has(name),
      write: EDIT_TOOLS.has(name),
    }
  }

  private ingestUser(record: ClaudeUserRecord, line: number, ts: Timestamp): void {
    if (record.permissionMode) this.environment.permissionMode = record.permissionMode
    if (record.interruptedMessageId) {
      this.causalInterruptions += 1
      this.addIncident({
        severity: 'warning',
        category: 'interruption',
        title: 'Assistant response interrupted',
        detail: `Interrupted message ${record.interruptedMessageId.slice(0, 12)}`,
        ts,
        line,
        code: record.interruptedMessageId,
      })
    }
    if (record.toolDenialKind) {
      this.addIncident({
        severity: record.toolDenialKind === 'interrupted' ? 'warning' : 'error',
        category: 'permission',
        title: 'Tool request denied',
        detail: record.toolDenialKind.replace(/-/g, ' '),
        ts,
        line,
        code: record.toolDenialKind,
      })
    }

    const rawContent = record.message.content
    const blocks = Array.isArray(rawContent)
      ? rawContent
      : rawContent
        ? [{ type: 'text', text: rawContent }]
        : []

    for (const rawBlock of blocks) {
      const block = parseClaudeUserBlock(rawBlock)
      if (!block) continue
      if (block.kind === 'tool_result') {
        this.turnComplete = false
        const id = block.data.tool_use_id
        this.openTools.delete(id)
        if (
          this.spawnIds.has(id)
          && Predicate.isObject(record.toolUseResult)
          && record.toolUseResult.isAsync === true
        ) this.asyncSpawns.add(id)
        const text = resultText(block.data.content)
        const isError = Boolean(block.data.is_error) || text.trimStart().toLowerCase().startsWith('error')
        if (isError) this.errors += 1
        const command = this.commandByToolId.get(id)
        if (command) command.ok = commandOk(text, isError)
        const [body, full] = clip(text)
        const source = this.toolUses.get(id)
        if (isError) {
          this.addIncident({
            severity: 'error',
            category: 'tool',
            title: `${source?.name || 'Tool'} failed`,
            detail: compactText(text) || 'The tool returned an error.',
            ts,
            line,
            tool: source?.name,
            toolUseId: id,
          })
        }
        this.ingestToolMetadata(record.toolUseResult, source, id, line, ts)
        this.events.push({
          role: 'tool',
          kind: 'tool_result',
          ts,
          line,
          id,
          tool: source?.name || '',
          summary: (source?.summary || '').slice(0, 120),
          error: isError,
          body,
          full,
          ...this.identity(record),
          ...(record.promptId ? { promptId: record.promptId } : {}),
          ...(record.sourceToolAssistantUUID ? { sourceUuid: record.sourceToolAssistantUUID } : {}),
        })
      } else if (block.kind === 'text') {
        const text = block.data.text
        if (!text.trim()) continue
        // A task-notification fires when a background agent stops, so it
        // settles the async spawn its tool-use-id points at.
        for (const match of text.matchAll(/<task-notification>[\s\S]*?<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/g)) {
          this.asyncSpawns.delete(match[1]!)
        }
        const meta = Boolean(record.isMeta) || text.trimStart().startsWith('<system-reminder')
        if (!meta) this.turnComplete = false
        const [body, full] = clip(text)
        this.events.push({
          role: 'user',
          kind: meta ? 'meta' : 'prompt',
          ts,
          body,
          full,
          line,
          ...this.identity(record),
          ...(record.promptId ? { promptId: record.promptId } : {}),
        })
      }
    }
  }

  private ingestToolMetadata(
    value: unknown,
    source: ToolRecord | undefined,
    toolUseId: string,
    line: number,
    ts: Timestamp,
  ): void {
    if (!Predicate.isObject(value) || !source) return

    if (typeof value.timedOutAfterMs === 'number') {
      this.addIncident({
        severity: 'error',
        category: 'timeout',
        title: `${source.name} timed out`,
        detail: `Timed out after ${Math.round(value.timedOutAfterMs / 1_000)} seconds`,
        ts,
        line,
        tool: source.name,
        toolUseId,
      })
    }

    if ((EDIT_TOOLS.has(source.name)) && (value.structuredPatch || value.filePath)) {
      let linesAdded = 0
      let linesRemoved = 0
      if (Array.isArray(value.structuredPatch)) {
        for (const hunk of value.structuredPatch) {
          if (!Predicate.isObject(hunk) || !Array.isArray(hunk.lines)) continue
          for (const patchLine of hunk.lines) {
            if (typeof patchLine !== 'string') continue
            if (patchLine.startsWith('+') && !patchLine.startsWith('+++')) linesAdded += 1
            if (patchLine.startsWith('-') && !patchLine.startsWith('---')) linesRemoved += 1
          }
        }
      }
      const path = asString(value.filePath)
        || asString(source.input.file_path)
        || asString(source.input.notebook_path)
        || asString(source.input.path)
      if (path) {
        this.changeDetails.push({
          toolUseId,
          ts,
          tool: source.name,
          path: shortPath(path, this.cwd),
          linesAdded,
          linesRemoved,
          userModified: value.userModified === true,
          staleRecovered: value.staleRecovered === true,
        })
      }
      if (value.staleRecovered === true) {
        this.addIncident({
          severity: 'warning',
          category: 'tool',
          title: 'Recovered a stale edit',
          detail: shortPath(path, this.cwd),
          ts,
          line,
          tool: source.name,
          toolUseId,
        })
      }
    }

    if (source.name === 'Agent') {
      this.outcomes.push({
        toolUseId,
        ts,
        status: asString(value.status),
        model: asString(value.resolvedModel),
        durationMs: asNumber(value.totalDurationMs),
        totalTokens: asNumber(value.totalTokens),
        totalToolUseCount: asNumber(value.totalToolUseCount),
        stats: toolStats(value.toolStats),
      })
    }

    if (Predicate.isObject(value.gitOperation)) {
      const operation = value.gitOperation
      const commit = Predicate.isObject(operation.commit) ? operation.commit : null
      const push = Predicate.isObject(operation.push) ? operation.push : null
      const pr = Predicate.isObject(operation.pr) ? operation.pr : null
      const branch = Predicate.isObject(operation.branch) ? operation.branch : null
      if (commit) {
        this.gitEvents.push({
          toolUseId,
          ts,
          kind: 'commit',
          label: `Commit ${asString(commit.sha).slice(0, 10) || 'created'}`,
        })
      }
      if (push) {
        this.gitEvents.push({
          toolUseId,
          ts,
          kind: 'push',
          label: `Pushed ${asString(push.branch) || 'branch'}`,
        })
      }
      if (pr) {
        this.gitEvents.push({
          toolUseId,
          ts,
          kind: 'pr',
          label: `PR #${asNumber(pr.number)} ${asString(pr.action)}`.trim(),
          ...(asString(pr.url) ? { url: asString(pr.url) } : {}),
        })
      }
      if (branch) {
        this.gitEvents.push({
          toolUseId,
          ts,
          kind: 'branch',
          label: `${asString(branch.action) || 'Updated'} ${asString(branch.ref) || 'branch'}`,
        })
      }
    }
  }

  private ingestAttachment(value: unknown, line: number, ts: Timestamp): void {
    if (!Predicate.isObject(value)) return
    const type = asString(value.type)
    if (type === 'hook_non_blocking_error' || type === 'hook_cancelled') {
      const cancelled = type === 'hook_cancelled'
      this.addIncident({
        severity: cancelled ? 'warning' : 'error',
        category: 'hook',
        title: cancelled ? 'Hook was cancelled' : 'Hook failed',
        detail: [asString(value.hookEvent), asString(value.hookName), compactText(value.stderr, 140)]
          .filter(Boolean)
          .join(' · '),
        ts,
        line,
        code: value.exitCode === undefined ? undefined : String(value.exitCode),
        toolUseId: asString(value.toolUseID) || undefined,
      })
    } else if (type === 'read_truncation_notice') {
      this.addIncident({
        severity: 'warning',
        category: 'truncation',
        title: 'File read was truncated',
        detail: compactText(value.banner) || 'Claude did not receive the complete file content.',
        ts,
        line,
        toolUseId: asString(value.toolUseID) || undefined,
      })
    } else if (type === 'goal_status' && value.met === false) {
      this.addIncident({
        severity: 'warning',
        category: 'workflow',
        title: 'Goal condition was not met',
        detail: compactText(value.reason) || 'The workflow stopped before satisfying its goal.',
        ts,
        line,
      })
    }
  }

  private ingestSessionState(record: ClaudeSessionStateRecord, line: number, ts: Timestamp): void {
    if (record.type === 'permission-mode') {
      this.environment.permissionMode = record.permissionMode
    }
    if (record.type === 'pr-link') {
      this.gitEvents.push({
        toolUseId: `state-${line}`,
        ts,
        kind: 'pr',
        label: `PR #${record.prNumber}`,
        ...(record.prUrl ? { url: record.prUrl } : {}),
      })
    }
  }

  currentActivity(): CurrentActivity | null {
    const record = Array.from(this.openTools.values()).at(-1)
    return record ? { tool: record.name, summary: record.summary.slice(0, 160), ts: record.ts } : null
  }

  diagnostics(): ScanDiagnostics {
    return {
      incidents: this.incidents,
      turns: this.turns,
      context: this.context,
      compactions: this.compactions,
      outcomes: this.outcomes,
      changes: this.changeDetails,
      git: this.gitEvents,
      environment: { ...this.environment },
      causal: {
        records: this.causalRecords,
        recordsWithUuid: this.causalRecordsWithUuid,
        branchPoints: this.causalBranchPoints,
        sidechainRecords: this.causalSidechainRecords,
        interruptions: this.causalInterruptions,
      },
    }
  }

  /**
   * Current time comes from the Clock, so `live` and `ago` are testable via
   * `TestClock` instead of depending on wall-clock time.
   */
  get stats(): Effect.Effect<TranscriptStats> {
    return Clock.currentTimeMillis.pipe(
      Effect.map(millis => this.statsAt(millis / 1_000)),
    )
  }

  statsAt(now: number): TranscriptStats {
    const files: FileChange[] = Array.from(this.files, ([path, value]) => ({ path, ...value }))
      .sort((a, b) => b.ops - a.ops)
    const { tools, reads } = toolStatsFromCounts(this.counts, READ_TOOLS)

    return {
      records: this.line,
      tools,
      toolCounts: { ...this.counts },
      reads,
      errors: this.errors,
      tokensOut: this.tokensOut,
      firstTs: this.firstTs,
      lastTs: this.lastTs,
      mtime: this.mtime,
      ago: Math.trunc(now - this.mtime),
      live: !this.turnComplete && now - this.mtime < LIVE_WINDOW,
      size: this.size,
      todos: this.todos,
      skills: this.skills.slice(-6),
      milestones: this.milestones.slice(-10),
      current: this.currentActivity(),
      files,
      commands: this.commands.slice(-40),
      finalText: this.finalText.slice(0, 600),
    }
  }
}

// Scans are cached by the `ScanCache` service in ./services, not by a
// module-level map — providing that layer per test replaces the old
// `resetScanCache()` hook.
