import { Clock, DateTime, Effect, Option, Predicate } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type * as PlatformError from 'effect/PlatformError'
import {
  parseCopilotLogRecord,
  parseCopilotResponsePart,
  parseCopilotSnapshot,
  parseCopilotToolOutcome,
  type CopilotLogRecord,
  type CopilotSessionSnapshot,
  type CopilotToolPart,
} from '#shared/schemas/copilot'
import type {
  ChangeDetail,
  CommandRun,
  DiagnosticIncident,
  FileChange,
  RunDiagnostics,
  SessionEnvironment,
  Timestamp,
  Todo,
  TranscriptEvent,
  TranscriptStats,
} from '#shared/types/run'
import {
  emptyTranscriptDiagnostics,
  emptyTranscriptStats,
  reconcileTranscriptEvents,
  TranscriptFile,
} from './copilot-transcript-state'
import { clip, shortPath } from './transcript-content'

type JsonContainer = Record<PropertyKey, unknown>

const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor'])
const MAX_ARRAY_LENGTH = 0xffff_ffff

interface DerivedCopilotState {
  stats: TranscriptStats
  diagnostics: RunDiagnostics
  title: string
  model: string
  mode: string
}

const EMPTY_ENVIRONMENT: SessionEnvironment = {
  cwd: '',
  gitBranch: '',
  version: '',
  entrypoint: '',
  permissionMode: '',
}

const FAILED_STATUSES = new Set([
  'failed', 'error', 'denied', 'cancelled', 'canceled', 'timed_out', 'timeout',
])
const PASSED_STATUSES = new Set(['completed', 'success', 'succeeded', 'ok', 'passed'])

function iso(milliseconds: number | undefined): Timestamp {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return null
  return DateTime.formatIso(DateTime.makeUnsafe(milliseconds))
}

function markdownText(value: string | { readonly value: string } | undefined): string {
  return typeof value === 'string' ? value : value?.value || ''
}

function commandLineText(tool: CopilotToolPart): string {
  const commandLine = tool.toolSpecificData?.commandLine
  if (typeof commandLine === 'string') return commandLine.trim()
  return (commandLine?.toolEdited ?? commandLine?.original ?? commandLine?.forDisplay ?? '').trim()
}

function compact(value: string, limit = 240): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, limit)
}

function uriPath(uri: { readonly fsPath?: string, readonly path?: string, readonly external?: string }): string {
  return uri.fsPath || uri.path || uri.external || ''
}

function pathContainer(value: unknown): JsonContainer | null {
  return Array.isArray(value) || Predicate.isObject(value) ? value as unknown as JsonContainer : null
}

function safePath(path: ReadonlyArray<string | number>): boolean {
  return path.length > 0 && path.every(segment => typeof segment === 'number'
    ? Number.isSafeInteger(segment) && segment >= 0
    : !UNSAFE_PATH_SEGMENTS.has(segment))
}

function childContainer(parent: JsonContainer, segment: string | number): JsonContainer | null {
  if (!Object.hasOwn(parent, segment)) return null
  return pathContainer(parent[segment])
}

function setAtPath(root: unknown, path: ReadonlyArray<string | number>, value: unknown): boolean {
  if (!safePath(path)) return false
  let parent = pathContainer(root)
  for (const segment of path.slice(0, -1)) {
    if (!parent) return false
    parent = childContainer(parent, segment)
  }
  if (!parent) return false
  parent[path.at(-1)!] = value
  return true
}

function pushAtPath(
  root: unknown,
  path: ReadonlyArray<string | number>,
  values: ReadonlyArray<unknown> | undefined,
  index: number | undefined,
): boolean {
  if (!safePath(path)) return false
  let parent = pathContainer(root)
  for (const segment of path.slice(0, -1)) {
    if (!parent) return false
    parent = childContainer(parent, segment)
  }
  if (!parent) return false
  const key = path.at(-1)!
  const existing = Object.hasOwn(parent, key) ? parent[key] : undefined
  if (existing !== undefined && !Array.isArray(existing)) return false
  const current = Array.isArray(existing) ? existing as unknown[] : []
  if (index !== undefined) {
    if (!Number.isSafeInteger(index) || index < 0 || index > current.length) return false
    current.length = index
  }
  if (current.length + (values?.length || 0) > MAX_ARRAY_LENGTH) return false
  if (values?.length) {
    for (const value of values) current.push(value)
  }
  parent[key] = current
  return true
}

function deleteAtPath(root: unknown, path: ReadonlyArray<string | number>): boolean {
  if (!safePath(path)) return false
  let parent = pathContainer(root)
  for (const segment of path.slice(0, -1)) {
    if (!parent) return false
    parent = childContainer(parent, segment)
  }
  if (!parent) return false
  delete parent[path.at(-1)!]
  return true
}

function applyLogRecord(root: unknown, record: CopilotLogRecord): { state: unknown, applied: boolean } {
  if (record.kind === 0) return { state: record.v, applied: true }
  const applied = record.kind === 1
    ? setAtPath(root, record.k, record.v)
    : record.kind === 2
      ? pushAtPath(root, record.k, record.v, record.i)
      : deleteAtPath(root, record.k)
  return { state: root, applied }
}

export function isCopilotSnapshot(snapshot: CopilotSessionSnapshot): boolean {
  if (snapshot.responderUsername?.trim().toLowerCase() === 'github copilot') return true
  return snapshot.requests.some((request) => {
    const agent = request.agent
    if (agent?.id?.startsWith('github.copilot.')) return true
    return agent?.extensionPublisherId?.toLowerCase() === 'github'
      && Boolean(agent.extensionDisplayName?.toLowerCase().includes('copilot'))
  })
}

function explicitOutcome(tool: CopilotToolPart): boolean | null {
  const state = tool.toolSpecificData?.terminalCommandState
  if (state?.exitCode !== undefined) return state.exitCode === 0
  const outcome = parseCopilotToolOutcome(tool.resultDetails)
  if (!outcome) return null
  if (outcome.isError === true || outcome.error === true) return false
  if (outcome.exitCode !== undefined) return outcome.exitCode === 0
  if (outcome.exit_code !== undefined) return outcome.exit_code === 0
  if (outcome.success !== undefined) return outcome.success
  const status = outcome.status?.trim().toLowerCase()
  if (status && FAILED_STATUSES.has(status)) return false
  if (status && PASSED_STATUSES.has(status)) return true
  if (outcome.isError === false || outcome.error === false) return true
  return null
}

function modeOf(snapshot: CopilotSessionSnapshot): string {
  const request = snapshot.requests.at(-1)
  const mode = request?.modeInfo?.kind || request?.modeInfo?.modeName || request?.modeInfo?.modeId
  if (mode) return mode
  const agent = request?.agent?.id || ''
  if (agent.includes('editingSession')) return 'edit'
  if (agent.includes('editsAgent')) return 'agent'
  return 'chat'
}

function latestTimestamp(snapshot: CopilotSessionSnapshot, mtime: number): Timestamp {
  const values = [snapshot.creationDate, mtime * 1_000]
  for (const request of snapshot.requests) {
    values.push(request.timestamp)
    if (request.modelState?.completedAt !== undefined) values.push(request.modelState.completedAt)
  }
  return iso(Math.max(...values.filter(Number.isFinite)))
}

function activeRequest(snapshot: CopilotSessionSnapshot): boolean {
  if ((snapshot.pendingRequests?.length || 0) > 0) return true
  return snapshot.requests.some(request => request.modelState?.value === 0)
}

function diagnosticBase(
  snapshot: CopilotSessionSnapshot,
  environment: SessionEnvironment,
): Pick<RunDiagnostics, 'compactions' | 'outcomes' | 'git' | 'environment' | 'causal' | 'usage'> {
  return {
    compactions: [],
    outcomes: [],
    git: [],
    environment,
    causal: {
      records: snapshot.requests.length,
      recordsWithUuid: 0,
      branchPoints: 0,
      sidechainRecords: 0,
      interruptions: 0,
    },
    usage: { in: 0, out: 0, cr: 0, cw: 0 },
  }
}

export class CopilotTranscriptScan {
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
  private state: unknown
  private snapshot: CopilotSessionSnapshot | null = null
  private readonly file: TranscriptFile
  private derived: DerivedCopilotState | null = null
  private unknownLogRecords = 0

  constructor(path: string, application: string, workspace: string) {
    this.path = path
    this.application = application
    this.workspace = workspace
    this.file = new TranscriptFile(this.path)
  }

  get refresh(): Effect.Effect<this, PlatformError.PlatformError, FileSystem.FileSystem> {
    const self = this
    return Effect.gen(function*() {
      const changed = yield* self.file.refresh()
      if (Option.isNone(changed)) return self
      const { raw, rewritten } = changed.value
      const completeLines = raw.endsWith('\n') ? raw.split('\n').slice(0, -1) : raw.split('\n').slice(0, -1)
      if (rewritten || completeLines.length < self.line) {
        self.line = 0
        self.state = undefined
        self.malformed = 0
        self.unknown = 0
        self.unknownLogRecords = 0
      }
      for (let index = self.line; index < completeLines.length; index += 1) {
        const line = completeLines[index]
        if (!line?.trim()) continue
        let value: unknown
        try {
          value = JSON.parse(line) as unknown
        } catch {
          self.malformed += 1
          continue
        }
        const parsed = parseCopilotLogRecord(value)
        if (!parsed.success) {
          self.malformed += 1
          continue
        }
        if (parsed.record.kind === 'unknown') {
          self.unknownLogRecords += 1
          continue
        }
        const applied = applyLogRecord(self.state, parsed.record)
        if (!applied.applied) {
          self.malformed += 1
          continue
        }
        self.state = applied.state
      }
      self.line = completeLines.length
      const snapshot = parseCopilotSnapshot(self.state)
      if (!snapshot) {
        self.snapshot = null
        self.supported = false
        self.structuralMalformed = 1
        self.derived = null
        if (reconcileTranscriptEvents(self.events, [])) self.eventRevision += 1
        return self
      }
      self.structuralMalformed = 0
      if (self.sessionId && self.sessionId !== snapshot.sessionId) {
        self.events.length = 0
        self.eventRevision += 1
      }
      self.snapshot = snapshot
      self.sessionId = snapshot.sessionId
      self.supported = isCopilotSnapshot(snapshot)
      if (!self.supported) {
        self.derived = null
        if (reconcileTranscriptEvents(self.events, [])) self.eventRevision += 1
        return self
      }
      self.rebuild()
      return self
    })
  }

  private rebuild(): void {
    const snapshot = this.snapshot
    if (!snapshot || !this.supported) return
    const counts: Record<string, number> = {}
    const commands: CommandRun[] = []
    const files = new Map<string, FileChange>()
    const incidents: DiagnosticIncident[] = []
    const changes: ChangeDetail[] = []
    const turns: RunDiagnostics['turns'] = []
    let tools = 0
    let reads = 0
    let errors = 0
    let tokensOut = 0
    let finalText = ''
    let current: TranscriptStats['current'] = null
    let todos: Todo[] | null = null
    let model = ''
    let permissionMode = ''
    let malformedParts = 0
    let unknownParts = 0
    const nextEvents: TranscriptEvent[] = []
    const workspace = snapshot.workingDirectory || this.workspace

    snapshot.requests.forEach((request, requestIndex) => {
      const ts = iso(request.timestamp)
      const prompt = request.message.text
      const [promptBody, promptFull] = clip(prompt)
      nextEvents.push({
        role: 'user', kind: 'prompt', ts, line: requestIndex, body: promptBody, full: promptFull,
        requestId: request.requestId,
      })
      model = request.result?.metadata?.resolvedModel || request.modelId || model
      permissionMode = request.modeInfo?.permissionLevel || permissionMode
      tokensOut += request.result?.metadata?.outputTokens || 0
      if (request.elapsedMs !== undefined) {
        turns.push({
          ts,
          durationMs: request.elapsedMs,
          messageCount: 2,
          pendingAgents: 0,
          pendingWorkflows: 0,
        })
      }
      if (request.result?.errorDetails) {
        errors += 1
        const error = request.result.errorDetails
        incidents.push({
          id: `copilot-request:${request.requestId}`,
          severity: 'error',
          category: 'api',
          title: 'Copilot request failed',
          detail: error.message || request.result.details || error.code || 'The provider recorded an error.',
          code: error.code,
          ts,
          line: requestIndex,
        })
      }

      request.response.forEach((rawPart, partIndex) => {
        const part = parseCopilotResponsePart(rawPart)
        const line = requestIndex * 10_000 + partIndex + 1
        if (part.kind === 'malformed') {
          malformedParts += 1
          return
        }
        if (part.kind === 'unknown') {
          unknownParts += 1
          return
        }
        if (part.kind === 'markdown') {
          if (!part.data.value.trim()) return
          const [body, full] = clip(part.data.value)
          nextEvents.push({
            role: 'assistant', kind: 'text', ts, line, body, full, model: model || undefined,
            requestId: request.requestId,
          })
          finalText = part.data.value
          return
        }
        if (part.kind === 'thinking') {
          const text = typeof part.data.value === 'string' ? part.data.value : ''
          if (!text.trim()) return
          const [body, full] = clip(text)
          nextEvents.push({
            role: 'assistant', kind: 'thinking', ts, line, body, full, model: model || undefined,
          })
          return
        }
        if (part.kind === 'tool') {
          const tool = part.data
          const name = tool.toolId
          const commandLine = commandLineText(tool)
          const summary = compact(
            commandLine
            || markdownText(tool.invocationMessage)
            || markdownText(tool.pastTenseMessage)
            || name,
          )
          const outcome = explicitOutcome(tool)
          tools += 1
          counts[name] = (counts[name] || 0) + 1
          if (/read|find|search|list/i.test(name)) reads += 1
          nextEvents.push({
            role: 'assistant', kind: 'tool_use', ts, line, tool: name, id: tool.toolCallId,
            summary, model: model || undefined,
          })
          if (!tool.isComplete) current = { tool: name, summary, ts }
          if (tool.isComplete) {
            const resultText = markdownText(tool.pastTenseMessage) || summary
            const [body, full] = clip(resultText)
            nextEvents.push({
              role: 'tool', kind: 'tool_result', ts, line, tool: name, id: tool.toolCallId,
              summary: resultText,
              body,
              full,
              error: outcome === null ? undefined : outcome === false,
            })
          }
          if (outcome === false) {
            errors += 1
            incidents.push({
              id: `copilot-tool:${tool.toolCallId}`,
              severity: 'error',
              category: 'tool',
              title: `${name} failed`,
              detail: markdownText(tool.pastTenseMessage) || summary,
              ts,
              line,
              tool: name,
              toolUseId: tool.toolCallId,
            })
          }
          if (name === 'run_in_terminal' && commandLine) {
            commands.push({
              cmd: compact(commandLine, 160),
              ts,
              ok: outcome,
              tid: tool.toolCallId,
            })
          }
          if (tool.toolSpecificData?.kind === 'todoList' && tool.toolSpecificData.todoList) {
            todos = tool.toolSpecificData.todoList.map(item => ({
              content: item.title || item.description,
              status: item.status || 'pending',
            }))
          }
          return
        }
        const path = uriPath(part.data.uri)
        if (!path) return
        const edits = part.data.edits.flat()
        if (!edits.length) return
        const existing = files.get(path) || { path, ops: 0, tools: [], lastTs: ts }
        existing.ops += edits.length
        existing.lastTs = ts
        if (!existing.tools.includes('textEditGroup')) existing.tools.push('textEditGroup')
        files.set(path, existing)
        let linesAdded = 0
        let linesRemoved = 0
        for (const edit of edits) {
          if (edit.text) {
            const lines = edit.text.split('\n')
            linesAdded += lines.length - (lines.at(-1) === '' ? 1 : 0)
          }
          const start = edit.range.startLineNumber || 0
          const end = edit.range.endLineNumber || start
          linesRemoved += Math.max(0, end - start)
        }
        changes.push({
          toolUseId: `copilot-edit:${request.requestId}:${partIndex}`,
          ts,
          tool: 'textEditGroup',
          path: shortPath(path, workspace),
          linesAdded,
          linesRemoved,
          userModified: false,
          staleRecovered: false,
        })
      })
    })

    this.malformedParts = malformedParts
    this.unknown = this.unknownLogRecords + unknownParts
    const live = activeRequest(snapshot)
    if (live && !current) current = {
      tool: 'Copilot',
      summary: 'Generating response',
      ts: iso(snapshot.requests.at(-1)?.timestamp || snapshot.creationDate),
    }
    const firstTs = iso(snapshot.creationDate)
    const lastTs = latestTimestamp(snapshot, this.file.mtime)
    const environment: SessionEnvironment = {
      ...EMPTY_ENVIRONMENT,
      cwd: workspace,
      version: `VS Code chat schema ${snapshot.version}`,
      entrypoint: this.application,
      permissionMode,
    }
    const mode = modeOf(snapshot)
    const sourceDetail = `${this.application} · ${mode}`
    const title = snapshot.customTitle
      || compact(snapshot.requests[0]?.message.text || snapshot.sessionId.slice(0, 8), 100)
    const fileList = [...files.values()].map(file => ({ ...file, path: shortPath(file.path, workspace) }))
    const stats: TranscriptStats = {
      records: snapshot.requests.length + snapshot.requests.reduce((total, request) => total + request.response.length, 0),
      tools,
      toolCounts: counts,
      reads,
      errors,
      tokensOut,
      firstTs,
      lastTs,
      mtime: this.file.mtime,
      ago: 0,
      live,
      size: this.file.size,
      todos,
      skills: [],
      milestones: [],
      current,
      files: fileList,
      commands,
      finalText,
    }
    const base = diagnosticBase(snapshot, environment)
    if (reconcileTranscriptEvents(this.events, nextEvents)) this.eventRevision += 1
    this.derived = {
      stats,
      title,
      model,
      mode: sourceDetail,
      diagnostics: {
        ...base,
        incidents,
        turns,
        changes,
        agents: [{
          key: `copilot:${snapshot.sessionId}`,
          label: 'Main session',
          agentType: `Copilot ${mode}`,
          models: model ? [model] : [],
          efforts: [],
          usage: { in: 0, out: tokensOut, cr: 0, cw: 0 },
          turns: turns.length,
          turnDurationMs: turns.reduce((total, turn) => total + turn.durationMs, 0),
          compactions: 0,
          branchPoints: 0,
          sidechainRecords: 0,
        }],
        usage: { in: 0, out: tokensOut, cr: 0, cw: 0 },
      },
    }
  }

  statsAt(now: number): TranscriptStats {
    const stats = this.derived?.stats
    if (!stats) {
      return emptyTranscriptStats(this.file.mtime, this.file.size, now)
    }
    return { ...stats, ago: Math.max(0, now - stats.mtime) }
  }

  get title(): string {
    return this.derived?.title || this.sessionId.slice(0, 8)
  }

  get model(): string {
    return this.derived?.model || ''
  }

  get workingDirectory(): string {
    return this.snapshot?.workingDirectory || this.workspace
  }

  get sourceDetail(): string {
    return this.derived?.mode || this.application
  }

  diagnostics(): RunDiagnostics {
    return this.derived?.diagnostics || emptyTranscriptDiagnostics(EMPTY_ENVIRONMENT)
  }

  get stats(): Effect.Effect<TranscriptStats, never, FileSystem.FileSystem> {
    const self = this
    return Effect.gen(function*() {
      return self.statsAt((yield* Clock.currentTimeMillis) / 1_000)
    })
  }
}
