import { Context, Effect, Layer, Option, Schema } from 'effect'
import type { HttpClientError } from 'effect/unstable/http'
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http'
import {
  CostOverviewResponseSchema,
  type CostOverviewResponseWire,
} from '#shared/schemas/api'
import { ApiMalformed, ApiRejected, ApiUnreachable, type ApiError } from './errors'

/** What h3's `createError` serialises — the only structure a failure has. */
const ServerFailureSchema = Schema.Struct({
  statusCode: Schema.Number,
  statusMessage: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
})
const decodeServerFailure = Schema.decodeUnknownOption(ServerFailureSchema)

const failureDetail = (body: unknown): string =>
  Option.match(decodeServerFailure(body), {
    onSome: failure => failure.statusMessage || failure.message || '',
    onNone: () => '',
  })

/**
 * Splits a transport fault into the two the dashboard treats differently: a
 * body we could not read is version skew, everything else is unreachable.
 *
 * Interruption never arrives here — `Effect.catch` sees only typed failures, and
 * a superseded poll does not even produce one.
 */
const classify = (url: string) =>
(
  failure: HttpClientError.HttpClientError | Schema.SchemaError | ApiRejected,
): Effect.Effect<never, ApiError> =>
  // A rejection is already classified — the route inspected the status itself so
  // the server's `statusMessage` would survive. It passes straight through.
  failure._tag === 'ApiRejected'
    ? Effect.fail(failure)
    : Schema.isSchemaError(failure)
      ? Effect.fail(new ApiMalformed({ url, detail: failure.message }))
      : failure.reason._tag === 'DecodeError' || failure.reason._tag === 'EmptyBodyError'
        ? Effect.fail(new ApiMalformed({ url, detail: failure.message }))
        : Effect.fail(new ApiUnreachable({ url, detail: failure.message }))

export interface RangeQuery {
  /** Hours of history. Omitted lets the server apply its configured default. */
  readonly hours?: number | undefined
}

/**
 * The dashboard's own `/api/**`, as a service.
 *
 * `AtomHttpApi` is deliberately not used: it turns every `HttpClientError` and
 * `SchemaError` into a *defect*, and "the local dev server isn't running" is
 * this dashboard's most common failure — it has to be a typed failure the UI
 * renders as an offline banner.
 *
 * `$fetch` is not used either, because it forces manual `AbortController`
 * threading. `HttpClient` aborts the underlying `fetch` when its fiber is
 * interrupted, which is what lets an atom node's finalizer cancel an in-flight
 * request with no bookkeeping.
 */
export class Api extends Context.Service<Api, {
  readonly costs: (query: RangeQuery) => Effect.Effect<CostOverviewResponseWire, ApiError>
}>()('lcc/Api') {
  static readonly layer: Layer.Layer<Api> = Layer.effect(
    Api,
    Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient

      /**
       * One GET route. The decoder is built once per route, not per call —
       * these poll every two to six seconds.
       *
       * The status is inspected before the body is decoded so the server's
       * `statusMessage` survives; `HttpClient.filterStatusOk` would discard it.
       */
      // `ConstraintDecoder<unknown, never>` rather than `Codec<any, any>`: a
      // route only ever decodes, and pinning `DecodingServices` to `never` is
      // what keeps a schema that needs services out of a layer that has none.
      const route = <S extends Schema.ConstraintDecoder<unknown, never>>(
        path: string,
        schema: S,
      ) => {
        const decode = Schema.decodeUnknownEffect(schema)
        return Effect.fn(`Api ${path}`)(
          function*(urlParams: Record<string, string | number | undefined>) {
            const response = yield* client.execute(HttpClientRequest.get(path, { urlParams }))
            const body = yield* response.json
            if (response.status >= 400) {
              return yield* new ApiRejected({
                url: path,
                status: response.status,
                detail: failureDetail(body),
              })
            }
            return yield* decode(body)
          },
          Effect.catch(classify(path)),
        )
      }

      const costs = route('/api/costs', CostOverviewResponseSchema)

      return Api.of({
        // `HttpClientRequest`'s urlParams skip undefined values, so an omitted
        // `hours` produces '/api/costs' rather than '/api/costs?hours=undefined'.
        costs: query => costs({ hours: query.hours }),
      })
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer))
}
