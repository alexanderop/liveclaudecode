import { basename, join } from 'node:path'
import { Clock, Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type { CodexTranscriptScan } from './codex-transcript'
import { CodexScanCache, CodexSessionsDirectory } from './services'
import { rollup } from './runs'
import { FILE_CONCURRENCY, FileDiscoveryLimiter, freshFilesIn } from './filesystem-concurrency'
import type {
  RunDiagnostics,
  RunNode,
} from '#shared/types/run'
import { normalizeSessionLabel } from '#shared/utils/session-label'
import {
  bySubLastDesc,
  countUnreadable,
  emptyRunDiagnostics,
  finishRunDiagnostics,
  freshnessCutoff,
  mergeScanDiagnostics,
  selectLatestById,
  visitNodes,
} from './run-shared'

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
  const limiter = yield* FileDiscoveryLimiter
  const names = yield* limiter.withPermit(fs.readDirectory(directory))
  const entries = yield* Effect.forEach(names, name => Effect.gen(function*() {
    const path = join(directory, name)
    const info = yield* limiter.withPermit(fs.stat(path))
    return info.type === 'Directory' ? [path] : []
  }), { concurrency: FILE_CONCURRENCY })
  return entries.flat()
})

export const collectCodexRollouts = Effect.fn('collectCodexRollouts')(function*(maxAgeHours: number) {
  const root = yield* CodexSessionsDirectory
  const now = yield* Clock.currentTimeMillis
  const cutoff = freshnessCutoff(maxAgeHours, now)

  const years = yield* childDirectories(root)
  const months = (yield* Effect.forEach(
    years,
    directory => childDirectories(directory),
    { concurrency: FILE_CONCURRENCY },
  )).flat()
  const days = (yield* Effect.forEach(
    months,
    directory => childDirectories(directory),
    { concurrency: FILE_CONCURRENCY },
  )).flat()
  const discovered = yield* Effect.forEach(
    days,
    day => freshFilesIn(day, name => name.endsWith('.jsonl'), cutoff),
    { concurrency: FILE_CONCURRENCY },
  )

  return {
    paths: discovered.flatMap(result => result.paths).sort((a, b) => a.localeCompare(b)),
    unreadable: discovered.reduce((total, result) => total + result.unreadable, 0),
  } satisfies CodexRolloutDiscovery
})

export const buildCodexTree = Effect.fn('buildCodexTree')(function*(hours: number) {
  const cache = yield* CodexScanCache
  const discovery = yield* collectCodexRollouts(hours)
  const [unreadableScans, readable] = yield* Effect.partition(
    discovery.paths,
    path => Effect.map(cache.get(path), scan => ({ path, scan })),
    { concurrency: FILE_CONCURRENCY },
  )
  const paths = readable.map(item => item.path)
  const scans = readable.map(item => item.scan)
  const stats = yield* Effect.forEach(scans, scan => scan.stats, { concurrency: 'unbounded' })
  const candidates = paths.map((path, index) => {
    const scan = scans[index]!
    return { id: scan.metadata.id || idFromFilename(path), path, scan, stats: stats[index]! }
  })
  const { selected, duplicates } = selectLatestById(candidates, item => item.id, item => item.stats.mtime)

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
  roots.sort(bySubLastDesc)

  return {
    roots,
    byKey,
    pathByKey,
    scanByKey,
    cwdByKey,
    malformed: scans.reduce((total, scan) => total + scan.malformed, 0),
    unreadable: discovery.unreadable
      + (yield* countUnreadable('buildCodexTree scans', unreadableScans)),
    duplicates,
  }
})

export function codexRunDiagnostics(root: RunNode, scanByKey: Map<string, CodexTranscriptScan>): RunDiagnostics {
  const nodes: RunNode[] = []
  visitNodes(root, node => nodes.push(node))

  const aggregate = emptyRunDiagnostics()
  for (const node of nodes) {
    const scan = scanByKey.get(node.key)
    if (!scan) continue
    const diagnostic = scan.diagnostics()
    const who = node.kind === 'session' ? 'Main session' : node.label
    if (node === root) aggregate.environment = diagnostic.environment
    mergeScanDiagnostics(aggregate, diagnostic, who, node.key)
    aggregate.agents.push({
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

  return finishRunDiagnostics(aggregate)
}
