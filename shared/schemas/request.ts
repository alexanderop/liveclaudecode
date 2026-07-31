import { Effect, Option, Result, Schema, SchemaGetter, SchemaIssue, SchemaTransformation } from 'effect'

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

/**
 * Coerces the configured hours value (an env-style setting, not user input)
 * to a non-negative finite number with `SchemaGetter.Number()`, falling back
 * to a week whenever that coercion is not a safe range.
 */
const coerceToNumber = new SchemaTransformation.Transformation(
  SchemaGetter.Number<unknown>(),
  SchemaGetter.passthrough<unknown, number>({ strict: false }),
)
const clampConfiguredHours = SchemaTransformation.transform({
  decode: (parsed: number) => Number.isFinite(parsed) && parsed >= 0 ? parsed : 168,
  encode: (value: number) => value,
})

const ConfiguredHoursSchema = Schema.Unknown.pipe(
  Schema.decodeTo(Schema.Number, coerceToNumber.compose(clampConfiguredHours)),
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

const decodeSessionQuery = Schema.decodeUnknownSync(SessionQuerySchema)
const decodeCursorQuery = Schema.decodeUnknownSync(CursorQuerySchema)
const decodeActivityQuery = Schema.decodeUnknownSync(ActivityQuerySchema)
const decodeConfiguredHours = Schema.decodeUnknownSync(ConfiguredHoursSchema)
const decodeRequestedHours = Schema.decodeUnknownResult(RequestedHoursSchema)

export const parseSessionQuery = (input: unknown) => decodeSessionQuery(input)
export const parseCursorQuery = (input: unknown) => decodeCursorQuery(input)
export const parseActivityQuery = (input: unknown) => decodeActivityQuery(input)

export function parseHours(configuredValue: unknown, requestedValue: unknown): number {
  const fallback = decodeConfiguredHours(configuredValue)
  return Result.getOrElse(decodeRequestedHours(requestedValue), () => fallback)
}
