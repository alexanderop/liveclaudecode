import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'
import { allCassettes } from '../fixtures/cassette'
import { projectCassetteScan } from '../fixtures/cassette-projection'

/**
 * Level 2 — the scanner golden.
 *
 * Each cassette is run through the scanner its source uses in production and
 * projected into a canonical document, which is compared against a committed
 * `expected/scan.json`.
 *
 * Deliberately not `toMatchSnapshot()`. A committed JSON file is reviewable in
 * a pull-request diff, survives a test-runner change, and makes blessing an
 * explicit command rather than a side effect of passing `-u` to a failing run.
 *
 * `TestClock` is pinned to the cassette's `clockAnchor` even though the
 * projection passes that instant to `statsAt` explicitly. The redundancy is the
 * point: `statsNow` is the only clock read in the scan path *today*, and a
 * future one must fail loudly here rather than start producing a golden that
 * quietly depends on when the suite ran.
 */

const cassettes = allCassettes()

describe('cassette scan goldens', () => {
  for (const cassette of cassettes) {
    it.effect(`${cassette.id} projects to its blessed scan`, () =>
      Effect.gen(function*() {
        yield* TestClock.setTime(cassette.clockAnchor)
        const projection = yield* projectCassetteScan(cassette)

        assert.deepStrictEqual(
          JSON.parse(JSON.stringify(projection)),
          cassette.expected('scan'),
          `${cassette.id} no longer scans to its blessed projection. If the change is `
          + 'intended, run `pnpm cassette:bless` and explain the diff in the pull request — '
          + 'that diff is the point of this test.',
        )
      }).pipe(Effect.provide(cassette.layer)))

    it.effect(`${cassette.id} reports no wall-clock dependence`, () =>
      Effect.gen(function*() {
        // Run the same cassette at two very different instants. Everything the
        // projection carries is either derived from the cassette or derived
        // from the anchor it was blessed at, so the two must agree exactly.
        yield* TestClock.setTime(cassette.clockAnchor)
        const first = yield* projectCassetteScan(cassette)
        yield* TestClock.setTime(cassette.clockAnchor + 90 * 24 * 3_600_000)
        const second = yield* projectCassetteScan(cassette)

        assert.deepStrictEqual(second, first)
      }).pipe(Effect.provide(cassette.layer)))
  }
})
