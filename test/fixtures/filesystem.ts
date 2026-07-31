import { Effect, Layer, Option, Stream } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as PlatformError from 'effect/PlatformError'

const encoder = new TextEncoder()

export interface FakeEntry {
  content: string
  /** Seconds since epoch, matching how `TranscriptScan` reports `mtime`. */
  mtime?: number
}

export type FakeTree = Record<string, string | FakeEntry>

export function operationConcurrencyProbe(): {
  readonly beforeOperation: () => Effect.Effect<void>
  readonly afterOperation: () => Effect.Effect<void>
  readonly maximum: () => number
} {
  let active = 0
  let maximum = 0
  return {
    beforeOperation: () => Effect.sync(() => {
      active += 1
      maximum = Math.max(maximum, active)
    }).pipe(Effect.andThen(Effect.yieldNow)),
    afterOperation: () => Effect.sync(() => {
      active -= 1
    }),
    maximum: () => maximum,
  }
}

const entryOf = (value: string | FakeEntry): FakeEntry =>
  typeof value === 'string' ? { content: value } : value

const notFound = (method: string, path: string) =>
  PlatformError.systemError({ _tag: 'NotFound', module: 'FileSystem', method, pathOrDescriptor: path })

/**
 * An in-memory `FileSystem` built from a path → content map.
 *
 * Unit tests use this instead of `mkdtemp`, which keeps them off the disk and —
 * more importantly — lets them control `mtime` and inject failures that a real
 * temp directory cannot produce. Mutating operations die loudly so a regression
 * cannot silently write through Effect's otherwise permissive no-op test layer.
 */
export function testFileSystem(tree: FakeTree, options: {
  /** Paths that fail with PermissionDenied instead of being read. */
  readonly denied?: ReadonlyArray<string>
  /** Effect run immediately before file content is returned or streamed. */
  readonly beforeRead?: (path: string) => Effect.Effect<void>
  /** Called with the path each time file content is read (not stat'd). */
  readonly onRead?: (path: string) => void
  /** Effects bracketing each read-only filesystem operation. */
  readonly beforeOperation?: (method: string, path: string) => Effect.Effect<void>
  readonly afterOperation?: (method: string, path: string) => Effect.Effect<void>
} = {}): Layer.Layer<FileSystem.FileSystem> {
  const files = new Map(Object.entries(tree).map(([path, value]) => [path, entryOf(value)]))
  const denied = new Set(options.denied ?? [])
  const beforeRead = options.beforeRead ?? (() => Effect.void)
  const onRead = options.onRead ?? (() => {})
  const beforeOperation = options.beforeOperation ?? (() => Effect.void)
  const afterOperation = options.afterOperation ?? (() => Effect.void)

  const directories = new Set<string>()
  for (const path of files.keys()) {
    const segments = path.split('/')
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join('/'))
    }
  }

  const guard = (method: string, path: string) =>
    denied.has(path)
      ? Option.some(PlatformError.systemError({
          _tag: 'PermissionDenied',
          module: 'FileSystem',
          method,
          pathOrDescriptor: path,
        }))
      : Option.none<PlatformError.PlatformError>()

  const rejectMutation = (method: string, path: string) =>
    Effect.die(new Error(`test filesystem is read-only: ${method}(${path})`))
  const readOperation = <A, E, R>(
    method: string,
    path: string,
    operation: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    beforeOperation(method, path).pipe(
      Effect.andThen(operation),
      Effect.ensuring(afterOperation(method, path)),
    )

  return FileSystem.layerNoop({
    chmod: path => rejectMutation('chmod', path),
    chown: path => rejectMutation('chown', path),
    copy: fromPath => rejectMutation('copy', fromPath),
    copyFile: fromPath => rejectMutation('copyFile', fromPath),
    link: fromPath => rejectMutation('link', fromPath),
    makeDirectory: path => rejectMutation('makeDirectory', path),
    remove: path => rejectMutation('remove', path),
    rename: oldPath => rejectMutation('rename', oldPath),
    symlink: fromPath => rejectMutation('symlink', fromPath),
    truncate: path => rejectMutation('truncate', path),
    utimes: path => rejectMutation('utimes', path),
    writeFile: path => rejectMutation('writeFile', path),
    writeFileString: path => rejectMutation('writeFileString', path),

    readFileString: (path: string) => {
      const denial = guard('readFileString', path)
      if (Option.isSome(denial)) return Effect.fail(denial.value)
      const file = files.get(path)
      if (!file) return Effect.fail(notFound('readFileString', path))
      return readOperation('readFileString', path, beforeRead(path).pipe(
        Effect.tap(() => Effect.sync(() => onRead(path))),
        Effect.as(file.content),
      ))
    },

    stream: (path, streamOptions) => {
      const denial = guard('stream', path)
      if (Option.isSome(denial)) return Stream.fail(denial.value)
      const file = files.get(path)
      if (!file) return Stream.fail(notFound('stream', path))
      const bytes = encoder.encode(file.content)
      const offset = Number(streamOptions?.offset ?? 0)
      const end = streamOptions?.bytesToRead === undefined
        ? bytes.length
        : Math.min(bytes.length, offset + Number(streamOptions.bytesToRead))
      const contents = Stream.fromEffect(beforeRead(path).pipe(
        Effect.tap(() => Effect.sync(() => onRead(path))),
      )).pipe(
        Stream.flatMap(() => Stream.make(bytes.subarray(offset, end))),
      )
      return Stream.scoped(
        Stream.fromEffect(Effect.acquireRelease(
          beforeOperation('stream', path),
          () => afterOperation('stream', path),
        )).pipe(Stream.flatMap(() => contents)),
      )
    },

    readDirectory: (path: string) => {
      const denial = guard('readDirectory', path)
      if (Option.isSome(denial)) return Effect.fail(denial.value)
      if (!directories.has(path)) return Effect.fail(notFound('readDirectory', path))
      const prefix = `${path}/`
      const names = new Set<string>()
      for (const candidate of [...files.keys(), ...directories]) {
        if (!candidate.startsWith(prefix)) continue
        const rest = candidate.slice(prefix.length)
        if (rest) names.add(rest.split('/')[0]!)
      }
      return readOperation('readDirectory', path, Effect.succeed([...names].sort()))
    },

    stat: (path: string) => {
      const denial = guard('stat', path)
      if (Option.isSome(denial)) return Effect.fail(denial.value)
      const file = files.get(path)
      if (file) {
        return readOperation('stat', path, Effect.succeed({
          type: 'File',
          mtime: file.mtime === undefined ? Option.none() : Option.some(new Date(file.mtime * 1_000)),
          size: FileSystem.Size(Buffer.byteLength(file.content)),
        } as FileSystem.File.Info))
      }
      if (directories.has(path)) {
        return readOperation('stat', path, Effect.succeed({
          type: 'Directory',
          mtime: Option.none(),
          size: FileSystem.Size(0),
        } as FileSystem.File.Info))
      }
      return Effect.fail(notFound('stat', path))
    },
  })
}
