import { Effect, Schema, SchemaTransformation } from 'effect'

const stringWithDefault = (fallback: string) => Schema.String.pipe(
  Schema.withDecodingDefault(Effect.succeed(fallback)),
  Schema.catchDecoding(() => Effect.succeedSome(fallback)),
)

const integerFromString = (
  fallback: number,
  minimum: number,
  maximum = Number.POSITIVE_INFINITY,
) => Schema.String.pipe(
  Schema.decodeTo(
    Schema.Number,
    SchemaTransformation.transform({
      decode: (value) => {
        const parsed = Number.parseInt(value, 10)
        return Number.isFinite(parsed)
          ? Math.min(maximum, Math.max(minimum, parsed))
          : fallback
      },
      encode: value => String(value),
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

const ConfiguredHoursSchema = Schema.Unknown.pipe(
  Schema.decodeTo(
    Schema.Number,
    SchemaTransformation.transform({
      decode: (value) => {
        const parsed = Number(value)
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : 168
      },
      encode: value => value,
    }),
  ),
)

const requestedHoursSchema = (fallback: number) => Schema.String.pipe(
  Schema.decodeTo(
    Schema.Number,
    SchemaTransformation.transform({
      decode: (value) => {
        if (!value.trim()) return fallback
        const parsed = Number(value)
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
      },
      encode: value => String(value),
    }),
  ),
  Schema.catchDecoding(() => Effect.succeedSome(fallback)),
)

const decodeSessionQuery = Schema.decodeUnknownSync(SessionQuerySchema)
const decodeCursorQuery = Schema.decodeUnknownSync(CursorQuerySchema)
const decodeActivityQuery = Schema.decodeUnknownSync(ActivityQuerySchema)
const decodeConfiguredHours = Schema.decodeUnknownSync(ConfiguredHoursSchema)

export const parseSessionQuery = (input: unknown) => decodeSessionQuery(input)
export const parseCursorQuery = (input: unknown) => decodeCursorQuery(input)
export const parseActivityQuery = (input: unknown) => decodeActivityQuery(input)

export function parseHours(configuredValue: unknown, requestedValue: unknown): number {
  const fallback = decodeConfiguredHours(configuredValue)
  return Schema.decodeUnknownSync(requestedHoursSchema(fallback))(requestedValue)
}
