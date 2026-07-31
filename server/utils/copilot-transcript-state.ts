import { Effect, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type {
  RunDiagnostics,
  SessionEnvironment,
  TranscriptEvent,
  TranscriptStats,
} from '#shared/types/run'
import { statIfExists } from './filesystem-concurrency'

export interface ChangedTranscriptFile {
  raw: string
  rewritten: boolean
}

/** Stateful file-change detection shared by the two replay-based Copilot scanners. */
export class TranscriptFile {
  readonly path: string
  mtime = 0
  size = 0
  private lastLoadedMtime = 0
  private lastLoadedSize = -1

  constructor(path: string) {
    this.path = path
  }

  readonly refresh = Effect.fn('TranscriptFile.refresh')(function*(this: TranscriptFile) {
    const fs = yield* FileSystem.FileSystem
    const infoOption = yield* statIfExists(this.path)
    if (Option.isNone(infoOption) || infoOption.value.type !== 'File') {
      return Option.none<ChangedTranscriptFile>()
    }

    const info = infoOption.value
    const mtime = Option.match(info.mtime, {
      onNone: () => this.mtime,
      onSome: value => value.getTime() / 1_000,
    })
    const size = Number(info.size)
    this.mtime = mtime
    this.size = size
    if (size === this.lastLoadedSize && mtime === this.lastLoadedMtime) {
      return Option.none<ChangedTranscriptFile>()
    }

    const raw = yield* fs.readFileString(this.path)
    const rewritten = size < this.lastLoadedSize
    this.lastLoadedMtime = mtime
    this.lastLoadedSize = size
    return Option.some({ raw, rewritten } satisfies ChangedTranscriptFile)
  })
}

/**
 * A cheap key that identifies "the same event slot" across two rebuilds of
 * the same replay. `line` is a deterministic position derived from
 * request/part index, so it (with `kind` and `id`) is stable for any event
 * that isn't still the very last one produced by the previous rebuild.
 */
function eventIdentity(event: TranscriptEvent): string {
  return `${event.line}:${event.kind}:${event.id ?? ''}`
}

/**
 * Mutate the stable public array and report whether clients need a cursor
 * reset.
 *
 * These scans are append-mostly: once an event is no longer the last one
 * produced by a rebuild, its content never changes again (only a streaming
 * tail — the previously-last event — can still be revised in place, e.g. a
 * Copilot markdown part whose text keeps growing). So only that last event
 * needs a full value comparison; everything earlier can use the cheap
 * identity key instead of re-serializing the whole prefix on every poll.
 */
export function reconcileTranscriptEvents(
  current: TranscriptEvent[],
  next: ReadonlyArray<TranscriptEvent>,
): boolean {
  const stableCount = Math.max(0, current.length - 1)
  const prefixUnchanged = current.length <= next.length
    && current.every((event, index) => index < stableCount
      ? eventIdentity(event) === eventIdentity(next[index]!)
      : JSON.stringify(event) === JSON.stringify(next[index]))
  if (prefixUnchanged) {
    for (let index = current.length; index < next.length; index += 1) {
      current.push(next[index]!)
    }
    return false
  }
  current.length = 0
  for (const event of next) current.push(event)
  return true
}

export function emptyTranscriptStats(mtime: number, size: number, now: number): TranscriptStats {
  return {
    records: 0,
    tools: 0,
    toolCounts: {},
    reads: 0,
    errors: 0,
    tokensOut: 0,
    firstTs: null,
    lastTs: null,
    mtime,
    ago: Math.max(0, now - mtime),
    live: false,
    size,
    todos: null,
    skills: [],
    milestones: [],
    current: null,
    files: [],
    commands: [],
    finalText: '',
  }
}

export function emptyTranscriptDiagnostics(environment: SessionEnvironment): RunDiagnostics {
  return {
    incidents: [],
    turns: [],
    compactions: [],
    outcomes: [],
    changes: [],
    git: [],
    agents: [],
    environment: { ...environment },
    causal: {
      records: 0,
      recordsWithUuid: 0,
      branchPoints: 0,
      sidechainRecords: 0,
      interruptions: 0,
    },
    usage: { in: 0, out: 0, cr: 0, cw: 0 },
  }
}
