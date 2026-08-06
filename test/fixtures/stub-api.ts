import { Effect, Layer } from 'effect'
import type {
  ChatActionResponseWire,
  ChatEventsResponseWire,
  CostOverviewResponseWire,
  TreeResponseWire,
} from '#shared/schemas/api'
import type { ChatAction } from '#shared/types/chat'
import type { TreeResponse } from '#shared/types/run'
import type { ChatCursorQuery, RangeQuery } from '~/api/api'
import { Api } from '~/api/api'
import type { ApiError } from '~/api/errors'
import { makeCallLog, type CallLog } from './call-log'

/**
 * One stubbed endpoint.
 *
 * A handler returns an `Effect` rather than a bare payload so a test can drive
 * the offline path — `Effect.fail(new ApiUnreachable(…))` is the whole of it —
 * and so a later stage can hand back a `Deferred` for a race without changing
 * this type. The success and failure channels are exactly the ones the real
 * method has, so a stub that typechecks is a stub the page could really see.
 */
export type StubHandler<Query, A> = (query: Query) => Effect.Effect<A, ApiError>

/**
 * The endpoints a test scripts.
 *
 * One entry per migrated route, added as the migration reaches it. Anything
 * omitted is *not* implemented — see {@link stubApi}.
 */
export interface StubApiHandlers {
  /** `GET /api/tree`. */
  readonly tree?: StubHandler<RangeQuery, TreeResponseWire>
  /** `GET /api/costs`. */
  readonly costs?: StubHandler<RangeQuery, CostOverviewResponseWire>
  /** `GET /api/chat`. */
  readonly chatEvents?: StubHandler<ChatCursorQuery, ChatEventsResponseWire>
  /** `POST /api/chat`. Both arguments are recorded. */
  readonly chatAction?: (
    action: ChatAction,
    query: RangeQuery,
  ) => Effect.Effect<ChatActionResponseWire, ApiError>
}

/**
 * The one handler nearly every mounted spec needs.
 *
 * The run tree is the dashboard's heartbeat: a page that cannot read it renders
 * its offline state and nothing else, so a spec about anything downstream has to
 * serve it. The builders produce the server's mutable shape, which is assignable
 * to the decoded wire type — that direction is the whole point of the boundary.
 */
export const servingTree = (
  response: TreeResponse | (() => TreeResponse),
): StubApiHandlers => ({
  tree: () => Effect.succeed(typeof response === 'function' ? response() : response),
})

/** One recorded `POST /api/chat`. */
export interface StubChatAction {
  readonly action: ChatAction
  readonly query: RangeQuery
}

/** What each stubbed endpoint was called with, oldest call first. */
export interface StubApiCalls {
  readonly tree: CallLog<RangeQuery>
  readonly costs: CallLog<RangeQuery>
  readonly chatEvents: CallLog<ChatCursorQuery>
  readonly chatAction: CallLog<StubChatAction>
}

export interface StubApi {
  /**
   * A layer value built fresh for this stub.
   *
   * `Layer.MemoMap` is keyed by layer *reference identity*, so two registries
   * handed the same layer object share one build — and therefore one call log.
   * Never hoist this to module scope.
   */
  readonly layer: Layer.Layer<Api>
  readonly calls: StubApiCalls
}

/** Records the call, then answers with the test's handler. */
const recording = <Query, A>(log: CallLog<Query>, handler: StubHandler<Query, A>) =>
  Effect.fn('stubApi')(function*(query: Query) {
    yield* log.record(query)
    return yield* handler(query)
  })

/**
 * A stub `Api` for one registry.
 *
 * `Layer.mock` turns an endpoint the test did not script into a named defect —
 * `lcc/Api: Unimplemented method "costs"` — instead of a plausible default that
 * lets a wrong request pass silently. That is the property `mockLiveApi` gets
 * from its `Unexpected URL` throw, moved to the service boundary.
 *
 * Observation goes through `makeCallLog`, whose `Ref` is created here rather
 * than in module scope, so nothing leaks between cases and `it.only` behaves
 * exactly like a full run.
 */
export const stubApi = (handlers: StubApiHandlers = {}): StubApi => {
  const calls: StubApiCalls = {
    tree: Effect.runSync(makeCallLog<RangeQuery>()),
    costs: Effect.runSync(makeCallLog<RangeQuery>()),
    chatEvents: Effect.runSync(makeCallLog<ChatCursorQuery>()),
    chatAction: Effect.runSync(makeCallLog<StubChatAction>()),
  }
  const { chatAction } = handlers
  return {
    calls,
    layer: Layer.mock(Api, {
      ...(handlers.tree && { tree: recording(calls.tree, handlers.tree) }),
      ...(handlers.costs && { costs: recording(calls.costs, handlers.costs) }),
      ...(handlers.chatEvents && { chatEvents: recording(calls.chatEvents, handlers.chatEvents) }),
      ...(chatAction && {
        chatAction: Effect.fn('stubApi')(function*(action: ChatAction, query: RangeQuery) {
          yield* calls.chatAction.record({ action, query })
          return yield* chatAction(action, query)
        }),
      }),
    }),
  }
}

/**
 * A synchronous view of a call log, for mounted specs whose assertions cannot
 * `yield*`. Unit tests read `log.all` in their `it.effect` instead.
 */
export const recordedCalls = <A>(log: CallLog<A>): ReadonlyArray<A> => Effect.runSync(log.all)
