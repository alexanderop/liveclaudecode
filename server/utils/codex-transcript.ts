import { Effect, Predicate, Result } from 'effect'
import {
  parseCodexPlanInput,
  parseCodexRecord,
  parseCodexSessionSource,
  parseCodexTextContent,
  parseCodexToolArgumentsJson,
  parseCodexToolOutput,
  parseCodexToolOutputJson,
  type CodexEventPayload,
  type ParsedCodexRecord,
  type CodexResponseItem,
  type CodexSessionMetaPayload,
  type CodexTurnContextPayload,
} from '#shared/schemas/codex'
import { FAILED_OUTCOME_STATUS_SET, PASSED_OUTCOME_STATUS_SET } from '#shared/schemas/tool-outcome'
import type {
  CommandRun,
  CurrentActivity,
  DiagnosticIncident,
  FileChange,
  Milestone,
  ScanDiagnostics,
  SessionEnvironment,
  Timestamp,
  Todo,
  TranscriptEvent,
  TranscriptStats,
  Usage,
} from '#shared/types/run'
import { normalizeSessionLabel } from '#shared/utils/session-label'
import {
  clip,
  resultText,
  shortPath,
  toolSummary,
} from './transcript-content'
import { consumeNewRecords } from './incremental-jsonl'
import { ParseIssueLog } from './parse-issues'
import {
  compactText,
  type MutableFileChange,
  pushIncident,
  recordFileChange,
  recordMilestones,
  statsNow,
  toolStatsFromCounts,
} from './transcript-scan-core'
import { emptyEnvironment, emptyUsage } from './run-shared'

interface CodexToolRecord {
  name: string
  summary: string
  ts: Timestamp
  input: Readonly<Record<string, unknown>>
}

export interface CodexSessionMetadata {
  id: string
  cwd: string
  originator: string
  producerSource: string
  threadSource: string
  modelProvider: string
  cliVersion: string
  gitBranch: string
  parentThreadId: string | null
  agentPath: string
  agentNickname: string
  agentRole: string
  spawnDepth: number | null
}

const EMPTY_METADATA: CodexSessionMetadata = {
  id: '',
  cwd: '',
  originator: '',
  producerSource: '',
  threadSource: '',
  modelProvider: '',
  cliVersion: '',
  gitBranch: '',
  parentThreadId: null,
  agentPath: '',
  agentNickname: '',
  agentRole: '',
  spawnDepth: null,
}

const READ_TOOLS = new Set([
  'read_file',
  'view_image',
  'open',
  'find',
  'search_query',
  'image_query',
  'read_mcp_resource',
])

function finite(value: number | undefined): number {
  return value === undefined ? 0 : value
}

/**
 * A `function_call`'s `arguments` arrive JSON-encoded, so a string that fails to
 * decode is a shape we cannot model and feeds `onMalformed`. A
 * `custom_tool_call`'s `input` is free-form text by design — `exec` carries
 * JavaScript and `apply_patch` carries patch text — so its callers pass no
 * `onMalformed` and take the empty fallback silently.
 */
function parseArguments(value: string, onMalformed?: () => void): Readonly<Record<string, unknown>> {
  const decoded = parseCodexToolArgumentsJson(value)
  if (Result.isSuccess(decoded)) return decoded.success
  onMalformed?.()
  return {}
}

/**
 * Tool output is JSON only when the tool chose to emit it that way; plain text
 * is just as normal, and both leave the outcome undetermined rather than
 * signalling a transcript we mis-model. A decode failure is therefore not a
 * parse issue.
 */
function explicitToolOutcome(value: unknown): boolean | null {
  const output = typeof value === 'string'
    ? Result.match(parseCodexToolOutputJson(value), {
      onSuccess: success => success,
      onFailure: () => null,
    })
    : parseCodexToolOutput(value)
  if (!output) return null
  if (output.isError === true || output.error === true) return false
  if (output.exit_code !== undefined) return output.exit_code === 0
  if (output.success !== undefined) return output.success
  const status = output.status?.trim().toLowerCase()
  if (status && FAILED_OUTCOME_STATUS_SET.has(status)) return false
  if (status && PASSED_OUTCOME_STATUS_SET.has(status)) return true
  if (output.isError === false || output.error === false) return true
  return null
}

function displayToolName(name: string): string {
  return name.split('.').at(-1) || name || '?'
}

function contentText(content: ReadonlyArray<unknown>): string {
  return content.flatMap((block) => {
    const parsed = parseCodexTextContent(block)
    return parsed ? [parsed.text] : []
  }).join('\n')
}

export class CodexTranscriptScan {
  readonly path: string
  line = 0
  malformed = 0
  unknown = 0
  readonly events: TranscriptEvent[] = []
  readonly counts: Record<string, number> = {}
  readonly toolUses = new Map<string, CodexToolRecord>()
  readonly openTools = new Map<string, CodexToolRecord>()
  readonly files = new Map<string, MutableFileChange>()
  readonly commands: CommandRun[] = []
  readonly commandByToolId = new Map<string, CommandRun>()
  readonly milestones: Milestone[] = []
  readonly incidents: DiagnosticIncident[] = []
  readonly compactions: ScanDiagnostics['compactions'] = []
  readonly metadata: CodexSessionMetadata = { ...EMPTY_METADATA }
  readonly environment: SessionEnvironment = emptyEnvironment()
  todos: Todo[] | null = null
  firstPrompt = ''
  finalText = ''
  model = ''
  effort = ''
  firstTs: Timestamp = null
  lastTs: Timestamp = null
  usage: Usage = emptyUsage()
  /** Why the `malformed` records were skipped; see `ParseIssueLog`. */
  readonly parseIssues = new ParseIssueLog()
  taskActive = false
  mtime = 0
  size = 0
  bytesConsumed = 0
  lastLoadedMtime = 0
  lastLoadedSize = -1

  constructor(path: string | URL) {
    this.path = path.toString()
  }

  /** Parse the records appended since the last refresh; see consumeNewRecords. */
  readonly refresh = Effect.fn('CodexTranscriptScan.refresh')(function*(this: CodexTranscriptScan) {
    const { records, malformed, next } = yield* consumeNewRecords(this.path, this)
    this.line = next.line
    this.malformed = next.malformed
    this.mtime = next.mtime
    this.size = next.size
    this.bytesConsumed = next.bytesConsumed
    this.lastLoadedMtime = next.lastLoadedMtime
    this.lastLoadedSize = next.lastLoadedSize

    for (const entry of malformed) {
      this.parseIssues.recordInvalidJson(entry.index, entry.line, entry.error)
    }

    for (const [index, value] of records) {
      const parsed = parseCodexRecord(value)
      if (!parsed.success) {
        yield* Effect.logDebug('Skipping malformed Codex transcript record', { path: this.path, line: index })
        this.malformed += 1
        this.parseIssues.recordSchemaMismatch(index, value, parsed.error)
        continue
      }
      if (parsed.record.kind === 'unknown') this.unknown += 1
      this.ingest(parsed.record, index)
    }
    return this
  })

  private ingest(record: ParsedCodexRecord, line: number): void {
    const timestamp = record.timestamp || null
    if (timestamp) {
      this.firstTs ||= timestamp
      this.lastTs = timestamp
    }
    if (record.kind === 'session_meta') this.ingestSessionMeta(record.data)
    else if (record.kind === 'turn_context') this.ingestTurnContext(record.data)
    else if (record.kind === 'response_item') this.ingestResponseItem(record.data, line, timestamp)
    else if (record.kind === 'event_msg' && record.known) this.ingestEvent(record.data, line, timestamp)
  }

  private ingestSessionMeta(data: CodexSessionMetaPayload): void {
    this.metadata.id = data.id
    this.metadata.cwd = data.cwd || this.metadata.cwd
    this.metadata.originator = data.originator || this.metadata.originator
    this.metadata.threadSource = data.thread_source || this.metadata.threadSource
    this.metadata.modelProvider = data.model_provider || this.metadata.modelProvider
    this.metadata.cliVersion = data.cli_version || this.metadata.cliVersion
    this.metadata.gitBranch = data.git?.branch || this.metadata.gitBranch
    this.environment.cwd = this.metadata.cwd
    this.environment.gitBranch = this.metadata.gitBranch
    this.environment.version = this.metadata.cliVersion
    this.environment.entrypoint = this.metadata.originator

    const source = parseCodexSessionSource(data.source)
    if (typeof source === 'string') {
      this.metadata.producerSource = source
      return
    }
    if (!source) return
    this.metadata.producerSource = 'subagent'
    if (typeof source.subagent === 'string') {
      this.metadata.agentRole = source.subagent
      return
    }
    const spawn = source.subagent.thread_spawn
    this.metadata.parentThreadId = spawn.parent_thread_id
    this.metadata.agentPath = spawn.agent_path || ''
    this.metadata.agentNickname = spawn.agent_nickname || ''
    this.metadata.agentRole = spawn.agent_role || ''
    this.metadata.spawnDepth = spawn.depth ?? null
  }

  private ingestTurnContext(data: CodexTurnContextPayload): void {
    this.metadata.cwd ||= data.cwd || ''
    this.environment.cwd ||= data.cwd || ''
    this.environment.permissionMode = data.approval_policy || this.environment.permissionMode
    this.model = data.model || this.model
    this.effort = data.effort || this.effort
  }

  private ingestResponseItem(item: CodexResponseItem, line: number, ts: Timestamp): void {
    if (item.type === 'message') {
      const text = contentText(item.content)
      if (!text.trim()) return
      const [body, full] = clip(text)
      const role = item.role === 'assistant'
        ? 'assistant'
        : item.role === 'user' ? 'user' : 'system'
      const kind = item.role === 'assistant'
        ? 'text'
        : item.role === 'user' ? 'prompt' : 'meta'
      this.events.push({ role, kind, ts, line, body, full, model: this.model || undefined })
      if (item.role === 'user') this.firstPrompt ||= normalizeSessionLabel(text)
      if (item.role === 'assistant') {
        this.finalText = text
        recordMilestones(this.milestones, text, ts)
      }
      return
    }
    if (item.type === 'reasoning') {
      const text = contentText(item.summary || [])
      if (!text.trim()) return
      const [body, full] = clip(text)
      this.events.push({ role: 'assistant', kind: 'thinking', ts, line, body, full, model: this.model || undefined })
      return
    }
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const rawName = item.name
      const name = displayToolName(rawName)
      const id = item.call_id
      const encoded = item.type === 'function_call' ? item.arguments : item.input
      const input = item.type === 'function_call'
        ? parseArguments(encoded, () => {
          this.malformed += 1
          this.parseIssues.recordUnsupportedShape(
            line,
            encoded,
            `Tool call ${rawName} carried arguments that are not valid JSON`,
            rawName,
          )
        })
        : parseArguments(encoded)
      const commandText = name === 'exec_command' && typeof input.cmd === 'string'
        ? input.cmd.trim().replace(/\s+/g, ' ').slice(0, 160)
        : ''
      const summary = commandText || toolSummary(input)
      const tool = { name, summary, ts, input }
      this.counts[name] = (this.counts[name] || 0) + 1
      this.toolUses.set(id, tool)
      this.openTools.set(id, tool)

      if (name === 'update_plan') {
        const plan = parseCodexPlanInput(input)
        if (plan) this.todos = plan.plan.map(item => ({ content: item.step, status: item.status }))
      }
      if (name === 'exec_command') {
        const run: CommandRun = { cmd: commandText, ts, ok: null, tid: id }
        this.commands.push(run)
        this.commandByToolId.set(id, run)
      }

      this.events.push({
        role: 'assistant',
        kind: 'tool_use',
        ts,
        line,
        tool: name,
        id,
        summary,
        input: encoded.slice(0, 8_000),
        spawn: name === 'spawn_agent',
        write: name === 'apply_patch',
      })
      return
    }

    const id = item.call_id
    const source = this.toolUses.get(id)
    const outcome = explicitToolOutcome(item.output)
    const error = outcome === false
    this.openTools.delete(id)
    const text = resultText(item.output)
    const command = this.commandByToolId.get(id)
    if (command) command.ok = outcome
    if (error) this.addIncident({
      severity: 'error',
      category: 'tool',
      title: `${source?.name || 'Tool'} failed`,
      detail: compactText(item.output) || 'The tool explicitly returned an error.',
      ts,
      line,
      tool: source?.name,
      toolUseId: id,
    })
    const [body, full] = clip(text)
    this.events.push({
      role: 'tool',
      kind: 'tool_result',
      ts,
      line,
      id,
      tool: source?.name || '',
      summary: source?.summary || '',
      error,
      body,
      full,
    })
  }

  private ingestEvent(event: CodexEventPayload, line: number, ts: Timestamp): void {
    if (event.type === 'task_started') {
      this.taskActive = true
      return
    }
    if (event.type === 'task_complete') {
      this.taskActive = false
      return
    }
    if (event.type === 'turn_aborted') {
      this.taskActive = false
      this.addIncident({
        severity: 'warning',
        category: 'interruption',
        title: 'Codex turn aborted',
        detail: event.reason || 'The turn ended before normal completion.',
        ts,
        line,
      })
      return
    }
    if (event.type === 'context_compacted') {
      this.compactions.push({
        ts,
        durationMs: 0,
        preTokens: 0,
        postTokens: 0,
        droppedTokens: 0,
        preservedMessages: 0,
        trigger: 'Codex context compaction',
      })
      return
    }
    if (event.type === 'token_count') {
      const usage = event.info?.total_token_usage
      if (usage) {
        this.usage = {
          in: finite(usage.input_tokens),
          out: finite(usage.output_tokens),
          cr: finite(usage.cached_input_tokens),
          cw: 0,
        }
      }
      return
    }
    if (event.type === 'agent_message') {
      this.finalText = event.message
      recordMilestones(this.milestones, event.message, ts)
      return
    }
    if (event.type === 'patch_apply_end') {
      for (const path of Object.keys(event.changes || {})) this.addFile(path, 'apply_patch', ts)
      if (event.success === false) {
        this.addIncident({
          severity: 'error',
          category: 'tool',
          title: 'Patch application failed',
          detail: compactText(event.stderr) || event.status || 'Codex reported an unsuccessful patch.',
          ts,
          line,
          tool: 'apply_patch',
          toolUseId: event.call_id,
        })
      }
      return
    }
    if (event.type === 'mcp_tool_call_end' && Predicate.isObject(event.result) && Object.hasOwn(event.result, 'Err')) {
      this.addIncident({
        severity: 'error',
        category: 'tool',
        title: `${event.invocation?.tool || 'MCP tool'} failed`,
        detail: compactText(event.result.Err) || 'The MCP call returned an explicit error.',
        ts,
        line,
        tool: event.invocation?.tool,
        toolUseId: event.call_id,
      })
    }
  }

  private addFile(path: string, tool: string, ts: Timestamp): void {
    recordFileChange(this.files, shortPath(path, this.metadata.cwd || this.environment.cwd), tool, ts)
  }

  private addIncident(incident: Omit<DiagnosticIncident, 'id'>): void {
    pushIncident(this.incidents, incident)
  }

  currentActivity(): CurrentActivity | null {
    const tool = Array.from(this.openTools.values()).at(-1)
    if (tool) return { tool: tool.name, summary: tool.summary.slice(0, 160), ts: tool.ts }
    return this.taskActive ? { tool: 'Codex', summary: 'Working', ts: this.lastTs } : null
  }

  diagnostics(): ScanDiagnostics {
    const hasUsage = Object.values(this.usage).some(Boolean)
    return {
      incidents: this.incidents,
      turns: [],
      context: hasUsage ? [{
        ts: this.lastTs,
        model: this.model,
        effort: this.effort,
        usage: { ...this.usage },
        stopReason: null,
      }] : [],
      compactions: this.compactions,
      outcomes: [],
      changes: Array.from(this.files, ([path, value], index) => ({
        toolUseId: `codex-change-${index}`,
        ts: value.lastTs,
        tool: value.tools[0] || 'apply_patch',
        path,
        linesAdded: 0,
        linesRemoved: 0,
        userModified: false,
        staleRecovered: false,
      })),
      git: [],
      environment: { ...this.environment },
      causal: {
        records: this.line,
        recordsWithUuid: 0,
        branchPoints: 0,
        sidechainRecords: 0,
        interruptions: this.incidents.filter(incident => incident.category === 'interruption').length,
      },
    }
  }

  get stats(): Effect.Effect<TranscriptStats> {
    return statsNow(this)
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
      errors: this.incidents.filter(incident => incident.severity === 'error').length,
      tokensOut: this.usage.out,
      firstTs: this.firstTs,
      lastTs: this.lastTs,
      mtime: this.mtime,
      ago: Math.trunc(now - this.mtime),
      live: this.taskActive || this.openTools.size > 0,
      size: this.size,
      todos: this.todos,
      skills: [],
      milestones: this.milestones.slice(-10),
      current: this.currentActivity(),
      files,
      commands: this.commands.slice(-40),
      finalText: this.finalText.slice(0, 600),
    }
  }
}
