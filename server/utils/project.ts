import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { NoTranscriptsFound, ProjectsDirectory, UnknownProject, WorkingDirectory } from './services'
import { FILE_CONCURRENCY } from './filesystem-concurrency'

export interface ProjectDirectory {
  id: string
  directory: string
}

/**
 * `stat` failures other than "not found" are real problems — a permissions
 * error is not the same as "this is not a directory". Only NotFound is folded
 * into `false`; anything else propagates.
 */
const isDirectory = Effect.fn('isDirectory')(function*(path: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.stat(path).pipe(
    Effect.map(info => info.type === 'Directory'),
    Effect.catchIf(
      error => error.reason._tag === 'NotFound',
      () => Effect.succeed(false),
    ),
  )
})

const containsTranscript = Effect.fn('containsTranscript')(function*(path: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readDirectory(path).pipe(
    Effect.map(names => names.some(name => name.endsWith('.jsonl'))),
    Effect.catchIf(
      error => error.reason._tag === 'NotFound',
      () => Effect.succeed(false),
    ),
  )
})

export function projectDirectoryFor(cwd: string, projectsDirectory: string): string {
  return join(projectsDirectory, cwd.replaceAll(/[^a-zA-Z0-9_-]/g, '-'))
}

export const newestProjectDirectory = Effect.fn('newestProjectDirectory')(function*() {
  const fs = yield* FileSystem.FileSystem
  const projectsDirectory = yield* ProjectsDirectory

  const names = yield* fs.readDirectory(projectsDirectory).pipe(
    Effect.catchIf(
      error => error.reason._tag === 'NotFound',
      () => Effect.fail(new NoTranscriptsFound({ directory: projectsDirectory })),
    ),
  )

  const directories = yield* Effect.forEach(names, name =>
    Effect.gen(function*() {
      const path = join(projectsDirectory, name)
      const info = yield* fs.stat(path)
      if (info.type !== 'Directory') return []
      const mtime = info.mtime._tag === 'Some' ? info.mtime.value.getTime() : 0
      return [{ path, mtime }]
    }), { concurrency: FILE_CONCURRENCY })

  const newest = directories.flat().sort((a, b) => b.mtime - a.mtime)[0]
  if (!newest) return yield* new NoTranscriptsFound({ directory: projectsDirectory })
  return newest.path
})

export const listProjectDirectories = Effect.fn('listProjectDirectories')(function*() {
  const fs = yield* FileSystem.FileSystem
  const projectsDirectory = yield* ProjectsDirectory

  const names = yield* fs.readDirectory(projectsDirectory).pipe(
    Effect.catchIf(
      error => error.reason._tag === 'NotFound',
      () => Effect.fail(new NoTranscriptsFound({ directory: projectsDirectory })),
    ),
  )

  const projects = yield* Effect.forEach(names, name =>
    Effect.gen(function*() {
      const directory = join(projectsDirectory, name)
      if (!(yield* isDirectory(directory))) return []
      return (yield* containsTranscript(directory)) ? [{ id: name, directory }] : []
    }), { concurrency: FILE_CONCURRENCY })

  return projects.flat().sort((a, b) => a.id.localeCompare(b.id))
})

export const resolveProjectDirectory = Effect.fn('resolveProjectDirectory')(
  function*(input = '') {
    const projectsDirectory = yield* ProjectsDirectory
    const cwd = yield* WorkingDirectory

    if (input) {
      const expanded = input.startsWith('~/') ? join(homedir(), input.slice(2)) : input
      const candidate = isAbsolute(expanded) ? expanded : resolve(cwd, expanded)
      if (yield* isDirectory(candidate)) {
        if (yield* containsTranscript(candidate)) return candidate
        const guessed = projectDirectoryFor(candidate, projectsDirectory)
        if (yield* isDirectory(guessed)) return guessed
        return guessed
      }

      const slug = join(projectsDirectory, input)
      if (yield* isDirectory(slug)) return slug
      return yield* new UnknownProject({ input, directory: projectsDirectory })
    }

    const current = projectDirectoryFor(cwd, projectsDirectory)
    return (yield* isDirectory(current)) ? current : yield* newestProjectDirectory()
  },
)

export const resolveProjectDirectories = Effect.fn('resolveProjectDirectories')(
  function*(input = '') {
    if (!input) return yield* listProjectDirectories()
    const directory = yield* resolveProjectDirectory(input)
    return [{ id: basename(directory), directory }]
  },
)

export function projectName(projectDirectory: string): string {
  return basename(projectDirectory)
}
