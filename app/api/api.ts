import { Context, Effect, Layer, Option, Schema } from 'effect'
import type { HttpClientError } from 'effect/unstable/http'
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http'
import {
  ChatActionResponseSchema,
  type ChatActionResponseWire,
  ChatEventsResponseSchema,
  type ChatEventsResponseWire,
  CostOverviewResponseSchema,
  type CostOverviewResponseWire,
  EventsResponseSchema,
  type EventsResponseWire,
  ParseHealthResponseSchema,
  type ParseHealthResponseWire,
  RunResponseSchema,
  type RunResponseWire,
  SessionEventsResponseSchema,
  type SessionEventsResponseWire,
  TreeResponseSchema,
  type TreeResponseWire,
} from '#shared/schemas/api'
import { ChatActionSchema } from '#shared/schemas/chat'
import type { ChatAction } from '#shared/types/chat'
import { ApiMalformed, ApiRefused, ApiRejected, ApiUnreachable, type ApiError } from './errors'

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
  failure: HttpClientError.HttpClientError | Schema.SchemaError | ApiRejected | ApiRefused,
): Effect.Effect<never, ApiError> =>
  // A rejection or a refusal is already classified — the route inspected the
  // status itself so the server's `statusMessage` would survive, and a refusal
  // never left the browser. Both pass straight through.
  failure._tag === 'ApiRejected' || failure._tag === 'ApiRefused'
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
 * Where a chat poll has read up to.
 *
 * No `hours`. `server/api/chat.get.ts` is the one GET handler that never calls
 * `browserOptionsFor`, and `CursorQuerySchema` has no such field
 * (`shared/schemas/request.ts:36-47`), so the `&hours=` the old transport
 * appended was decoded away on arrival. `POST /api/chat` does use it.
 */
export interface ChatCursorQuery {
  readonly project: string
  readonly key: string
  /** Index of the first event not yet seen. */
  readonly since: number
  /** Log revision the cursor belongs to; a mismatch makes the server reset. */
  readonly revision: number
}

/** One agent, in one range. */
export interface AgentQuery extends RangeQuery {
  readonly project: string
  readonly key: string
}

/** One agent's transcript, after a cursor. */
export interface EventsQuery extends AgentQuery {
  /** Index of the first event not yet seen. */
  readonly since: number
  /** Transcript revision the cursor belongs to; a mismatch makes the server reset. */
  readonly revision: number
}

/** Every agent of one session, merged, capped at `limit` events. */
export interface SessionEventsQuery extends AgentQuery {
  readonly limit: number
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
  readonly tree: (query: RangeQuery) => Effect.Effect<TreeResponseWire, ApiError>
  readonly run: (query: AgentQuery) => Effect.Effect<RunResponseWire, ApiError>
  readonly events: (query: EventsQuery) => Effect.Effect<EventsResponseWire, ApiError>
  readonly sessionEvents: (
    query: SessionEventsQuery,
  ) => Effect.Effect<SessionEventsResponseWire, ApiError>
  readonly costs: (query: RangeQuery) => Effect.Effect<CostOverviewResponseWire, ApiError>
  readonly parseHealth: (query: RangeQuery) => Effect.Effect<ParseHealthResponseWire, ApiError>
  readonly chatEvents: (query: ChatCursorQuery) => Effect.Effect<ChatEventsResponseWire, ApiError>
  readonly chatAction: (
    action: ChatAction,
    query: RangeQuery,
  ) => Effect.Effect<ChatActionResponseWire, ApiError>
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

      const tree = route('/api/tree', TreeResponseSchema)
      const run = route('/api/run', RunResponseSchema)
      const events = route('/api/events', EventsResponseSchema)
      const sessionEvents = route('/api/session-events', SessionEventsResponseSchema)
      const costs = route('/api/costs', CostOverviewResponseSchema)
      const parseHealth = route('/api/debug', ParseHealthResponseSchema)
      const chatEvents = route('/api/chat', ChatEventsResponseSchema)

      /**
       * The one POST the dashboard makes.
       *
       * The body is encoded through `ChatActionSchema` — the schema the server
       * parses it with — so the browser runs the same `isPattern(/\S/)` and
       * `isMaxLength(20_000)` checks the handler would. A payload that fails
       * them is refused here rather than sent to be answered 400, which is why
       * `ApiRefused` exists.
       */
      const encodeChatAction = Schema.encodeEffect(ChatActionSchema)
      const decodeChatAction = Schema.decodeUnknownEffect(ChatActionResponseSchema)
      const chatAction = Effect.fn('Api POST /api/chat')(
        function*(action: ChatAction, hours: number | undefined) {
          const body = yield* encodeChatAction(action).pipe(
            Effect.catch(error =>
              new ApiRefused({ url: '/api/chat', detail: error.message })),
          )
          const response = yield* client.execute(
            HttpClientRequest.post('/api/chat', { urlParams: { hours } }).pipe(
              HttpClientRequest.bodyJsonUnsafe(body),
            ),
          )
          const payload = yield* response.json
          if (response.status >= 400) {
            return yield* new ApiRejected({
              url: '/api/chat',
              status: response.status,
              detail: failureDetail(payload),
            })
          }
          return yield* decodeChatAction(payload)
        },
        Effect.catch(classify('/api/chat')),
      )

      return Api.of({
        // `HttpClientRequest`'s urlParams skip undefined values, so an omitted
        // `hours` produces '/api/tree' rather than '/api/tree?hours=undefined'.
        // That is the range handshake's first request, with no branch.
        tree: query => tree({ hours: query.hours }),
        run: query => run({ project: query.project, key: query.key, hours: query.hours }),
        events: query =>
          events({
            project: query.project,
            key: query.key,
            since: query.since,
            revision: query.revision,
            hours: query.hours,
          }),
        sessionEvents: query =>
          sessionEvents({
            project: query.project,
            key: query.key,
            limit: query.limit,
            hours: query.hours,
          }),
        costs: query => costs({ hours: query.hours }),
        parseHealth: query => parseHealth({ hours: query.hours }),
        chatEvents: query =>
          chatEvents({
            project: query.project,
            key: query.key,
            since: query.since,
            revision: query.revision,
          }),
        chatAction: (action, query) => chatAction(action, query.hours),
      })
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer))
}
