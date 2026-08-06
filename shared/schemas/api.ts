import { Schema } from 'effect'
import type { CostOverviewResponse } from '#shared/types/run'

/**
 * Decoders for what `server/api/**` returns.
 *
 * `shared/types/run.ts` keeps the hand-written, *mutable* interfaces and stays
 * the server's construction type: `server/utils/runs.ts` and its siblings build
 * the run tree by calling `.push` and `.sort` on `RunNode.children` and on the
 * project `roots` arrays, and `Schema.Struct` keys are readonly while
 * `Schema.Array` produces `ReadonlyArray`. Re-exporting the derived types would
 * be a wall of errors across five server files.
 *
 * So the boundary is one-directional: the schemas here own decoding and export
 * their readonly `.Type` under a `*Wire` name, `app/**` migrates its
 * `import type` lines to those, and a drift guard per response asserts that the
 * mutable interface is still assignable to the wire type. Mutable is assignable
 * to readonly; the reverse is not, which is the point.
 */

export const SessionSourceSchema = Schema.Literals(['claude', 'codex', 'copilot'])

export type SessionSourceWire = typeof SessionSourceSchema.Type

export const SessionSourceStatusSchema = Schema.Struct({
  source: SessionSourceSchema,
  state: Schema.Literals(['ready', 'degraded', 'unavailable']),
  sessions: Schema.Number,
  malformed: Schema.Number,
  message: Schema.String,
})

export const UsageSchema = Schema.Struct({
  in: Schema.Number,
  out: Schema.Number,
  cr: Schema.Number,
  cw: Schema.Number,
})

export type UsageWire = typeof UsageSchema.Type

const CostOverviewDaySchema = Schema.Struct({
  date: Schema.String,
  estimatedUsd: Schema.Number,
  usage: UsageSchema,
})

export const CostOverviewGroupSchema = Schema.Struct({
  source: SessionSourceSchema,
  label: Schema.String,
  model: Schema.NullOr(Schema.String),
  sessions: Schema.Number,
  usage: UsageSchema,
  estimatedUsd: Schema.NullOr(Schema.Number),
  pricedRequests: Schema.Number,
  unpricedRequests: Schema.Number,
  days: Schema.Array(CostOverviewDaySchema),
})

export type CostOverviewGroupWire = typeof CostOverviewGroupSchema.Type

/**
 * `GET /api/costs`.
 *
 * `currency` and `estimated` are literal types on the server, not `string` and
 * `boolean`, and `now` is fractional epoch *seconds* (`nowMillis / 1_000`), not
 * milliseconds — so it stays a `Number` and is never decoded into a `Date`.
 */
export const CostOverviewResponseSchema = Schema.Struct({
  now: Schema.Number,
  hours: Schema.Number,
  currency: Schema.Literal('USD'),
  estimated: Schema.Literal(true),
  estimatedUsd: Schema.Number,
  pricedRequests: Schema.Number,
  unpricedRequests: Schema.Number,
  sessions: Schema.Number,
  usage: UsageSchema,
  harnesses: Schema.Array(CostOverviewGroupSchema),
  models: Schema.Array(CostOverviewGroupSchema),
  sources: Schema.Array(SessionSourceStatusSchema),
})

export type CostOverviewResponseWire = typeof CostOverviewResponseSchema.Type

/**
 * Drift guard. The server constructs the mutable interface; the wire type must
 * accept it. Deliberately one-directional — a decoded value is readonly and is
 * NOT assignable back to the mutable interface, which is the whole point.
 */
const _costsWireAcceptsServerShape: CostOverviewResponseWire =
  undefined as unknown as CostOverviewResponse
void _costsWireAcceptsServerShape
