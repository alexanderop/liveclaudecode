import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { Effect, Option, Result } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { NoTranscriptsFound, ProjectsDirectory, UnknownProject, WorkingDirectory } from './services'
import { FILE_CONCURRENCY, ignoreNotFound } from './filesystem-concurrency'

export interface ProjectDirectory {
  id: string
  directory: string
}

/**
 * `stat` failures other than "not found" are real problems — a permissions
 * error is not the same as "this is not a directory". Only NotFound is folded
 * into `false`; anything else propagates.
 */
export const isDirectory = Effect.fn('isDirectory')(function*(path: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.stat(path).pipe(
    Effect.map(info => info.type === 'Directory'),
    ignoreNotFound(() => Effect.succeed(false)),
  )
})

const containsTranscript = Effect.fn('containsTranscript')(function*(path: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readDirectory(path).pipe(
    Effect.map(names => names.some(name => name.endsWith('.jsonl'))),
    ignoreNotFound(() => Effect.succeed(false)),
  )
})

export function projectDirectoryFor(cwd: string, projectsDirectory: string): string {
  return join(projectsDirectory, cwd.replaceAll(/[^a-zA-Z0-9_-]/g, '-'))
}

export const newestProjectDirectory = Effect.fn('newestProjectDirectory')(function*() {
  const fs = yield* FileSystem.FileSystem
  const projectsDirectory = yield* ProjectsDirectory

  const names = yield* fs.readDirectory(projectsDirectory).pipe(
    ignoreNotFound(() => Effect.fail(new NoTranscriptsFound({ directory: projectsDirectory }))),
  )

  const directories = yield* Effect.filterMapEffect(names, name =>
    Effect.gen(function*() {
      const path = join(projectsDirectory, name)
      const info = yield* fs.stat(path)
      if (info.type !== 'Directory') return Result.fail(name)
      const mtime = Option.match(info.mtime, { onNone: () => 0, onSome: date => date.getTime() })
      return Result.succeed({ path, mtime })
    }), { concurrency: FILE_CONCURRENCY })

  const newest = directories.sort((a, b) => b.mtime - a.mtime)[0]
  if (!newest) return yield* new NoTranscriptsFound({ directory: projectsDirectory })
  return newest.path
})

export const listProjectDirectories = Effect.fn('listProjectDirectories')(function*() {
  const fs = yield* FileSystem.FileSystem
  const projectsDirectory = yield* ProjectsDirectory

  const names = yield* fs.readDirectory(projectsDirectory).pipe(
    ignoreNotFound(() => Effect.fail(new NoTranscriptsFound({ directory: projectsDirectory }))),
  )

  const projects = yield* Effect.filterMapEffect(names, name =>
    Effect.gen(function*() {
      const directory = join(projectsDirectory, name)
      if (!(yield* isDirectory(directory))) return Result.fail(name)
      return (yield* containsTranscript(directory)) ? Result.succeed({ id: name, directory }) : Result.fail(name)
    }), { concurrency: FILE_CONCURRENCY })

  return projects.sort((a, b) => a.id.localeCompare(b.id))
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
        return projectDirectoryFor(candidate, projectsDirectory)
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
