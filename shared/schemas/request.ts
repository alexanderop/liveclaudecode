import { Effect, Option, Result, Schema, SchemaIssue, SchemaTransformation } from 'effect'

const stringWithDefault = (fallback: string) => Schema.String.pipe(
  Schema.withDecodingDefault(Effect.succeed(fallback)),
  Schema.catchDecoding(() => Effect.succeedSome(fallback)),
)

/**
 * Parses a leading run of digits the way `Number.parseInt` does (`"12items"`
 * → `12`, `"100px"` → `100`), then clamps into `[minimum, maximum]`. Decoding
 * genuinely fails for inputs with no leading number, so the trailing
 * `catchDecoding` is the single, reachable fallback path — unlike the total
 * ternary this replaces, where a `catchDecoding` could never fire.
 */
const integerFromString = (
  fallback: number,
  minimum: number,
  maximum = Number.POSITIVE_INFINITY,
) => Schema.String.pipe(
  Schema.decodeTo(
    Schema.Number,
    SchemaTransformation.transformOrFail({
      decode: (value) => {
        const parsed = Number.parseInt(value, 10)
        return Number.isFinite(parsed)
          ? Effect.succeed(Math.min(maximum, Math.max(minimum, parsed)))
          : Effect.fail(new SchemaIssue.InvalidValue(Option.some(value), { message: `not an integer: ${value}` }))
      },
      encode: value => Effect.succeed(String(value)),
    }),
  ),
  Schema.withDecodingDefault(Effect.succeed(String(fallback))),
  Schema.catchDecoding(() => Effect.succeedSome(fallback)),
)

const SessionQueryFields = {
  key: stringWithDefault(''),
  project: stringWithDefault(''),
}

export const SessionQuerySchema = Schema.Struct(SessionQueryFields)

export const CursorQuerySchema = Schema.Struct({
  ...SessionQueryFields,
  since: integerFromString(0, 0),
  revision: integerFromString(0, 0),
})

export const ActivityQuerySchema = Schema.Struct({
  ...SessionQueryFields,
  limit: integerFromString(800, 100, 2_000),
})

export type SessionQuery = typeof SessionQuerySchema.Type
export type CursorQuery = typeof CursorQuerySchema.Type
export type ActivityQuery = typeof ActivityQuerySchema.Type

/**
 * A request query string that failed to decode. Individual fields stay
 * lenient (each falls back to its default), so in practice this fires only
 * for a query that is not an object at all — but when it does fire, the
 * failure flows through the typed error channel and maps to a 400 in
 * `server/utils/runtime.ts` instead of escaping as a thrown decode error.
 */
export class InvalidRequestQuery extends Schema.TaggedErrorClass<InvalidRequestQuery>()(
  'InvalidRequestQuery',
  { reason: Schema.String },
) {
  override get message(): string {
    return `Invalid request query: ${this.reason}`
  }
}

/**
 * Coerces the configured hours value (an env-style setting, not user input)
 * to a non-negative finite number, falling back to a week whenever that
 * coercion is not a safe range.
 *
 * Numeric coercion is wrapped rather than applied directly because it is not
 * total: `Number(value)` raises for a `Symbol`, and for any object whose
 * `valueOf` throws. `parseHours` runs outside the request Effect, so a raise
 * here would escape the typed error mapping in `server/utils/runtime.ts`
 * entirely; as a decode failure it degrades to the fallback like any other
 * unusable setting.
 */
const clampConfiguredHours = SchemaTransformation.transformOrFail({
  decode: (value: unknown) => Effect.try({
    try: () => Number(value),
    catch: () => new SchemaIssue.InvalidValue(Option.some(value), {
      message: 'hours value cannot be coerced to a number',
    }),
  }).pipe(Effect.map(parsed => Number.isFinite(parsed) && parsed >= 0 ? parsed : 168)),
  encode: (value: number) => Effect.succeed(value as unknown),
})

const ConfiguredHoursSchema = Schema.Unknown.pipe(
  Schema.decodeTo(Schema.Number, clampConfiguredHours),
)

/**
 * The requested-hours query override. No fallback lives inside this schema —
 * `parseHours` applies the (dynamic, per-call) configured fallback with
 * `Result.getOrElse` so the schema itself stays a single static value reused
 * across calls instead of being rebuilt per request.
 */
const RequestedHoursSchema = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Number,
    SchemaTransformation.transformOrFail({
      decode: (value) => {
        const trimmed = value.trim()
        if (!trimmed) {
          return Effect.fail(new SchemaIssue.InvalidValue(Option.some(value), { message: 'empty hours value' }))
        }
        const parsed = Number(trimmed)
        return Number.isFinite(parsed) && parsed >= 0
          ? Effect.succeed(parsed)
          : Effect.fail(new SchemaIssue.InvalidValue(Option.some(value), { message: `invalid hours value: ${value}` }))
      },
      encode: value => Effect.succeed(String(value)),
    }),
  ),
)

const decodeSessionQuery = Schema.decodeUnknownResult(SessionQuerySchema)
const decodeCursorQuery = Schema.decodeUnknownResult(CursorQuerySchema)
const decodeActivityQuery = Schema.decodeUnknownResult(ActivityQuerySchema)
const decodeConfiguredHours = Schema.decodeUnknownResult(ConfiguredHoursSchema)
const decodeRequestedHours = Schema.decodeUnknownResult(RequestedHoursSchema)

/**
 * Wrap a query decoder so its failure is a typed `InvalidRequestQuery` inside
 * the request Effect, rather than a synchronous throw before the handler's
 * Effect ever runs (which would bypass the error mapping in runtime.ts).
 */
const queryParser = <T>(decode: (input: unknown) => Result.Result<T, Schema.SchemaError>) =>
  (input: unknown): Effect.Effect<T, InvalidRequestQuery> =>
    Result.match(decode(input), {
      onSuccess: value => Effect.succeed(value),
      onFailure: error => Effect.fail(new InvalidRequestQuery({ reason: error.message })),
    })

export const parseSessionQuery = queryParser(decodeSessionQuery)
export const parseCursorQuery = queryParser(decodeCursorQuery)
export const parseActivityQuery = queryParser(decodeActivityQuery)

/**
 * Neither decode throws, which is what lets `browserOptionsFor` call this in
 * the h3 handler before its Effect ever reaches `runRequest`.
 */
export function parseHours(configuredValue: unknown, requestedValue: unknown): number {
  const fallback = Result.getOrElse(decodeConfiguredHours(configuredValue), () => 168)
  return Result.getOrElse(decodeRequestedHours(requestedValue), () => fallback)
}
