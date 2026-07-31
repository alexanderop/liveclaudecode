import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import {
  listProjectDirectories,
  projectDirectoryFor,
  resolveProjectDirectories,
  resolveProjectDirectory,
} from '#server/utils/project'
import { FILE_CONCURRENCY } from '#server/utils/filesystem-concurrency'
import { ProjectsDirectory, WorkingDirectory } from '#server/utils/services'
import {
  operationConcurrencyProbe,
  testFileSystem,
  type FakeTree,
} from '../fixtures/filesystem'

const PROJECTS = '/home/me/.claude/projects'
const CWD = '/home/me/work'

/**
 * `ProjectsDirectory` and `WorkingDirectory` are references, so tests override
 * them by providing a layer instead of threading them through every call as
 * positional parameters.
 */
type FileSystemOptions = NonNullable<Parameters<typeof testFileSystem>[1]>

const withTree = (tree: FakeTree, options: FileSystemOptions = {}) =>
  Layer.mergeAll(
    Layer.succeed(ProjectsDirectory)(PROJECTS),
    Layer.succeed(WorkingDirectory)(CWD),
    testFileSystem(tree, options),
  )

describe('project resolution', () => {
  it('uses Claude Code slugification for a repository path', () => {
    assert.strictEqual(
      projectDirectoryFor('/Users/me/code/app', PROJECTS),
      `${PROJECTS}/-Users-me-code-app`,
    )
    assert.strictEqual(
      projectDirectoryFor('/private/tmp/live.probe with spaces', PROJECTS),
      `${PROJECTS}/-private-tmp-live-probe-with-spaces`,
    )
  })

  it.effect('accepts a transcript directory directly', () =>
    resolveProjectDirectory('/home/me/transcripts').pipe(
      Effect.map(result => assert.strictEqual(result, '/home/me/transcripts')),
      Effect.provide(withTree({ '/home/me/transcripts/run.jsonl': '{}\n' })),
    ))

  it.effect('resolves a repository path through its transcript slug', () =>
    Effect.gen(function*() {
      const slug = projectDirectoryFor('/home/me/repo', PROJECTS)
      const result = yield* resolveProjectDirectory('/home/me/repo')
      assert.strictEqual(result, slug)
    }).pipe(Effect.provide(withTree({
      '/home/me/repo/README.md': '#',
      [`${projectDirectoryFor('/home/me/repo', PROJECTS)}/run.jsonl`]: '{}\n',
    }))))

  it.effect('accepts a repository before its transcript directory exists', () =>
    Effect.gen(function*() {
      const result = yield* resolveProjectDirectory('/home/me/new-repo')
      assert.strictEqual(result, projectDirectoryFor('/home/me/new-repo', PROJECTS))
    }).pipe(Effect.provide(withTree({
      '/home/me/new-repo/README.md': '#',
    }))))

  it.effect('resolves a slug under the projects directory', () =>
    resolveProjectDirectory('my-project').pipe(
      Effect.map(result => assert.strictEqual(result, `${PROJECTS}/my-project`)),
      Effect.provide(withTree({ [`${PROJECTS}/my-project/run.jsonl`]: '{}\n' })),
    ))

  it.effect('discovers every project directory containing a JSONL transcript', () =>
    Effect.gen(function*() {
      const expected = [
        { id: 'first', directory: `${PROJECTS}/first` },
        { id: 'second', directory: `${PROJECTS}/second` },
      ]
      assert.deepStrictEqual(yield* listProjectDirectories(), expected)
      assert.deepStrictEqual(yield* resolveProjectDirectories(''), expected)
    }).pipe(Effect.provide(withTree({
      [`${PROJECTS}/first/one.jsonl`]: '{}\n',
      [`${PROJECTS}/second/two.jsonl`]: '{}\n',
      [`${PROJECTS}/empty/notes.md`]: '#',
    }))))

  it.effect('bounds project discovery filesystem concurrency', () => {
    const probe = operationConcurrencyProbe()
    const history = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [
      `${PROJECTS}/project-${index}/session.jsonl`,
      '{}\n',
    ]))
    return Effect.gen(function*() {
      const projects = yield* listProjectDirectories()
      assert.strictEqual(projects.length, 40)
      assert.isAtMost(probe.maximum(), FILE_CONCURRENCY)
      assert.isAbove(probe.maximum(), 1)
    }).pipe(Effect.provide(withTree(history, probe)))
  })

  it.effect('reports an unknown project as a typed failure', () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(resolveProjectDirectory('nope'))
      assert.strictEqual(error._tag, 'UnknownProject')
    }).pipe(Effect.provide(withTree({ [`${PROJECTS}/first/one.jsonl`]: '{}\n' }))))

  it.effect('fails when the projects directory does not exist', () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(listProjectDirectories())
      assert.strictEqual(error._tag, 'NoTranscriptsFound')
    }).pipe(Effect.provide(withTree({}))))

  /**
   * The previous implementation collapsed every `stat` failure into `false`, so
   * a permissions problem was indistinguishable from "not a directory" and no
   * test could reach the branch. Now it propagates.
   */
  it.effect('surfaces a permission error instead of reporting no transcripts', () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(listProjectDirectories())
      assert.strictEqual(error._tag, 'PlatformError')
      if (error._tag !== 'PlatformError') return
      assert.strictEqual(error.reason._tag, 'PermissionDenied')
    }).pipe(Effect.provide(withTree(
      { [`${PROJECTS}/locked/one.jsonl`]: '{}\n' },
      { denied: [`${PROJECTS}/locked`] },
    ))))
})
