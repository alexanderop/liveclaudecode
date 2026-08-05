import { assert, describe, it } from '@effect/vitest'
import { ConfigProvider, Effect, Layer } from 'effect'
import { projectDirectoryFor } from '#server/utils/project'
import {
  CodexSessionsDirectory,
  CopilotSessionStateDirectory,
  layerTranscriptDirectories,
  ProjectsDirectory,
  VsCodeUserDataDirectories,
} from '#server/utils/services'
import { projectSlug, resolveRoots, SOURCES } from '../../script/cassette/sources.ts'
import { CASSETTE_SOURCES, type CassetteSource } from '../cassettes/redaction/rules'

/**
 * `script/cassette/sources.ts` is a deliberate copy of the root resolution in
 * `server/utils/services.ts`: the recorder is a bare Node process and cannot
 * resolve the `#server` alias, so the values are mirrored rather than imported.
 *
 * A copy that nobody compares is a copy that drifts. These tests are the reason
 * the duplication is acceptable — they fail the moment a default or an
 * override rule changes on one side only, which is the failure mode that would
 * otherwise show up as a recorder that quietly records nothing.
 *
 * Every case runs over all four sources rather than naming one: the descriptor
 * table is what makes that free, and a mirroring test that covers three of four
 * sources is a mirroring test with a hole in it.
 */

/**
 * The server's root for each source, always as a list.
 *
 * Four `Context.Reference`s with three different value types is the one thing
 * the descriptor table cannot flatten — the references *are* the server's
 * surface. Widening the single-root ones here is what lets every case below be
 * one loop.
 */
const SERVER_ROOTS: Readonly<
  Record<CassetteSource, Effect.Effect<ReadonlyArray<string>>>
> = {
  'claude': Effect.map(ProjectsDirectory, root => [root]),
  'codex': Effect.map(CodexSessionsDirectory, root => [root]),
  'copilot': VsCodeUserDataDirectories,
  'copilot-cli': Effect.map(CopilotSessionStateDirectory, root => [root]),
}

/**
 * Run `body` with `variables` applied to `process.env`, then restore it.
 *
 * The script half of each comparison has no `Config` — reading the environment
 * directly is the behaviour under test — so the environment is set and put back
 * around the one call rather than left mutated for the next case.
 */
function withProcessEnv<A>(variables: Record<string, string>, body: () => A): A {
  const previous = new Map(Object.keys(variables).map(key => [key, process.env[key]]))
  Object.assign(process.env, variables)
  try {
    return body()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  }
}

/** The same value for every source's override variable. */
function everyOverride(value: (source: CassetteSource) => string): Record<string, string> {
  return Object.fromEntries(
    CASSETTE_SOURCES.map(source => [SOURCES[source].envVar, value(source)]),
  )
}

/**
 * The server reads `LCC_*` through `Config`, so a test supplies a provider
 * rather than mutating `process.env`. The script has no `Config`, so its half
 * of each comparison does read the environment — set and restored around the
 * one call, so nothing leaks into a neighbouring test.
 */
const withEnvironment = (variables: Record<string, string>) =>
  Layer.provide(
    layerTranscriptDirectories,
    ConfigProvider.layer(ConfigProvider.fromUnknown(variables)),
  )

/** Every source's server-side root, as lists, in one pass. */
const serverRoots = Effect.forEach(
  CASSETTE_SOURCES,
  source => Effect.map(SERVER_ROOTS[source], roots => [source, [...roots]] as const),
).pipe(Effect.map(entries => Object.fromEntries(entries)))

/** Every source's script-side root, shaped to match. */
function scriptRoots(variables: Record<string, string>): Record<string, readonly string[]> {
  const resolved = withProcessEnv(variables, resolveRoots)
  return Object.fromEntries(CASSETTE_SOURCES.map(source => [source, [...resolved[source]]]))
}

describe('cassette root mirroring', () => {
  it.effect('mirrors the platform defaults the server uses', () =>
    Effect.gen(function*() {
      const server = yield* serverRoots

      assert.deepStrictEqual(
        server,
        Object.fromEntries(
          CASSETTE_SOURCES.map(source => [source, [...SOURCES[source].defaultRoots()]]),
        ),
      )
    }))

  it('mirrors Claude Code slugification', () => {
    // The recorder recomputes the project slug from the *pseudonymized* cwd
    // rather than string-patching the recorded one, so this rule has to be the
    // same rule on both sides or a cassette lands under a directory the
    // dashboard will never look in.
    for (const cwd of [
      '/Users/me/code/app',
      '/private/tmp/live.probe with spaces',
      '/Users/user-1/Projects/repo-1',
    ]) {
      const PROJECTS = '/projects'
      assert.strictEqual(
        `${PROJECTS}/${projectSlug(cwd)}`,
        projectDirectoryFor(cwd, PROJECTS),
      )
    }
  })

  const overrides = everyOverride(source => `/tmp/${source}`)

  it.effect('mirrors the LCC_* override precedence', () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(scriptRoots(overrides), yield* serverRoots)
    }).pipe(Effect.provide(withEnvironment(overrides))))

  const blanks = everyOverride(() => '')

  it.effect('mirrors the rule that a blank override reads as unset', () =>
    Effect.gen(function*() {
      const server = yield* serverRoots

      assert.deepStrictEqual(scriptRoots(blanks), server)
      assert.deepStrictEqual(
        server,
        Object.fromEntries(
          CASSETTE_SOURCES.map(source => [source, [...SOURCES[source].defaultRoots()]]),
        ),
      )
    }).pipe(Effect.provide(withEnvironment(blanks))))
})
