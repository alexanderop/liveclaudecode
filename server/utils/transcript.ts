import { Clock, Effect, Option, Predicate } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type * as PlatformError from 'effect/PlatformError'
import {
  parseClaudeAssistantBlock,
  parseClaudeRecord,
  parseClaudeUserBlock,
  type ClaudeAssistantRecord,
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

export const MAX_CHARS = 8_000
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

interface MutableFileChange {
  ops: number
  tools: string[]
  lastTs: Timestamp
}

const TOOL_SUMMARY_KEYS = [
  'command',
  'file_path',
  'pattern',
  'path',
  'description',
  'prompt',
  'query',
  'url',
  'skill',
  'notebook_path',
  'old_string',
]

const PHASE_PATTERNS = [
  /^\s{0,3}(?:[-*]\s*)?(?:#{1,4}\s*)?(?:\*\*)?\s*((?:Wave|Phase|Slice|Step|Round|Stage)\s+[\w\d.]+[^\n*]{0,70})/gim,
  /^\s{0,3}\*\*([^\n*]{4,70})\*\*:?\s*$/gm,
  /^\s{0,3}#{1,4}\s+([^\n]{4,70})$/gm,
]

const FAIL_RE = /\b(\d+ failed|FAIL\b|failing|error TS\d+|Error:|✗|✘|command not found|exit code [1-9]|Test Files\s+\d+ failed)/i
const PASS_RE = /\b(passed|✓|PASS\b|0 problems|no issues|success)/i

/**
 * `Predicate.isObject` excludes arrays and null, matching what this module
 * needs from a "plain JSON object" check.
 */
const isRecord = (value: unknown): value is JsonRecord => Predicate.isObject(value)

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asTimestamp(value: unknown): Timestamp {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function compactText(value: unknown, limit = 240): string {
  if (typeof value === 'string') return value.trim().replace(/\s+/g, ' ').slice(0, limit)
  if (!isRecord(value)) return ''
  try {
    return JSON.stringify(value).replace(/\s+/g, ' ').slice(0, limit)
  } catch {
    return ''
  }
}

function toolStats(value: unknown): ToolStats {
  const stats = isRecord(value) ? value : {}
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

export function plainText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .flatMap((block) => {
      if (typeof block === 'string') return [block]
      if (isRecord(block) && block.type === 'text') return [asString(block.text)]
      return []
    })
    .join('\n')
}

export function toolSummary(input: unknown): string {
  if (!isRecord(input)) return ''

  for (const key of TOOL_SUMMARY_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim().replace(/\s+/g, ' ')
    }
  }

  try {
    return JSON.stringify(input).slice(0, 200)
  } catch {
    return ''
  }
}

export function resultText(result: unknown): string {
  if (typeof result === 'string') return result
  if (Array.isArray(result)) {
    return result
      .flatMap((block) => {
        if (typeof block === 'string') return [block]
        if (!isRecord(block)) return []
        if (block.type === 'text') return [asString(block.text)]
        if (block.type === 'image') return ['[image]']
        return []
      })
      .join('\n')
  }
  if (isRecord(result)) {
    try {
      return JSON.stringify(result, null, 2)
    } catch {
      return String(result)
    }
  }
  return ''
}

export function clip(value: string): [body: string, originalLength: number] {
  const text = value || ''
  return [text.slice(0, MAX_CHARS), text.length]
}

export function findMilestones(text: string): Array<[title: string, strong: boolean]> {
  for (const [index, pattern] of PHASE_PATTERNS.entries()) {
    pattern.lastIndex = 0
    const matches = Array.from(text.matchAll(pattern))
      .map(match => ({
        index: match.index,
        title: (match[1] || '').replace(/\s+/g, ' ').replace(/^[ *:#-]+|[ *:#-]+$/g, ''),
      }))
      .sort((a, b) => a.index - b.index)

    if (matches.length) return matches.map(match => [match.title, index === 0])
  }
  return []
}

export function commandOk(output: string, isError: boolean): boolean {
  if (isError) return false
  const head = (output || '').slice(0, 2_500)
  return !(FAIL_RE.test(head) && !PASS_RE.test(head.slice(0, 200)))
}

export function shortPath(path: string, root = ''): string {
  if (!path) return ''
  const prefix = `${root.replace(/\/$/, '')}/`
  if (root && path.startsWith(prefix)) return path.slice(prefix.length)
  const parts = path.split('/')
  return parts.length > 3 ? parts.slice(-3).join('/') : path
}

export class TranscriptScan {
  readonly path: string
  line = 0
  readonly events: TranscriptEvent[] = []
  readonly toolUses = new Map<string, ToolRecord>()
  readonly openTools = new Map<string, ToolRecord>()
  readonly spawnIds = new Set<string>()
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
  private mtime = 0
  private size = 0

  constructor(path: string | URL) {
    this.path = path.toString()
  }

  /**
   * Re-read the transcript from the last line consumed.
   *
   * A missing transcript is not an error — the tree is polled while Claude Code
   * is still creating files. Any other filesystem failure propagates.
   */
  get refresh(): Effect.Effect<this, PlatformError.PlatformError, FileSystem.FileSystem> {
    const self = this
    return Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem

      const contents = yield* Effect.all([
        fs.readFileString(self.path),
        fs.stat(self.path),
      ]).pipe(
        Effect.map(Option.some),
        Effect.catchIf(
          error => error.reason._tag === 'NotFound',
          () => Effect.succeed(Option.none<[string, FileSystem.File.Info]>()),
        ),
      )
      if (Option.isNone(contents)) return self

      const [raw, info] = contents.value
      self.mtime = Option.match(info.mtime, {
        onNone: () => self.mtime,
        onSome: date => date.getTime() / 1_000,
      })
      self.size = Number(info.size)

      const completeLines = raw.split('\n').slice(0, -1)
      for (let index = self.line; index < completeLines.length; index += 1) {
        const line = completeLines[index]
        if (!line?.trim()) continue
        // Claude Code can leave a half-written line while appending; skip it.
        let value: unknown
        try {
          value = JSON.parse(line)
        } catch {
          continue
        }
        const parsed = parseClaudeRecord(value)
        if (parsed.success) self.ingest(parsed.record, index)
      }
      self.line = completeLines.length
      return self
    })
  }

  private ingest(record: ParsedClaudeRecord, line: number): void {
    const raw = record.data as JsonRecord
    const timestamp = asTimestamp(raw.timestamp)
    this.causalRecords += 1
    if (typeof raw.uuid === 'string') this.causalRecordsWithUuid += 1
    if (typeof raw.parentUuid === 'string') {
      const children = (this.causalChildren.get(raw.parentUuid) || 0) + 1
      this.causalChildren.set(raw.parentUuid, children)
      if (children === 2) this.causalBranchPoints += 1
    }
    if (raw.isSidechain === true) this.causalSidechainRecords += 1

    const cwd = asString(raw.cwd)
    this.cwd ||= cwd
    this.environment.cwd = cwd || this.environment.cwd
    this.environment.gitBranch = asString(raw.gitBranch) || this.environment.gitBranch
    this.environment.version = asString(raw.version) || this.environment.version
    this.environment.entrypoint = asString(raw.entrypoint) || this.environment.entrypoint
    this.environment.permissionMode = asString(raw.permissionMode) || this.environment.permissionMode
    if (timestamp) {
      this.firstTs ||= timestamp
      this.lastTs = timestamp
    }

    if (record.kind === 'assistant') this.ingestAssistant(record.data, line, timestamp)
    else if (record.kind === 'user') this.ingestUser(record.data, line, timestamp)
    else if (record.kind === 'system') this.ingestSystem(record.data, line, timestamp)
    else if (record.kind === 'attachment') this.ingestAttachment(record.data.attachment, line, timestamp)
    else if (record.kind === 'session_state') this.ingestSessionState(record.data, line, timestamp)
  }

  private identity(record: JsonRecord): Pick<TranscriptEvent, 'uuid' | 'parentUuid' | 'sidechain'> {
    const identity: Pick<TranscriptEvent, 'uuid' | 'parentUuid' | 'sidechain'> = {}
    if (typeof record.uuid === 'string') identity.uuid = record.uuid
    if (typeof record.parentUuid === 'string' || record.parentUuid === null) identity.parentUuid = record.parentUuid
    if (typeof record.isSidechain === 'boolean') identity.sidechain = record.isSidechain
    return identity
  }

  private addIncident(incident: Omit<DiagnosticIncident, 'id'>): void {
    this.incidents.push({ ...incident, id: `${incident.line}:${incident.category}:${this.incidents.length}` })
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

    if (record.subtype === 'compact_boundary' && isRecord(record.compactMetadata)) {
      const metadata = record.compactMetadata
      this.compactions.push({
        ts: timestamp,
        durationMs: asNumber(metadata.durationMs),
        preTokens: asNumber(metadata.preTokens),
        postTokens: asNumber(metadata.postTokens),
        droppedTokens: asNumber(metadata.cumulativeDroppedTokens),
        preservedMessages: asNumber(metadata.preservedMessages),
        trigger: asString(metadata.trigger),
      })
    }

    const raw = record as JsonRecord
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
    if (record.subtype === 'stop_hook_summary'
      && (asNumber(raw.hookErrors) > 0 || raw.preventedContinuation === true)) {
      this.addIncident({
        severity: raw.preventedContinuation === true ? 'error' : 'warning',
        category: 'hook',
        title: raw.preventedContinuation === true ? 'Stop hook prevented continuation' : 'Stop hook reported errors',
        detail: `${asNumber(raw.hookErrors)} hook errors`,
        ts: timestamp,
        line,
        toolUseId: asString(raw.toolUseID) || undefined,
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
        ...this.identity(record as JsonRecord),
      })
    }
  }

  private ingestAssistant(record: ClaudeAssistantRecord, line: number, ts: Timestamp): void {
    const message = record.message
    const rawContent = message.content
    const blocks = Array.isArray(rawContent)
      ? rawContent
      : typeof rawContent === 'string'
        ? [{ type: 'text', text: rawContent }]
        : []
    const usageRecord = message.usage || {}
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
        ...(record.requestId ? { requestId: record.requestId } : {}),
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
    const identity = this.identity(record as JsonRecord)
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
        for (const [title, strong] of findMilestones(text)) {
          if (this.milestones.at(-1)?.title !== title) {
            this.milestones.push({ title: title.slice(0, 90), ts, strong })
          }
        }
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
      this.todos = input.todos.filter(isRecord).map((todo) => {
        const result: Todo = { status: asString(todo.status) }
        if (typeof todo.content === 'string') result.content = todo.content
        if (typeof todo.activeForm === 'string') result.activeForm = todo.activeForm
        return result
      })
    }
    if (EDIT_TOOLS.has(name)) {
      const filePath = asString(input.file_path) || asString(input.notebook_path) || asString(input.path)
      if (filePath) {
        const key = shortPath(filePath, this.cwd)
        const change = this.files.get(key) || { ops: 0, tools: [], lastTs: ts }
        change.ops += 1
        change.lastTs = ts
        if (!change.tools.includes(name)) change.tools.push(name)
        this.files.set(key, change)
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
        const id = block.data.tool_use_id
        this.openTools.delete(id)
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
          ...this.identity(record as JsonRecord),
          ...(record.promptId ? { promptId: record.promptId } : {}),
          ...(record.sourceToolAssistantUUID ? { sourceUuid: record.sourceToolAssistantUUID } : {}),
        })
      } else if (block.kind === 'text') {
        const text = block.data.text
        if (!text.trim()) continue
        const meta = Boolean(record.isMeta) || text.trimStart().startsWith('<system-reminder')
        const [body, full] = clip(text)
        this.events.push({
          role: 'user',
          kind: meta ? 'meta' : 'prompt',
          ts,
          body,
          full,
          line,
          ...this.identity(record as JsonRecord),
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
    if (!isRecord(value) || !source) return

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
          if (!isRecord(hunk) || !Array.isArray(hunk.lines)) continue
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

    if (isRecord(value.gitOperation)) {
      const operation = value.gitOperation
      const commit = isRecord(operation.commit) ? operation.commit : null
      const push = isRecord(operation.push) ? operation.push : null
      const pr = isRecord(operation.pr) ? operation.pr : null
      const branch = isRecord(operation.branch) ? operation.branch : null
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
    if (!isRecord(value)) return
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

  private ingestSessionState(value: unknown, line: number, ts: Timestamp): void {
    if (!isRecord(value)) return
    if (value.type === 'permission-mode') {
      this.environment.permissionMode = asString(value.permissionMode)
    }
    if (value.type === 'pr-link') {
      this.gitEvents.push({
        toolUseId: `state-${line}`,
        ts,
        kind: 'pr',
        label: `PR #${asNumber(value.prNumber)}`,
        ...(asString(value.prUrl) ? { url: asString(value.prUrl) } : {}),
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

    return {
      records: this.line,
      tools: Object.values(this.counts).reduce((total, count) => total + count, 0),
      toolCounts: { ...this.counts },
      reads: Object.entries(this.counts)
        .filter(([name]) => READ_TOOLS.has(name))
        .reduce((total, [, count]) => total + count, 0),
      errors: this.errors,
      tokensOut: this.tokensOut,
      firstTs: this.firstTs,
      lastTs: this.lastTs,
      mtime: this.mtime,
      ago: Math.trunc(now - this.mtime),
      live: now - this.mtime < LIVE_WINDOW,
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
