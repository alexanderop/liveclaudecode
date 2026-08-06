import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer, Ref } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import { afterAll, beforeAll } from 'vitest'
import { Api } from '~/api/api'
import { costOverviewResponse } from '../../fixtures/runs'

/**
 * Covers `Api.layer` itself — the part every other test replaces with a stub.
 *
 * `stubApi` swaps the whole service out, which is right for pages and atoms and
 * leaves the route builder untested: the status check, the h3 failure decoding,
 * the error classification, and the response schema all live below that seam.
 * The fake here is one layer lower, at `fetch`, so the real route runs.
 */
interface Fetched {
  readonly url: string
}

/**
 * The routes are relative, and Effect resolves them against `location`
 * (`repos/effect/packages/effect/src/unstable/http/Url.ts:60-70`). In a browser
 * that is free; this suite runs in node, where its absence is an `InvalidUrl`
 * request error rather than anything the dashboard could ever see.
 */
const origin = 'http://localhost:4321'
const location = { origin, pathname: '/' }
beforeAll(() => {
  Object.defineProperty(globalThis, 'location', { value: location, configurable: true })
})
afterAll(() => {
  Reflect.deleteProperty(globalThis, 'location')
})

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/** Runs the real `Api` against a scripted `fetch`, recording the URLs it built. */
const withFetch = Effect.fn('withFetch')(function*(
  respond: (url: string) => Response | Promise<Response>,
) {
  const requests = yield* Ref.make<ReadonlyArray<Fetched>>([])
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = String(input)
    await Effect.runPromise(Ref.update(requests, seen => [...seen, { url }]))
    return respond(url)
  }
  const layer = Api.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
  return { layer, requests: Ref.get(requests) }
})

describe('the costs route', () => {
  it.effect('decodes an overview the server really returns', () =>
    Effect.gen(function*() {
      const body = costOverviewResponse({ sessions: 3, hours: 24 })
      const { layer } = yield* withFetch(() => jsonResponse(body))

      const overview = yield* Effect.provide(
        Effect.flatMap(Api, api => api.costs({ hours: 24 })),
        layer,
      )

      assert.strictEqual(overview.sessions, 3)
      assert.strictEqual(overview.hours, 24)
    }))

  it.effect('sends hours=0 as a value, not as an omitted parameter', () =>
    Effect.gen(function*() {
      const { layer, requests } = yield* withFetch(() => jsonResponse(costOverviewResponse({})))

      yield* Effect.provide(Effect.flatMap(Api, api => api.costs({ hours: 0 })), layer)

      // "All time" is `hours=0`. Dropping it on a falsy check leaves the server
      // applying its configured default instead, silently and plausibly — this
      // is the one assertion that watches the URL the client actually built.
      const [request] = yield* requests
      assert.include(request?.url ?? '', 'hours=0')
    }))

  it.effect('omits hours entirely when the caller has no range', () =>
    Effect.gen(function*() {
      const { layer, requests } = yield* withFetch(() => jsonResponse(costOverviewResponse({})))

      yield* Effect.provide(Effect.flatMap(Api, api => api.costs({})), layer)

      const [request] = yield* requests
      assert.notInclude(request?.url ?? '', 'hours')
    }))

  it.effect('reports the failure the server described, not a generic one', () =>
    Effect.gen(function*() {
      const { layer } = yield* withFetch(() =>
        jsonResponse({ statusCode: 500, statusMessage: 'transcript scan failed' }, 500))

      const failure = yield* Effect.flip(
        Effect.provide(Effect.flatMap(Api, api => api.costs({ hours: 24 })), layer),
      )

      // The status is inspected before the body is decoded precisely so this
      // sentence survives; `filterStatusOk` would have replaced it.
      assert.strictEqual(failure._tag, 'ApiRejected')
      assert.strictEqual(failure.message, 'transcript scan failed')
    }))

  it.effect('calls a 2xx body it cannot read version skew, not a network fault', () =>
    Effect.gen(function*() {
      const { layer } = yield* withFetch(() => jsonResponse({ sessions: 'three' }))

      const failure = yield* Effect.flip(
        Effect.provide(Effect.flatMap(Api, api => api.costs({ hours: 24 })), layer),
      )

      assert.strictEqual(failure._tag, 'ApiMalformed')
      assert.include(failure.message, 'this build cannot read')
      assert.include(failure.remedy, 'Reload')
    }))

  it.effect('calls a dead socket unreachable, which is the recoverable one', () =>
    Effect.gen(function*() {
      const { layer } = yield* withFetch(() => Promise.reject(new Error('connect ECONNREFUSED')))

      const failure = yield* Effect.flip(
        Effect.provide(Effect.flatMap(Api, api => api.costs({ hours: 24 })), layer),
      )

      assert.strictEqual(failure._tag, 'ApiUnreachable')
      assert.include(failure.remedy, 'still running')
    }))
})
