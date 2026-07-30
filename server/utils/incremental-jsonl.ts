import { Effect, Option, Stream } from 'effect'
import * as FileSystem from 'effect/FileSystem'

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
  line: number
  malformed: number
  mtime: number
  size: number
  bytesConsumed: number
  lastLoadedMtime: number
  lastLoadedSize: number
}

/**
 * Advance an incremental JSONL scan and return the newly complete records as
 * `[absolute line index, parsed JSON]` pairs.
 *
 * A missing file is not an error — scans are polled while the writer is still
 * creating files. The file is stat'd first so an unchanged one costs no read,
 * and an appended one is read only from the last consumed byte onward. Lines
 * that fail to parse as JSON count toward `state.malformed`.
 */
export const consumeNewRecords = Effect.fn('consumeNewRecords')(function*(
  path: string,
  state: IncrementalScanState,
) {
  const fs = yield* FileSystem.FileSystem
  const records: Array<[index: number, value: unknown]> = []

  const infoOption = yield* fs.stat(path).pipe(
    Effect.map(Option.some),
    Effect.catchIf(
      error => error.reason._tag === 'NotFound',
      () => Effect.succeed(Option.none<FileSystem.File.Info>()),
    ),
  )
  if (Option.isNone(infoOption) || infoOption.value.type !== 'File') return records

  const info = infoOption.value
  state.mtime = Option.match(info.mtime, {
    onNone: () => state.mtime,
    onSome: date => date.getTime() / 1_000,
  })
  state.size = Number(info.size)
  if (state.size === state.lastLoadedSize && state.mtime === state.lastLoadedMtime) return records

  // A shrunken file was rewritten, not appended; the byte offset no longer
  // points into it, so re-read from the start and skip consumed lines.
  const fromByte = state.size < state.bytesConsumed ? 0 : state.bytesConsumed
  const read = yield* readCompleteLines(path, fromByte).pipe(
    Effect.map(Option.some),
    Effect.catchIf(
      error => error.reason._tag === 'NotFound',
      () => Effect.succeed(Option.none<AppendedLines>()),
    ),
  )
  if (Option.isNone(read)) return records

  const { lines, nextByte } = read.value
  const baseLine = fromByte === 0 ? 0 : state.line
  for (let offset = fromByte === 0 ? state.line : 0; offset < lines.length; offset += 1) {
    const line = lines[offset]!
    if (!line.trim()) continue
    try {
      records.push([baseLine + offset, JSON.parse(line)])
    } catch {
      state.malformed += 1
    }
  }
  state.line = baseLine + lines.length
  state.bytesConsumed = nextByte
  state.lastLoadedMtime = state.mtime
  state.lastLoadedSize = state.size
  return records
})
