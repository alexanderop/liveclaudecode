import { Result, Schema } from 'effect'

/**
 * A non-negative integer, for count-shaped fields (token counts, request
 * counts) that can never be negative or fractional. Transcript fixtures for
 * every consumer of this schema decode cleanly under it; if a real-world
 * transcript is ever observed with a fractional count, relax the affected
 * field back to `Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))`
 * instead of widening this shared schema.
 */
export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * Builds a `(value: unknown) => T | null` parser from a schema.
 *
 * Every "best-effort" decode across the transcript schemas (Claude, Codex,
 * Copilot, Copilot CLI) collapses a decode failure to `null` so the caller
 * can skip a malformed record instead of handling a `Result`. This factory
 * replaces the repeated `Result.isSuccess(decode(value)) ? ... .success :
 * null` bodies with one implementation.
 */
export function parseOrNull<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  options?: Parameters<typeof Schema.decodeUnknownResult>[1],
): (value: unknown) => S['Type'] | null {
  const decode = Schema.decodeUnknownResult(schema, options)
  return value => Result.getOrNull(decode(value))
}
