import { Effect, Option, Order } from 'effect'
import type * as FileSystem from 'effect/FileSystem'
import type {
  AgentDiagnosticSummary,
  CausalSummary,
  RunDiagnostics,
  RunNode,
  ScanDiagnostics,
  SessionEnvironment,
  Usage,
} from '#shared/types/run'

/**
 * Helpers shared by the Claude, Codex, and Copilot run builders and the
 * unified session catalog. These operate on the assembled `RunNode` tree and
 * discovery bookkeeping; `transcript-scan-core.ts` covers the lower-level
 * raw-record helpers instead. Everything here is plain except
 * `countUnreadable`, which logs through the Effect logger.
 */

/** Preorder traversal of a run tree, visiting every node with its depth. */
export function visitNodes(
  root: RunNode,
  use: (node: RunNode, depth: number) => void,
  depth = 0,
): void {
  use(root, depth)
  for (const child of root.children) visitNodes(child, use, depth + 1)
}

/** Orders items ascending by an optional ISO timestamp; a missing timestamp sorts first. */
export const byTimestamp: Order.Order<{ ts: string | null }> = Order.mapInput(
  Order.String,
  item => item.ts ?? '',
)

/** Orders run roots descending by `subLast`; a missing timestamp sorts last. */
export const bySubLastDesc: Order.Order<{ subLast: string | null }> = Order.flip(
  Order.mapInput(Order.String, item => item.subLast ?? ''),
)

/** The oldest mtime, in epoch milliseconds, still considered "fresh" as of `now`. */
export function freshnessCutoff(maxAgeHours: number, now: number): number {
  return maxAgeHours <= 0 ? Number.NEGATIVE_INFINITY : now - maxAgeHours * 3_600_000
}

/** A file with no mtime is treated as fresh; otherwise it must be at or after `cutoff`. */
export function isFreshMtime(mtime: Option.Option<Date>, cutoff: number): boolean {
  return Option.match(mtime, {
    onNone: () => true,
    onSome: value => value.getTime() >= cutoff,
  })
}

/** A stat result counts as a fresh transcript file only when it is a regular file within the window. */
export function isFreshFileInfo(info: FileSystem.File.Info, cutoff: number): boolean {
  return info.type === 'File' && isFreshMtime(info.mtime, cutoff)
}

/**
 * Count discovery/scan failures without discarding them. Every partitioned
 * failure used to collapse into a bare `failures.length`; this logs each one
 * at debug level (with the discovery context) before returning the count the
 * status line reports.
 */
export const countUnreadable = Effect.fn('countUnreadable')(function*(
  context: string,
  failures: ReadonlyArray<unknown>,
) {
  for (const failure of failures) {
    yield* Effect.logDebug(`${context}: skipped unreadable entry`, { error: failure })
  }
  return failures.length
})

/**
 * Keep the newest item per id, counting every later duplicate. Items whose id
 * is empty are skipped entirely (they never entered `selected` in the
 * original per-builder loops either).
 */
export function selectLatestById<T>(
  items: Iterable<T>,
  idOf: (item: T) => string,
  mtimeOf: (item: T) => number,
): { selected: Map<string, T>, duplicates: number } {
  const selected = new Map<string, T>()
  let duplicates = 0
  for (const item of items) {
    const id = idOf(item)
    if (!id) continue
    const existing = selected.get(id)
    if (existing) {
      duplicates += 1
      if (mtimeOf(item) > mtimeOf(existing)) selected.set(id, item)
    } else {
      selected.set(id, item)
    }
  }
  return { selected, duplicates }
}

/** A zeroed token-usage record, one instance per call so callers may mutate it. */
export function emptyUsage(): Usage {
  return { in: 0, out: 0, cr: 0, cw: 0 }
}

/** A zeroed causal summary, one instance per call so callers may mutate it. */
export function emptyCausal(): CausalSummary {
  return { records: 0, recordsWithUuid: 0, branchPoints: 0, sidechainRecords: 0, interruptions: 0 }
}

/** An all-blank session environment, one instance per call so callers may mutate it. */
export function emptyEnvironment(): SessionEnvironment {
  return { cwd: '', gitBranch: '', version: '', entrypoint: '', permissionMode: '' }
}

/** Add `source`'s token counts into `target`, in place. */
export function addUsage(target: Usage, source: Usage): void {
  target.in += source.in
  target.out += source.out
  target.cr += source.cr
  target.cw += source.cw
}

/** Add `source`'s causal counters into `target`, in place. */
export function addCausal(target: CausalSummary, source: CausalSummary): void {
  target.records += source.records
  target.recordsWithUuid += source.recordsWithUuid
  target.branchPoints += source.branchPoints
  target.sidechainRecords += source.sidechainRecords
  target.interruptions += source.interruptions
}

/** The mutable aggregate a run-diagnostics build accumulates scan results into. */
export interface RunDiagnosticsAccumulator {
  incidents: RunDiagnostics['incidents']
  turns: RunDiagnostics['turns']
  compactions: RunDiagnostics['compactions']
  outcomes: RunDiagnostics['outcomes']
  changes: RunDiagnostics['changes']
  git: RunDiagnostics['git']
  agents: AgentDiagnosticSummary[]
  usage: Usage
  causal: CausalSummary
  environment: SessionEnvironment
}

export function emptyRunDiagnostics(): RunDiagnosticsAccumulator {
  return {
    incidents: [],
    turns: [],
    compactions: [],
    outcomes: [],
    changes: [],
    git: [],
    agents: [],
    usage: emptyUsage(),
    causal: emptyCausal(),
    environment: emptyEnvironment(),
  }
}

/**
 * Merge one scan's diagnostics into the aggregate, attributing every entry to
 * the node (`who`/`key`) it came from. Outcomes and per-agent summaries need
 * caller-specific decoration, so those stay at the call sites.
 */
export function mergeScanDiagnostics(
  target: RunDiagnosticsAccumulator,
  diagnostic: ScanDiagnostics,
  who: string,
  key: string,
): void {
  for (const sample of diagnostic.context) addUsage(target.usage, sample.usage)
  addCausal(target.causal, diagnostic.causal)
  target.incidents.push(...diagnostic.incidents.map(incident => ({ ...incident, who, key })))
  target.turns.push(...diagnostic.turns.map(turn => ({ ...turn, who, key })))
  target.compactions.push(...diagnostic.compactions.map(compaction => ({ ...compaction, who, key })))
  target.changes.push(...diagnostic.changes.map(change => ({ ...change, who, key })))
  target.git.push(...diagnostic.git.map(event => ({ ...event, who, key })))
}

/**
 * Sort every aggregate by timestamp and keep the bounded tail the UI shows.
 * The tail limits (200/200/100/100/300/100) are centralized here so the
 * Claude and Codex builders cannot drift apart.
 */
export function finishRunDiagnostics(target: RunDiagnosticsAccumulator): RunDiagnostics {
  return {
    incidents: target.incidents.sort(byTimestamp).slice(-200),
    turns: target.turns.sort(byTimestamp).slice(-200),
    compactions: target.compactions.sort(byTimestamp).slice(-100),
    outcomes: target.outcomes.sort(byTimestamp).slice(-100),
    changes: target.changes.sort(byTimestamp).slice(-300),
    git: target.git.sort(byTimestamp).slice(-100),
    agents: target.agents,
    environment: target.environment,
    causal: target.causal,
    usage: target.usage,
  }
}
