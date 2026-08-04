import { assert, describe, it } from 'vitest'
import { declaredRoutes, exercisedRoutes } from '../fixtures/route-coverage'

/**
 * The route-coverage gate. It lives in its own Vitest project with a later
 * `sequence.groupOrder` so it runs only once every e2e spec has finished
 * recording into the ledger.
 */
describe('route coverage', () => {
  it('every server/api route has at least one e2e assertion', () => {
    const exercised = exercisedRoutes()
    assert.ok(
      exercised !== undefined,
      'the e2e tier did not run, so route coverage cannot be judged; run `pnpm test` rather than this project alone',
    )

    const missing = declaredRoutes().filter(route => !exercised.has(route))
    assert.deepStrictEqual(
      missing,
      [],
      `server/api routes with no e2e assertion: ${missing.join(', ')}. `
      + 'Exercise them through test/fixtures/api-client.ts so the gate sees the request.',
    )
  })

  it('records only routes that server/api actually declares', () => {
    const exercised = exercisedRoutes() ?? new Set<string>()
    const declared = new Set(declaredRoutes())
    const unknown = [...exercised].filter(route => !declared.has(route)).sort()

    assert.deepStrictEqual(
      unknown,
      [],
      `e2e specs requested /api routes with no handler file: ${unknown.join(', ')}`,
    )
  })
})
