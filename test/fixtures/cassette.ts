/**
 * The cassette loader.
 *
 * A cassette is served two ways. Unit tiers get {@link Cassette.layer}, which
 * mounts the recorded tree in the existing `testFileSystem()` and points each
 * root `Context.Reference` at its subtree — no disk, no new filesystem fake,
 * and `FakeEntry.mtime` fed straight from the manifest so freshness filtering
 * is exercised rather than bypassed. The e2e tier gets {@link materializeAll},
 * which writes the same trees to a real directory for a real server to read.
 *
 * Cassettes are read from disk at module load with `node:fs`. This is test
 * support code rather than server domain code, and it has to be synchronous so
 * `describe`-time enumeration over `allCassettes()` works.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Layer } from 'effect'
import type * as FileSystem from 'effect/FileSystem'
import type { FileDiscoveryLimiter } from '#server/utils/filesystem-concurrency'
import {
  CodexSessionsDirectory,
  CopilotSessionStateDirectory,
  ProjectsDirectory,
  VsCodeUserDataDirectories,
} from '#server/utils/services'
import { SOURCES } from '../../script/cassette/sources.ts'
import {
  CASSETTE_SOURCES,
  type CassetteSource,
  NEWEST_RECORD_LEAD_MS,
} from '../cassettes/redaction/rules'
import { type CassetteManifest, decodeCassetteManifest } from './cassette-schema'
import { type FakeTree, testFileSystem } from './filesystem'

export type { CassetteSource }

export const CASSETTE_DIRECTORY = fileURLToPath(new URL('../cassettes/', import.meta.url))

export interface CassetteRoots {
  /** The directory the cassette was written into. */
  readonly directory: string
  /**
   * Each source's root inside that directory. Point the source's
   * `SOURCES[source].envVar` at it to serve the cassette to a real server.
   */
  readonly bySource: Readonly<Record<CassetteSource, string>>
}

export interface MaterializeOptions {
  /**
   * How file `mtime`s are anchored on the materialized copy.
   *
   * - `'recorded'` (default) writes the manifest's mtimes verbatim. Correct
   *   when the test pins its own clock.
   * - `'now'` shifts every mtime by one constant so the newest lands at
   *   `Date.now() - 5 minutes`. Intervals — and therefore ordering and
   *   freshness relative to each other — are preserved, but the cassette reads
   *   as recent no matter when it was recorded.
   *
   * @default 'recorded'
   */
  readonly anchor?: 'recorded' | 'now'
}

export interface Cassette {
  readonly id: string
  readonly manifest: CassetteManifest
  /** Cassette-relative path (below `files/`) → file body, as committed. */
  readonly files: ReadonlyMap<string, string>
  /**
   * The cassette served from memory, with every root `Context.Reference`
   * pointed at its subtree and `mtime`s taken from the manifest.
   *
   * Built on first read: it holds a second copy of every file body, and the
   * conformance, hygiene, and verify paths never touch it.
   */
  readonly layer: Layer.Layer<FileSystem.FileSystem | FileDiscoveryLimiter>
  /** The instant tests should pin `TestClock` to, in epoch milliseconds. */
  readonly clockAnchor: number
  /** Blessed expectations, read on demand so a missing one is a clear failure. */
  readonly expected: (name: 'parse' | 'scan') => unknown
  /** Absolute path of the cassette directory in the repository. */
  readonly directory: string
  /**
   * Where the `files/` tree is mounted inside {@link Cassette.layer}. Join a
   * cassette-relative path onto it to address a file as the code under test
   * will see it.
   */
  readonly memoryBase: string
}

function readDirectorySafely(path: string): string[] {
  try {
    return readdirSync(path).sort((left, right) => left.localeCompare(right))
  } catch {
    return []
  }
}

/** Every committed cassette id, `<source>/<scenario>`, sorted. */
export function cassetteIds(): readonly string[] {
  return CASSETTE_SOURCES.flatMap(source =>
    readDirectorySafely(join(CASSETTE_DIRECTORY, source))
      .filter(scenario => {
        try {
          return statSync(join(CASSETTE_DIRECTORY, source, scenario, 'cassette.json')).isFile()
        } catch {
          return false
        }
      })
      .map(scenario => `${source}/${scenario}`),
  )
}

/**
 * The in-memory mount point. Absolute and POSIX-shaped because the scanners
 * build paths with `node:path.join`, and because a relative root would make
 * `readDirectory` on the fake filesystem ambiguous.
 */
function memoryRoot(id: string): string {
  return `/cassettes/${id}/files`
}

/**
 * Each source's subtree below `base`.
 *
 * `join` for a real directory, string concatenation for the in-memory mount:
 * the fake filesystem is keyed by POSIX paths regardless of platform, so
 * `node:path.join` would produce keys nothing looks up on Windows.
 */
function subtreesUnder(
  base: string,
  under: (base: string, subtree: string) => string,
): Readonly<Record<CassetteSource, string>> {
  return Object.fromEntries(
    CASSETTE_SOURCES.map(source => [source, under(base, SOURCES[source].subtree)]),
  ) as Record<CassetteSource, string>
}

function buildLayer(
  id: string,
  files: ReadonlyMap<string, string>,
  mtimes: ReadonlyMap<string, number>,
): Cassette['layer'] {
  const base = memoryRoot(id)
  const tree: FakeTree = {}
  for (const [path, content] of files) {
    tree[`${base}/${path}`] = { content, mtime: mtimes.get(path) ?? 0 }
  }

  const roots = subtreesUnder(base, (left, right) => `${left}/${right}`)

  // A source the cassette does not carry gets a root that simply has no files.
  // `readDirectory` then fails NotFound, which every discovery walk already
  // treats as "this tool is not installed" — the same state a real machine is
  // in, and one worth replaying rather than papering over.
  const directories = Context.make(ProjectsDirectory, roots.claude).pipe(
    Context.add(CodexSessionsDirectory, roots.codex),
    Context.add(CopilotSessionStateDirectory, roots['copilot-cli']),
    Context.add(VsCodeUserDataDirectories, [roots.copilot]),
  )

  return Layer.merge(testFileSystem(tree), Layer.succeedContext(directories))
}

function writeTree(
  directory: string,
  files: ReadonlyMap<string, string>,
  mtimes: ReadonlyMap<string, number>,
  offsetSeconds: number,
): void {
  for (const [relative, content] of files) {
    const path = join(directory, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    const mtime = (mtimes.get(relative) ?? 0) + offsetSeconds
    if (mtime > 0) utimesSync(path, mtime, mtime)
  }
}

/**
 * The offset that lands the newest recorded file five minutes before now.
 *
 * One offset for the whole set, so every interval between files — and
 * therefore session ordering and relative freshness — survives re-anchoring.
 */
function nowOffsetSeconds(mtimes: Iterable<number>): number {
  const newest = Math.max(0, ...mtimes)
  if (!newest) return 0
  return Math.floor((Date.now() - NEWEST_RECORD_LEAD_MS) / 1_000) - newest
}

function rootsFor(directory: string): CassetteRoots {
  return { directory, bySource: subtreesUnder(join(directory, 'files'), join) }
}

function disposableRoots(roots: CassetteRoots): CassetteRoots & AsyncDisposable {
  return {
    ...roots,
    [Symbol.asyncDispose]: async () => {
      rmSync(roots.directory, { recursive: true, force: true })
    },
  }
}

/** Manifest `mtime`s by cassette-relative path. */
function mtimesOf(manifest: CassetteManifest): ReadonlyMap<string, number> {
  return new Map(manifest.entries.map(entry => [entry.path, entry.mtime]))
}

export function loadCassette(id: string): Cassette {
  const directory = join(CASSETTE_DIRECTORY, id)
  const manifest = decodeCassetteManifest(
    JSON.parse(readFileSync(join(directory, 'cassette.json'), 'utf8')),
  )
  if (manifest.id !== id) {
    throw new Error(`Cassette at ${id} declares id ${manifest.id}; the two must agree`)
  }

  const files = new Map(manifest.entries.map(entry => [
    entry.path,
    readFileSync(join(directory, 'files', entry.path), 'utf8'),
  ]))
  let layer: Cassette['layer'] | undefined

  return {
    id,
    manifest,
    files,
    get layer() {
      return (layer ??= buildLayer(id, files, mtimesOf(manifest)))
    },
    directory,
    memoryBase: memoryRoot(id),
    clockAnchor: Date.parse(manifest.clockAnchor),
    expected: (name) => {
      const path = join(directory, 'expected', `${name}.json`)
      try {
        return JSON.parse(readFileSync(path, 'utf8'))
      } catch (error) {
        throw new Error(
          `Cassette ${id} has no readable expected/${name}.json. `
          + `Run \`pnpm cassette:bless --id ${id}\` and review the result.`,
          { cause: error },
        )
      }
    },
  }
}

/**
 * Where the L3 tier's blessed projection lives.
 *
 * One file, not one per cassette: L3 materializes every `e2e` cassette into a
 * *single* root and asserts the combined dashboard, because cross-source
 * aggregation is the thing L1 and L2 cannot see and it only exists when the
 * sources are served together. Copying that one projection into each cassette
 * would put four identical files in front of a reviewer and make adding a
 * fifth cassette look like four unrelated changes.
 */
export const COMBINED_API_EXPECTATION = join(CASSETTE_DIRECTORY, 'expected', 'api.json')

export function readCombinedApiExpectation(): unknown {
  try {
    return JSON.parse(readFileSync(COMBINED_API_EXPECTATION, 'utf8'))
  } catch (error) {
    throw new Error(
      'No blessed test/cassettes/expected/api.json. Run `pnpm cassette:bless:api`.',
      { cause: error },
    )
  }
}

export function allCassettes(): readonly Cassette[] {
  return cassetteIds().map(loadCassette)
}

/**
 * Materialize several cassettes into one shared root.
 *
 * Each cassette writes into its own native subdirectory — a Claude project
 * slug, a Codex day directory, a workspace-storage id — so several coexist
 * naturally and a server reading the result sees *multiple projects*, which is
 * closer to what a real user sees than any single-session fixture.
 */
export async function materializeAll(
  cassettes: readonly Cassette[],
  options: MaterializeOptions = {},
): Promise<CassetteRoots & AsyncDisposable> {
  const target = mkdtempSync(join(tmpdir(), 'lcc-cassettes-'))
  mkdirSync(join(target, 'files'), { recursive: true })

  const mtimes = cassettes.map(cassette => mtimesOf(cassette.manifest))
  const offset = options.anchor === 'now'
    ? nowOffsetSeconds(mtimes.flatMap(entries => [...entries.values()]))
    : 0

  for (const [index, cassette] of cassettes.entries()) {
    writeTree(join(target, 'files'), cassette.files, mtimes[index]!, offset)
  }

  return disposableRoots(rootsFor(target))
}
