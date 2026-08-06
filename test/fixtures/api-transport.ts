import { Effect, Layer, Ref } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import { afterAll, beforeAll } from 'vitest'
import { Api } from '~/api/api'

/**
 * The seam one layer below `stubApi`.
 *
 * Swapping the whole `Api` service is right for pages and atoms and leaves the
 * route builder untested: the status check, the h3 failure decoding, the error
 * classification, the request body encoding, and the response schema all live
 * beneath it. Faking `fetch` instead runs the real routes.
 */
export interface Fetched {
  readonly url: string
  readonly method: string
  readonly body: string | null
}

/**
 * Makes the app's relative routes resolvable.
 *
 * Effect resolves them against `location`
 * (`repos/effect/packages/effect/src/unstable/http/Url.ts:60-70`). In a browser
 * that is free; these suites run in node, where its absence is an `InvalidUrl`
 * request error rather than anything the dashboard could ever see. Call once at
 * the top of a spec file.
 */
export const useApiOrigin = (origin = 'http://localhost:4321'): void => {
  beforeAll(() => {
    Object.defineProperty(globalThis, 'location', {
      value: { origin, pathname: '/' },
      configurable: true,
    })
  })
  afterAll(() => {
    Reflect.deleteProperty(globalThis, 'location')
  })
}

/**
 * What was actually sent, as text.
 *
 * `HttpBody.jsonUnsafe` hands `fetch` an encoded `Uint8Array`, not the string it
 * was built from, so reading `init.body` directly would silently record `null`
 * for every request that has one.
 */
const bodyText = async (body: BodyInit | null | undefined): Promise<string | null> => {
  if (body == null) return null
  if (typeof body === 'string') return body
  return new Response(body).text()
}

export const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/** Runs the real `Api` against a scripted `fetch`, recording what it sent. */
export const withFetch = Effect.fn('withFetch')(function*(
  respond: (request: Fetched) => Response | Promise<Response>,
) {
  const requests = yield* Ref.make<ReadonlyArray<Fetched>>([])
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const sent: Fetched = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: await bodyText(init?.body),
    }
    await Effect.runPromise(Ref.update(requests, seen => [...seen, sent]))
    return respond(sent)
  }
  const layer = Api.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))
  return { layer, requests: Ref.get(requests) }
})

/** Runs one `Api` call against `layer`, with nothing else in scope. */
export const call = <A, E>(
  layer: Layer.Layer<Api>,
  use: (api: Api['Service']) => Effect.Effect<A, E>,
): Effect.Effect<A, E> => Effect.provide(Effect.flatMap(Api, use), layer)
