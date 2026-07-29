import { basename, join } from 'node:path'
import { Clock, Effect, Result } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type { CodexTranscriptScan } from './codex-transcript'
import { CodexScanCache, CodexSessionsDirectory } from './services'
import { FILE_CONCURRENCY, rollup } from './runs'
import type {
  AgentDiagnosticSummary,
  DiagnosticIncident,
  RunDiagnostics,
  RunNode,
  SessionEnvironment,
  TranscriptStats,
  Usage,
} from '#shared/types/run'
import { normalizeSessionLabel } from '#shared/utils/session-label'

interface CodexCollectedItem {
  id: string
  path: string
  scan: CodexTranscriptScan
  stats: TranscriptStats
}

export interface CodexTree {
  roots: RunNode[]
  byKey: Map<string, RunNode>
  pathByKey: Map<string, string>
  scanByKey: Map<string, CodexTranscriptScan>
  cwdByKey: Map<string, string>
  malformed: number
  unreadable: number
  duplicates: number
}

export interface CodexRolloutDiscovery {
  paths: string[]
  unreadable: number
}

function idFromFilename(path: string): string {
  const name = basename(path)
  const match = name.match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i)
  return match?.[1] || ''
}

const childDirectories = Effect.fn('childDirectories')(function*(directory: string) {
  const fs = yield* FileSystem.FileSystem
  const names = yield* fs.readDirectory(directory)
  const entries = yield* Effect.forEach(names, name => Effect.gen(function*() {
    const path = join(directory, name)
    const info = yield* fs.stat(path)
    return info.type === 'Directory' ? [path] : []
  }), { concurrency: 'unbounded' })
  return entries.flat()
})

export const collectCodexRollouts = Effect.fn('collectCodexRollouts')(function*(maxAgeHours: number) {
  if (maxAgeHours <= 0) return { paths: [], unreadable: 0 } satisfies CodexRolloutDiscovery
  const fs = yield* FileSystem.FileSystem
  const root = yield* CodexSessionsDirectory
  const now = yield* Clock.currentTimeMillis
  const cutoff = now - maxAgeHours * 3_600_000

  const years = yield* childDirectories(root)
  const months = (yield* Effect.forEach(years, childDirectories, { concurrency: 'unbounded' })).flat()
  const days = (yield* Effect.forEach(months, childDirectories, { concurrency: 'unbounded' })).flat()
  const discovered = yield* Effect.forEach(days, day => Effect.gen(function*() {
    const names = yield* fs.readDirectory(day)
    const candidates = names.filter(name => name.endsWith('.jsonl'))
    const results = yield* Effect.forEach(candidates, name => Effect.result(Effect.gen(function*() {
      const path = join(day, name)
      const info = yield* fs.stat(path)
      if (info.type !== 'File') return []
      const fresh = info.mtime._tag === 'Some' ? info.mtime.value.getTime() >= cutoff : true
      return fresh ? [path] : []
    })), { concurrency: 'unbounded' })
    return {
      paths: results.flatMap(result => Result.isSuccess(result) ? result.success : []),
      unreadable: results.filter(Result.isFailure).length,
    }
  }), { concurrency: 'unbounded' })

  return {
    paths: discovered.flatMap(result => result.paths).sort((a, b) => a.localeCompare(b)),
    unreadable: discovered.reduce((total, result) => total + result.unreadable, 0),
  } satisfies CodexRolloutDiscovery
})

export const buildCodexTree = Effect.fn('buildCodexTree')(function*(hours: number) {
  const cache = yield* CodexScanCache
  const discovery = yield* collectCodexRollouts(hours)
  const results = yield* Effect.forEach(
    discovery.paths,
    path => Effect.result(cache.get(path)),
    { concurrency: FILE_CONCURRENCY },
  )
  const readable = results.flatMap((result, index) =>
    Result.isSuccess(result) ? [{ path: discovery.paths[index]!, scan: result.success }] : [])
  const paths = readable.map(item => item.path)
  const scans = readable.map(item => item.scan)
  const stats = yield* Effect.forEach(scans, scan => scan.stats)
  const selected = new Map<string, CodexCollectedItem>()
  let duplicates = 0

  for (const [index, path] of paths.entries()) {
    const scan = scans[index]!
    const id = scan.metadata.id || idFromFilename(path)
    if (!id) continue
    const candidate = { id, path, scan, stats: stats[index]! }
    const existing = selected.get(id)
    if (existing) {
      duplicates += 1
      if (candidate.stats.mtime > existing.stats.mtime) selected.set(id, candidate)
    } else {
      selected.set(id, candidate)
    }
  }

  const byKey = new Map<string, RunNode>()
  const pathByKey = new Map<string, string>()
  const scanByKey = new Map<string, CodexTranscriptScan>()
  const cwdByKey = new Map<string, string>()

  for (const item of selected.values()) {
    const meta = item.scan.metadata
    const key = `codex:${item.id}`
    const isSubagent = Boolean(meta.parentThreadId)
    const rawLabel = isSubagent
      ? meta.agentNickname || meta.agentPath.split('/').filter(Boolean).at(-1) || meta.agentRole || item.id.slice(0, 8)
      : item.scan.firstPrompt || item.id.slice(0, 8)
    const label = normalizeSessionLabel(rawLabel, item.id.slice(0, 8))
    const node: RunNode = {
      ...item.stats,
      source: 'codex',
      sourceDetail: meta.originator || meta.producerSource || 'Codex',
      key,
      kind: isSubagent ? 'subagent' : 'session',
      sid: item.id,
      label,
      agentType: isSubagent ? meta.agentRole || 'Codex agent' : '',
      toolUseId: null,
      model: item.scan.model,
      spawnDepth: meta.spawnDepth,
      parentAgentId: meta.parentThreadId,
      stoppedByUser: false,
      spawnState: isSubagent ? (item.stats.live ? 'running' : 'returned') : '',
      children: [],
      subAgents: 0,
      subRunning: 0,
      subErrors: 0,
      subTools: 0,
      subFiles: {},
      subLast: null,
      subLive: false,
    }
    byKey.set(key, node)
    pathByKey.set(key, item.path)
    scanByKey.set(key, item.scan)
    cwdByKey.set(key, meta.cwd || item.scan.environment.cwd)
  }

  const roots: RunNode[] = []
  for (const node of byKey.values()) {
    const parent = node.parentAgentId ? byKey.get(`codex:${node.parentAgentId}`) : undefined
    if (parent && parent.key !== node.key) parent.children.push(node)
    else roots.push(node)
  }
  for (const root of roots) rollup(root)
  roots.sort((a, b) => (b.subLast || '').localeCompare(a.subLast || ''))

  return {
    roots,
    byKey,
    pathByKey,
    scanByKey,
    cwdByKey,
    malformed: scans.reduce((total, scan) => total + scan.malformed, 0),
    unreadable: discovery.unreadable + results.filter(Result.isFailure).length,
    duplicates,
  }
})

export function codexRunDiagnostics(root: RunNode, scanByKey: Map<string, CodexTranscriptScan>): RunDiagnostics {
  const nodes: RunNode[] = []
  const gather = (node: RunNode): void => {
    nodes.push(node)
    node.children.forEach(gather)
  }
  gather(root)

  const incidents: DiagnosticIncident[] = []
  const compactions: RunDiagnostics['compactions'] = []
  const changes: RunDiagnostics['changes'] = []
  const agents: AgentDiagnosticSummary[] = []
  const usage: Usage = { in: 0, out: 0, cr: 0, cw: 0 }
  const causal = { records: 0, recordsWithUuid: 0, branchPoints: 0, sidechainRecords: 0, interruptions: 0 }
  let environment: SessionEnvironment = { cwd: '', gitBranch: '', version: '', entrypoint: '', permissionMode: '' }

  for (const node of nodes) {
    const scan = scanByKey.get(node.key)
    if (!scan) continue
    const diagnostic = scan.diagnostics()
    const who = node.kind === 'session' ? 'Main session' : node.label
    if (node === root) environment = diagnostic.environment
    for (const sample of diagnostic.context) {
      usage.in += sample.usage.in
      usage.out += sample.usage.out
      usage.cr += sample.usage.cr
      usage.cw += sample.usage.cw
    }
    for (const key of Object.keys(causal) as Array<keyof typeof causal>) causal[key] += diagnostic.causal[key]
    incidents.push(...diagnostic.incidents.map(incident => ({ ...incident, who, key: node.key })))
    compactions.push(...diagnostic.compactions.map(compaction => ({ ...compaction, who, key: node.key })))
    changes.push(...diagnostic.changes.map(change => ({ ...change, who, key: node.key })))
    agents.push({
      key: node.key,
      label: who,
      agentType: node.agentType || 'Main session',
      models: scan.model ? [scan.model] : [],
      efforts: scan.effort ? [scan.effort] : [],
      usage: { ...scan.usage },
      turns: 0,
      turnDurationMs: 0,
      compactions: diagnostic.compactions.length,
      branchPoints: 0,
      sidechainRecords: 0,
    })
  }

  const byTimestamp = <T extends { ts: string | null }>(a: T, b: T): number =>
    (a.ts || '').localeCompare(b.ts || '')

  return {
    incidents: incidents.sort(byTimestamp).slice(-200),
    turns: [],
    compactions: compactions.sort(byTimestamp).slice(-100),
    outcomes: [],
    changes: changes.sort(byTimestamp).slice(-300),
    git: [],
    agents,
    environment,
    causal,
    usage,
  }
}
