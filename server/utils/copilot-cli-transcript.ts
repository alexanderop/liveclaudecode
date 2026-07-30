import { Clock, DateTime, Effect, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type * as PlatformError from 'effect/PlatformError'
import {
  parseCopilotCliArguments,
  parseCopilotCliEvent,
  parseCopilotCliToolRequest,
  parseCopilotCliToolResult,
  type ParsedCopilotCliEvent,
} from '#shared/schemas/copilot-cli'
import type {
  ChangeDetail,
  CommandRun,
  DiagnosticIncident,
  FileChange,
  RunDiagnostics,
  SessionEnvironment,
  Timestamp,
  TranscriptEvent,
  TranscriptStats,
} from '#shared/types/run'
import { normalizeSessionLabel } from '#shared/utils/session-label'
import {
  emptyTranscriptDiagnostics,
  emptyTranscriptStats,
  reconcileTranscriptEvents,
  TranscriptFile,
} from './copilot-transcript-state'
import { clip, shortPath } from './transcript-content'

interface ToolRecord {
  name: string
  summary: string
  input: unknown
  ts: Timestamp
  line: number
}

interface MutableFileChange {
  ops: number
  tools: string[]
  lastTs: Timestamp
}

interface DerivedState {
  stats: TranscriptStats
  diagnostics: RunDiagnostics
  title: string
  model: string
  workingDirectory: string
  sourceDetail: string
}

const READ_TOOLS = new Set(['view', 'glob', 'rg', 'web_fetch', 'read_bash', 'read_agent'])

const EMPTY_ENVIRONMENT: SessionEnvironment = {
  cwd: '',
  gitBranch: '',
  version: '',
  entrypoint: '',
  permissionMode: '',
}

function compact(value: string, limit = 240): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, limit)
}

function encoded(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 8_000)
  try {
    return JSON.stringify(value).slice(0, 8_000)
  } catch {
    return ''
  }
}

function toolSummary(name: string, value: unknown, intention = ''): string {
  if (intention.trim()) return compact(intention)
  if (typeof value === 'string') return compact(value)
  const arguments_ = parseCopilotCliArguments(value)
  if (!arguments_) return name
  for (const key of ['command', 'description', 'path', 'pattern', 'intent', 'url', 'query']) {
    const candidate = arguments_[key]
    if (typeof candidate === 'string' && candidate.trim()) return compact(candidate)
  }
  return compact(encoded(arguments_)) || name
}

function toolResultText(value: unknown): string {
  if (typeof value === 'string') return value
  const result = parseCopilotCliToolResult(value)
  if (result) return result.detailedContent || result.content || ''
  return encoded(value)
}

function timestampMillis(value: string): number | null {
  return Option.match(DateTime.make(value), {
    onNone: () => null,
    onSome: DateTime.toEpochMillis,
  })
}

function addFile(
  files: Map<string, MutableFileChange>,
  path: string,
  tool: string,
  ts: Timestamp,
  workspace: string,
): void {
  const key = shortPath(path, workspace)
  if (!key) return
  const existing = files.get(key) || { ops: 0, tools: [], lastTs: ts }
  existing.ops += 1
  existing.lastTs = ts
  if (!existing.tools.includes(tool)) existing.tools.push(tool)
  files.set(key, existing)
}

function filePaths(name: string, input: unknown): string[] {
  const arguments_ = parseCopilotCliArguments(input)
  if ((name === 'create' || name === 'edit') && arguments_) {
    const path = arguments_.path
    return typeof path === 'string' ? [path] : []
  }
  if (name !== 'apply_patch' || typeof input !== 'string') return []
  return Array.from(input.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm), match => match[1]!.trim())
}

export class CopilotCliTranscriptScan {
  readonly path: string
  readonly application: string
  readonly workspace: string
  line = 0
  malformed = 0
  unknown = 0
  malformedParts = 0
  structuralMalformed = 0
  supported = false
  sessionId = ''
  readonly events: TranscriptEvent[] = []
  eventRevision = 0
  private readonly file: TranscriptFile
  private derived: DerivedState | null = null

  constructor(path: string | URL, application = 'GitHub Copilot CLI', workspace = '') {
    this.path = path.toString()
    this.application = application
    this.workspace = workspace
    this.file = new TranscriptFile(this.path)
  }

  get refresh(): Effect.Effect<this, PlatformError.PlatformError, FileSystem.FileSystem> {
    const self = this
    return Effect.gen(function*() {
      const changed = yield* self.file.refresh()
      if (Option.isNone(changed)) return self
      const { raw } = changed.value
      const lines = raw.split('\n')
      const completeLines = lines.slice(0, -1)
      const parsedEvents: Array<[number, ParsedCopilotCliEvent]> = []
      let malformed = 0
      let unknown = 0

      for (let index = 0; index < completeLines.length; index += 1) {
        const line = completeLines[index]
        if (!line?.trim()) continue
        let value: unknown
        try {
          value = JSON.parse(line) as unknown
        } catch {
          malformed += 1
          continue
        }
        const parsed = parseCopilotCliEvent(value)
        if (!parsed.success) {
          malformed += 1
          continue
        }
        if (parsed.event.kind === 'unknown') unknown += 1
        parsedEvents.push([index, parsed.event])
      }

      self.line = completeLines.length
      self.malformed = malformed
      self.unknown = unknown
      self.rebuild(parsedEvents)
      return self
    })
  }

  private rebuild(records: ReadonlyArray<readonly [number, ParsedCopilotCliEvent]>): void {
    const session = records.find(([, event]) => event.kind === 'session.start')?.[1]
    if (!session || session.kind !== 'session.start') {
      this.supported = false
      this.structuralMalformed = 1
      this.malformedParts = 0
      this.sessionId = ''
      this.derived = null
      if (reconcileTranscriptEvents(this.events, [])) this.eventRevision += 1
      return
    }

    this.supported = true
    this.structuralMalformed = 0
    if (this.sessionId && this.sessionId !== session.data.sessionId) {
      this.events.length = 0
      this.eventRevision += 1
    }
    this.sessionId = session.data.sessionId
    const workspace = session.data.context?.cwd || this.workspace
    const environment: SessionEnvironment = {
      ...EMPTY_ENVIRONMENT,
      cwd: workspace,
      gitBranch: session.data.context?.branch || '',
      version: session.data.copilotVersion || `Copilot event schema ${session.data.version}`,
      entrypoint: session.data.producer || this.application,
    }
    const nextEvents: TranscriptEvent[] = []
    const counts: Record<string, number> = {}
    const toolUses = new Map<string, ToolRecord>()
    const openTools = new Map<string, ToolRecord>()
    const commands: CommandRun[] = []
    const commandById = new Map<string, CommandRun>()
    const files = new Map<string, MutableFileChange>()
    const changes: ChangeDetail[] = []
    const incidents: DiagnosticIncident[] = []
    const activeTurns = new Map<string, { ts: Timestamp, millis: number | null }>()
    const turns: RunDiagnostics['turns'] = []
    let firstTs: Timestamp = null
    let lastTs: Timestamp = null
    let firstPrompt = ''
    let finalText = ''
    let model = ''
    let reasoningEffort = ''
    let tokensOut = 0
    let malformedParts = 0

    const startTool = (
      id: string,
      name: string,
      input: unknown,
      ts: Timestamp,
      line: number,
      intention = '',
    ): void => {
      const summary = toolSummary(name, input, intention)
      const existing = toolUses.get(id)
      if (existing) {
        openTools.set(id, existing)
        return
      }
      const tool = { name, summary, input, ts, line }
      toolUses.set(id, tool)
      openTools.set(id, tool)
      counts[name] = (counts[name] || 0) + 1
      nextEvents.push({
        role: 'assistant',
        kind: 'tool_use',
        ts,
        line,
        tool: name,
        id,
        summary,
        input: encoded(input),
        spawn: name === 'task',
        write: ['apply_patch', 'create', 'edit'].includes(name),
        model: model || undefined,
      })
      if (name === 'bash') {
        const arguments_ = parseCopilotCliArguments(input)
        const command = typeof arguments_?.command === 'string' ? compact(arguments_.command, 160) : summary
        const run: CommandRun = { cmd: command, ts, ok: null, tid: id }
        commands.push(run)
        commandById.set(id, run)
      }
      for (const path of filePaths(name, input)) {
        addFile(files, path, name, ts, workspace)
        changes.push({
          toolUseId: id,
          ts,
          tool: name,
          path: shortPath(path, workspace),
          linesAdded: 0,
          linesRemoved: 0,
          userModified: false,
          staleRecovered: false,
        })
      }
    }

    for (const [line, event] of records) {
      firstTs ||= event.timestamp
      lastTs = event.timestamp
      const ts = event.timestamp
      if (event.kind === 'unknown' || event.kind === 'session.start') continue
      if (event.kind === 'session.model_change') {
        model = event.data.newModel
        reasoningEffort = event.data.reasoningEffort || reasoningEffort
        continue
      }
      if (event.kind === 'user.message') {
        const [body, full] = clip(event.data.content)
        nextEvents.push({ role: 'user', kind: 'prompt', ts, line, body, full })
        firstPrompt ||= event.data.content
        continue
      }
      if (event.kind === 'assistant.message') {
        model = event.data.model || model
        tokensOut += event.data.outputTokens || 0
        const reasoning = event.data.reasoningText || event.data.reasoning || ''
        if (reasoning.trim()) {
          const [body, full] = clip(reasoning)
          nextEvents.push({ role: 'assistant', kind: 'thinking', ts, line, body, full, model: model || undefined })
        }
        if (event.data.content.trim()) {
          const [body, full] = clip(event.data.content)
          nextEvents.push({
            role: 'assistant', kind: 'text', ts, line, body, full, model: model || undefined,
            requestId: event.data.requestId,
          })
          finalText = event.data.content
        }
        event.data.toolRequests?.forEach((value, index) => {
          const request = parseCopilotCliToolRequest(value)
          if (!request) {
            malformedParts += 1
            return
          }
          startTool(
            request.toolCallId,
            request.name,
            request.arguments,
            ts,
            line * 1_000 + index + 1,
            request.intentionSummary,
          )
        })
        continue
      }
      if (event.kind === 'tool.execution_start') {
        startTool(event.data.toolCallId, event.data.toolName, event.data.arguments, ts, line)
        continue
      }
      if (event.kind === 'tool.execution_complete') {
        const source = toolUses.get(event.data.toolCallId)
        const failure = event.data.success === false || event.data.error !== undefined
        const outcome = failure ? false : event.data.success === true ? true : null
        const text = toolResultText(event.data.result ?? event.data.error)
        const [body, full] = clip(text)
        openTools.delete(event.data.toolCallId)
        const command = commandById.get(event.data.toolCallId)
        if (command) command.ok = outcome
        nextEvents.push({
          role: 'tool',
          kind: 'tool_result',
          ts,
          line,
          tool: source?.name || '',
          id: event.data.toolCallId,
          summary: source?.summary || '',
          body,
          full,
          error: failure || undefined,
        })
        if (failure) {
          incidents.push({
            id: `copilot-cli-tool:${event.data.toolCallId}`,
            severity: 'error',
            category: 'tool',
            title: `${source?.name || 'Tool'} failed`,
            detail: compact(text) || 'Copilot CLI reported an unsuccessful tool execution.',
            ts,
            line,
            tool: source?.name,
            toolUseId: event.data.toolCallId,
          })
        }
        continue
      }
      if (event.kind === 'session.shutdown') {
        activeTurns.clear()
        openTools.clear()
        model = event.data.currentModel || model
        continue
      }
      if (event.kind === 'abort') {
        activeTurns.clear()
        openTools.clear()
        incidents.push({
          id: `copilot-cli-abort:${line}`,
          severity: 'warning',
          category: 'interruption',
          title: 'Copilot CLI turn aborted',
          detail: event.data.reason || 'The turn ended before normal completion.',
          ts,
          line,
        })
        continue
      }
      if (event.kind === 'assistant.turn_start') {
        activeTurns.set(event.data.turnId, { ts, millis: timestampMillis(event.timestamp) })
        continue
      }
      const start = activeTurns.get(event.data.turnId)
      activeTurns.delete(event.data.turnId)
      if (start) {
        const end = timestampMillis(event.timestamp)
        turns.push({
          ts: start.ts,
          durationMs: start.millis === null || end === null ? 0 : Math.max(0, end - start.millis),
          messageCount: 2,
          pendingAgents: 0,
          pendingWorkflows: 0,
        })
      }
    }

    this.malformedParts = malformedParts
    const toolList: FileChange[] = Array.from(files, ([path, value]) => ({ path, ...value }))
      .sort((a, b) => b.ops - a.ops)
    const currentTool = Array.from(openTools.values()).at(-1)
    const current = currentTool
      ? { tool: currentTool.name, summary: currentTool.summary.slice(0, 160), ts: currentTool.ts }
      : activeTurns.size > 0 ? { tool: 'Copilot CLI', summary: 'Generating response', ts: lastTs } : null
    const title = normalizeSessionLabel(firstPrompt, this.sessionId.slice(0, 8))
    const live = activeTurns.size > 0 || openTools.size > 0
    const stats: TranscriptStats = {
      records: this.line,
      tools: Object.values(counts).reduce((total, count) => total + count, 0),
      toolCounts: counts,
      reads: Object.entries(counts)
        .filter(([name]) => READ_TOOLS.has(name))
        .reduce((total, [, count]) => total + count, 0),
      errors: incidents.filter(incident => incident.severity === 'error').length,
      tokensOut,
      firstTs,
      lastTs,
      mtime: this.file.mtime,
      ago: 0,
      live,
      size: this.file.size,
      todos: null,
      skills: [],
      milestones: [],
      current,
      files: toolList,
      commands,
      finalText,
    }
    const usage = { in: 0, out: tokensOut, cr: 0, cw: 0 }
    const sourceDetail = this.application
    if (reconcileTranscriptEvents(this.events, nextEvents)) this.eventRevision += 1
    this.derived = {
      stats,
      title,
      model,
      workingDirectory: workspace,
      sourceDetail,
      diagnostics: {
        incidents,
        turns,
        compactions: [],
        outcomes: [],
        changes,
        git: [],
        agents: [{
          key: `copilot:${this.sessionId}`,
          label: 'Main session',
          agentType: 'Copilot CLI',
          models: model ? [model] : [],
          efforts: reasoningEffort ? [reasoningEffort] : [],
          usage,
          turns: turns.length,
          turnDurationMs: turns.reduce((total, turn) => total + turn.durationMs, 0),
          compactions: 0,
          branchPoints: 0,
          sidechainRecords: 0,
        }],
        environment,
        causal: {
          records: this.line,
          recordsWithUuid: 0,
          branchPoints: 0,
          sidechainRecords: 0,
          interruptions: incidents.filter(incident => incident.category === 'interruption').length,
        },
        usage,
      },
    }
  }

  statsAt(now: number): TranscriptStats {
    if (!this.derived) return emptyTranscriptStats(this.file.mtime, this.file.size, now)
    return { ...this.derived.stats, ago: Math.max(0, now - this.derived.stats.mtime) }
  }

  get stats(): Effect.Effect<TranscriptStats, never, FileSystem.FileSystem> {
    const self = this
    return Effect.gen(function*() {
      return self.statsAt((yield* Clock.currentTimeMillis) / 1_000)
    })
  }

  get title(): string {
    return this.derived?.title || this.sessionId.slice(0, 8)
  }

  get model(): string {
    return this.derived?.model || ''
  }

  get workingDirectory(): string {
    return this.derived?.workingDirectory || this.workspace
  }

  get sourceDetail(): string {
    return this.derived?.sourceDetail || this.application
  }

  diagnostics(): RunDiagnostics {
    return this.derived?.diagnostics || emptyTranscriptDiagnostics(EMPTY_ENVIRONMENT)
  }
}
