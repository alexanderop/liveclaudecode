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
  /** Called with the path each time file content is read (not stat'd). */
  readonly onRead?: (path: string) => void
} = {}): Layer.Layer<FileSystem.FileSystem> {
  const files = new Map(Object.entries(tree).map(([path, value]) => [path, entryOf(value)]))
  const denied = new Set(options.denied ?? [])
  const onRead = options.onRead ?? (() => {})

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
      onRead(path)
      return Effect.succeed(file.content)
    },

    stream: (path, streamOptions) => {
      const denial = guard('stream', path)
      if (Option.isSome(denial)) return Stream.fail(denial.value)
      const file = files.get(path)
      if (!file) return Stream.fail(notFound('stream', path))
      onRead(path)
      const bytes = encoder.encode(file.content)
      const offset = Number(streamOptions?.offset ?? 0)
      const end = streamOptions?.bytesToRead === undefined
        ? bytes.length
        : Math.min(bytes.length, offset + Number(streamOptions.bytesToRead))
      return Stream.make(bytes.subarray(offset, end))
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
      return Effect.succeed([...names].sort())
    },

    stat: (path: string) => {
      const denial = guard('stat', path)
      if (Option.isSome(denial)) return Effect.fail(denial.value)
      const file = files.get(path)
      if (file) {
        return Effect.succeed({
          type: 'File',
          mtime: file.mtime === undefined ? Option.none() : Option.some(new Date(file.mtime * 1_000)),
          size: FileSystem.Size(Buffer.byteLength(file.content)),
        } as FileSystem.File.Info)
      }
      if (directories.has(path)) {
        return Effect.succeed({
          type: 'Directory',
          mtime: Option.none(),
          size: FileSystem.Size(0),
        } as FileSystem.File.Info)
      }
      return Effect.fail(notFound('stat', path))
    },
  })
}
