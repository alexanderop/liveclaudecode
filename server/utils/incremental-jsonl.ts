import { Effect, Option, Stream } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type * as PlatformError from 'effect/PlatformError'
import { ignoreNotFound, statIfExists } from './filesystem-concurrency'

const utf8 = new TextDecoder()

function bytesOf(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks)
}

interface AppendedLines {
  lines: string[]
  nextByte: number
}

/**
 * Read the complete lines that start at byte `fromByte`, leaving a trailing
 * partial line for a later read. `nextByte` is the offset just past the last
 * newline consumed, so the next call picks up exactly where this one stopped.
 */
const readCompleteLines = Effect.fn('readCompleteLines')(function*(
  path: string,
  fromByte: number,
) {
  const fs = yield* FileSystem.FileSystem
  const bytes = bytesOf(yield* Stream.runCollect(fs.stream(path, { offset: fromByte })))
  const lastNewline = bytes.lastIndexOf(0x0A)
  if (lastNewline < 0) return { lines: [], nextByte: fromByte } satisfies AppendedLines
  return {
    lines: utf8.decode(bytes.subarray(0, lastNewline)).split('\n'),
    nextByte: fromByte + lastNewline + 1,
  } satisfies AppendedLines
})

/** Read at most the first `maxBytes` of a file as text. */
export const readHead = Effect.fn('readHead')(function*(path: string, maxBytes: number) {
  const fs = yield* FileSystem.FileSystem
  return utf8.decode(bytesOf(yield* Stream.runCollect(fs.stream(path, { bytesToRead: maxBytes }))))
})

/** The bookkeeping an incremental JSONL scan carries between refreshes. */
export interface IncrementalScanState {
  readonly line: number
  readonly malformed: number
  readonly mtime: number
  readonly size: number
  readonly bytesConsumed: number
  readonly lastLoadedMtime: number
  readonly lastLoadedSize: number
}

export interface ConsumeNewRecordsResult {
  /** Newly complete records, as `[absolute line index, parsed JSON]` pairs. */
  readonly records: Array<[index: number, value: unknown]>
  /** The state to carry into the next call; callers apply this back onto their own bookkeeping. */
  readonly next: IncrementalScanState
}

/**
 * Advance an incremental JSONL scan and return the newly complete records
 * alongside the state to carry forward. State-in/state-out rather than a
 * mutation of `state`, so callers can see (and log) exactly what changed.
 *
 * A missing file is not an error — scans are polled while the writer is still
 * creating files. The file is stat'd first so an unchanged one costs no read,
 * and an appended one is read only from the last consumed byte onward. Lines
 * that fail to parse as JSON are logged at debug level and counted toward
 * `next.malformed`.
 */
export const consumeNewRecords = Effect.fn('consumeNewRecords')(function*(
  path: string,
  state: IncrementalScanState,
): Effect.fn.Return<ConsumeNewRecordsResult, PlatformError.PlatformError, FileSystem.FileSystem> {
  const infoOption = yield* statIfExists(path)
  if (Option.isNone(infoOption) || infoOption.value.type !== 'File') {
    return { records: [], next: state }
  }

  const info = infoOption.value
  const mtime = Option.match(info.mtime, {
    onNone: () => state.mtime,
    onSome: date => date.getTime() / 1_000,
  })
  const size = Number(info.size)
  if (size === state.lastLoadedSize && mtime === state.lastLoadedMtime) {
    return { records: [], next: { ...state, mtime, size } }
  }

  // A shrunken file was rewritten, not appended; the byte offset no longer
  // points into it, so re-read from the start and skip consumed lines.
  const fromByte = size < state.bytesConsumed ? 0 : state.bytesConsumed
  const read = yield* readCompleteLines(path, fromByte).pipe(
    Effect.map(Option.some),
    ignoreNotFound(() => Effect.succeed(Option.none<AppendedLines>())),
  )
  if (Option.isNone(read)) return { records: [], next: { ...state, mtime, size } }

  const { lines, nextByte } = read.value
  const baseLine = fromByte === 0 ? 0 : state.line
  const records: Array<[index: number, value: unknown]> = []
  let malformed = state.malformed
  for (let offset = fromByte === 0 ? state.line : 0; offset < lines.length; offset += 1) {
    const line = lines[offset]!
    if (!line.trim()) continue
    try {
      records.push([baseLine + offset, JSON.parse(line)])
    } catch (error) {
      malformed += 1
      yield* Effect.logDebug('Skipping malformed JSONL line', { path, line: baseLine + offset, error })
    }
  }
  return {
    records,
    next: {
      line: baseLine + lines.length,
      malformed,
      mtime,
      size,
      bytesConsumed: nextByte,
      lastLoadedMtime: mtime,
      lastLoadedSize: size,
    },
  }
})
