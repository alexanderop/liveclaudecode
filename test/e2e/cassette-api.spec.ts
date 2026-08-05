import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, assert, beforeAll, describe, expect, it, vi } from 'vitest'
import { setup } from '@nuxt/test-utils/e2e'
import { $fetch } from '../fixtures/api-client'
import type {
  CostOverviewResponse,
  ParseHealthResponse,
  RunResponse,
  TreeResponse,
} from '#shared/types/run'
import {
  allCassettes,
  type CassetteRoots,
  COMBINED_API_EXPECTATION,
  materializeAll,
  readCombinedApiExpectation,
} from '../fixtures/cassette'
import { blessedJson } from '../fixtures/cassette-projection'
import { SOURCES } from '../../script/cassette/sources.ts'
import { CASSETTE_SOURCES } from '../cassettes/redaction/rules'

/**
 * Level 3 — catalog and API replay.
 *
 * L1 and L2 skip the parts of the product that turn files into a dashboard:
 * the discovery walks, the cross-source aggregation, and the HTTP contract.
 * This tier materializes cassettes onto a real directory, points a real Nitro
 * server at them, and asserts a normalized projection of what it serves.
 *
 * Two determinism rules make that possible.
 *
 * First, freshness. Committed `mtime`s are anchored to each cassette's
 * `clockAnchor`, so a cassette recorded in August looks stale in December and
 * drops out of the default `LCC_HOURS` window. Materializing with
 * `anchor: 'now'` re-bases every mtime against the current instant while
 * preserving the intervals between them, so ordering and relative freshness
 * survive.
 *
 * Second, rendered time. `statsNow` reads the *server's* clock, which no test
 * layer can reach through HTTP, so `ago`, `live`, and every delta derived from
 * them land in whatever bucket the run happens to fall in. The projection below
 * therefore omits all of them. The rule, stated once: anything derived from
 * "now" is an L2 assertion, never an L3 one.
 */

const cassettes = allCassettes().filter(cassette => cassette.manifest.e2e)

/**
 * `pnpm cassette:bless:api` writes what this tier computes instead of asserting
 * it. Blessing is never automatic and never runs in CI; the projection is
 * produced here rather than by `script/cassette/bless.ts` because computing it
 * requires exactly the running server this tier already stands up.
 */
const blessing = process.env.CASSETTE_BLESS_API === '1'

let roots: CassetteRoots & AsyncDisposable

/** A normalized, wall-clock-free view of one root run. */
interface RunProjection {
  key: string
  source: string
  kind: string
  label: string
  files: ReadonlyArray<readonly [string, number]>
  /** The timeline hierarchy: `/api/run` returns `PublicRunNode`, which omits children. */
  lanes: ReadonlyArray<{ key: string, depth: number, kind: string, agentType: string }>
  usage: unknown
  incidents: readonly string[]
  turns: number
  environmentCwd: string
}

/** A normalized view of `/api/tree`, `/api/costs`, and `/api/debug` together. */
interface ApiProjection {
  projects: ReadonlyArray<{ name: string, roots: readonly string[] }>
  sources: ReadonlyArray<{ source: string, state: string, sessions: number, malformed: number }>
  costs: { sessions: number, pricedRequests: number, unpricedRequests: number }
  parseHealth: { skipped: number, sessions: ReadonlyArray<{ source: string, skipped: number }> }
  runs: readonly RunProjection[]
}

function projectRun(response: RunResponse): RunProjection {
  return {
    key: response.root.key,
    source: response.root.source,
    kind: response.node.kind,
    label: response.node.label,
    files: response.files,
    // Sorted: lane order is mtime-derived, and `anchor: 'now'` preserves
    // intervals but not the exact instants a sort might tie on.
    lanes: response.lanes
      .map(lane => ({
        key: lane.key,
        depth: lane.depth,
        kind: lane.kind,
        agentType: lane.agentType,
      }))
      .sort((left, right) => left.key.localeCompare(right.key)),
    usage: response.diagnostics.usage,
    incidents: response.diagnostics.incidents.map(incident =>
      `${incident.category}/${incident.severity}`,
    ).sort(),
    turns: response.diagnostics.turns.length,
    environmentCwd: response.diagnostics.environment.cwd,
  }
}

describe('cassette API replay', async () => {
  // `setup()` reads the environment when the server starts, so the roots have
  // to exist before it runs — hence the materialize outside `beforeAll`.
  roots = await materializeAll(cassettes, { anchor: 'now' })

  // Driven from the descriptors, so a source whose override variable changes —
  // or a fifth source — cannot leave this tier silently pointed at the
  // operator's real transcripts instead of the cassettes.
  for (const source of CASSETTE_SOURCES) {
    vi.stubEnv(SOURCES[source].envVar, roots.bySource[source])
  }
  // Wide enough that `anchor: 'now'` is what decides freshness, not the window.
  vi.stubEnv('LCC_HOURS', '99999')

  await setup({
    rootDir: fileURLToPath(new URL('../..', import.meta.url)),
    server: true,
  })

  beforeAll(() => {
    assert.ok(
      cassettes.length > 0,
      'No cassette is marked "e2e": true, so this tier asserts nothing. '
      + 'See docs/cassette-scenarios.md.',
    )
  })

  afterAll(async () => {
    vi.unstubAllEnvs()
    await roots[Symbol.asyncDispose]()
  })

  it('serves every recorded session through the read-only API', async () => {
    const tree = await $fetch<TreeResponse>('/api/tree')
    const costs = await $fetch<CostOverviewResponse>('/api/costs')
    const debug = await $fetch<ParseHealthResponse>('/api/debug')

    const rootKeys = tree.projects.flatMap(project => project.roots.map(root => root.key)).sort()
    const runs: RunProjection[] = []
    for (const key of rootKeys) {
      runs.push(projectRun(await $fetch<RunResponse>(`/api/run?key=${encodeURIComponent(key)}`)))
    }

    const projection: ApiProjection = {
      projects: tree.projects
        .map(project => ({
          name: project.name,
          // Root key plus its children: the subagent fan-out is a property of
          // the tree, and it is the one thing L1 and L2 cannot see at all.
          roots: project.roots
            .map(root => `${root.key}[${root.children.map(child => child.key).sort().join(',')}]`)
            .sort(),
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      sources: tree.sources
        .map(source => ({
          source: source.source,
          state: source.state,
          sessions: source.sessions,
          malformed: source.malformed,
        }))
        .sort((left, right) => left.source.localeCompare(right.source)),
      costs: {
        sessions: costs.sessions,
        pricedRequests: costs.pricedRequests,
        unpricedRequests: costs.unpricedRequests,
      },
      parseHealth: {
        skipped: debug.skipped,
        sessions: debug.sessions
          .map(session => ({ source: session.source, skipped: session.skipped }))
          .sort((left, right) => left.source.localeCompare(right.source)),
      },
      runs,
    }

    if (blessing) {
      mkdirSync(dirname(COMBINED_API_EXPECTATION), { recursive: true })
      writeFileSync(COMBINED_API_EXPECTATION, blessedJson(projection))
      return
    }

    expect(projection).toEqual(readCombinedApiExpectation())
  })

  it('agrees with the L1 parse census', async () => {
    // The same records, counted by two independent paths: the parsers directly
    // in L1, and the running scanners here. A disagreement means the scanners
    // skip records the parsers accept, or the reverse.
    const debug = await $fetch<ParseHealthResponse>('/api/debug')
    const expectedIssues = cassettes.reduce(
      (total, cassette) => total + cassette.manifest.expectedParseIssues.length,
      0,
    )

    assert.strictEqual(
      debug.skipped,
      expectedIssues,
      'The server skipped a different number of records than the cassettes declare. '
      + 'Re-bless if this is intended; investigate if it is not.',
    )
  })

  it('does not write to the materialized transcripts', async () => {
    // The read-only contract, asserted against real files rather than a fake
    // filesystem that dies on mutation.
    const before = await import('node:fs').then(fs =>
      fs.readdirSync(roots.directory, { recursive: true }).map(String).sort(),
    )

    await $fetch('/api/tree')
    await $fetch('/api/costs')
    await $fetch('/api/debug')

    const after = await import('node:fs').then(fs =>
      fs.readdirSync(roots.directory, { recursive: true }).map(String).sort(),
    )
    assert.deepStrictEqual(after, before)
  })
})
