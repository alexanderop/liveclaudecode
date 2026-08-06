import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { call, jsonResponse, useApiOrigin, withFetch } from '../../fixtures/api-transport'
import { costOverviewResponse } from '../../fixtures/runs'

/**
 * Covers `Api.layer` itself — the part every other test replaces with a stub.
 * See `test/fixtures/api-transport.ts` for why the fake sits at `fetch`.
 */
useApiOrigin()

describe('the costs route', () => {
  it.effect('decodes an overview the server really returns', () =>
    Effect.gen(function*() {
      const body = costOverviewResponse({ sessions: 3, hours: 24 })
      const { layer } = yield* withFetch(() => jsonResponse(body))

      const overview = yield* call(layer, api => api.costs({ hours: 24 }))

      assert.strictEqual(overview.sessions, 3)
      assert.strictEqual(overview.hours, 24)
    }))

  it.effect('sends hours=0 as a value, not as an omitted parameter', () =>
    Effect.gen(function*() {
      const { layer, requests } = yield* withFetch(() => jsonResponse(costOverviewResponse({})))

      yield* call(layer, api => api.costs({ hours: 0 }))

      // "All time" is `hours=0`. Dropping it on a falsy check leaves the server
      // applying its configured default instead, silently and plausibly — this
      // is the one assertion that watches the URL the client actually built.
      const [request] = yield* requests
      assert.include(request?.url ?? '', 'hours=0')
    }))

  it.effect('omits hours entirely when the caller has no range', () =>
    Effect.gen(function*() {
      const { layer, requests } = yield* withFetch(() => jsonResponse(costOverviewResponse({})))

      yield* call(layer, api => api.costs({}))

      const [request] = yield* requests
      assert.notInclude(request?.url ?? '', 'hours')
    }))

  it.effect('reports the failure the server described, not a generic one', () =>
    Effect.gen(function*() {
      const { layer } = yield* withFetch(() =>
        jsonResponse({ statusCode: 500, statusMessage: 'transcript scan failed' }, 500))

      const failure = yield* Effect.flip(call(layer, api => api.costs({ hours: 24 })))

      // The status is inspected before the body is decoded precisely so this
      // sentence survives; `filterStatusOk` would have replaced it.
      assert.strictEqual(failure._tag, 'ApiRejected')
      assert.strictEqual(failure.message, 'transcript scan failed')
    }))

  it.effect('calls a 2xx body it cannot read version skew, not a network fault', () =>
    Effect.gen(function*() {
      const { layer } = yield* withFetch(() => jsonResponse({ sessions: 'three' }))

      const failure = yield* Effect.flip(call(layer, api => api.costs({ hours: 24 })))

      assert.strictEqual(failure._tag, 'ApiMalformed')
      assert.include(failure.message, 'this build cannot read')
      assert.include(failure.remedy, 'Reload')
    }))

  it.effect('calls a dead socket unreachable, which is the recoverable one', () =>
    Effect.gen(function*() {
      const { layer } = yield* withFetch(() => Promise.reject(new Error('connect ECONNREFUSED')))

      const failure = yield* Effect.flip(call(layer, api => api.costs({ hours: 24 })))

      assert.strictEqual(failure._tag, 'ApiUnreachable')
      assert.include(failure.remedy, 'still running')
    }))
})
