import { Cause, Effect, Exit, Layer, ManagedRuntime, Result } from 'effect'
import type * as PlatformError from 'effect/PlatformError'
import { NodeServices } from '@effect/platform-node'
import { createError, type H3Event } from 'h3'
import type { InvalidRequestQuery } from '#shared/schemas/request'
import {
  CodexScanCache,
  CopilotScanCache,
  type InvalidRunKey,
  type NoTranscriptsFound,
  PromptCache,
  ScanCache,
  type UnknownProject,
  type UnknownRun,
} from './services'
import { SessionCatalogCache, SessionLocatorCache } from './session-catalog'
import { type AcpAgentError, AcpConnector } from './acp-connection'
import type {
  ChatBusy,
  ChatCapacity,
  InvalidChatAction,
} from './chat'
import { ChatStore } from './chat-store'

/** Everything the server needs, backed by the real filesystem. */
const ServerLayer = Layer.mergeAll(
  ScanCache.layer,
  CodexScanCache.layer,
  CopilotScanCache.layer,
  SessionLocatorCache.layer,
  PromptCache.layer,
  SessionCatalogCache.layer,
  AcpConnector.layer,
  ChatStore.layer,
).pipe(Layer.provideMerge(NodeServices.layer))

type AppServices = Layer.Success<typeof ServerLayer>

/**
 * One runtime for the whole server process, built from `ServerLayer`.
 *
 * Nitro route handlers cannot themselves be Effects, so this is the single
 * bridge between the h3 world and the Effect world. Domain code stays in
 * services; handlers only run an Effect and translate its typed failures.
 */
const runtime: ManagedRuntime.ManagedRuntime<AppServices, never> = ManagedRuntime.make(ServerLayer)

/** Release layer-scoped resources when Nitro shuts down. */
export function disposeRuntime(): Promise<void> {
  return runtime.dispose()
}

/**
 * Run an Effect that no request is waiting on, such as a startup warm-up.
 *
 * Nothing consumes the result, so a failure is logged rather than raised: work
 * the server merely wanted to get a head start on must never be the reason it
 * refuses to serve. `disposeRuntime` interrupts whatever is still in flight.
 */
export function runBackground(
  label: string,
  effect: Effect.Effect<unknown, AppError, AppServices>,
): void {
  void runtime.runPromise(Effect.catchCause(
    effect,
    cause => Effect.logWarning(`Background task failed: ${label}`, { cause }),
  ))
}

export type AppError =
  | NoTranscriptsFound
  | UnknownProject
  | UnknownRun
  | InvalidRunKey
  | InvalidRequestQuery
  | InvalidChatAction
  | ChatBusy
  | ChatCapacity
  | AcpAgentError
  | PlatformError.PlatformError

/**
 * Every failure a handler can produce has a status code. Filesystem faults are
 * genuine server errors, so they surface as 500 with their reason preserved
 * rather than disappearing into a generic message.
 *
 * The `default` branch is dead for every `AppError` known today; the `never`
 * assignment keeps it that way at compile time (adding a tag without a case
 * here fails to typecheck), while at runtime an unmapped error still becomes
 * a real 500 instead of an unhandled value escaping the handler.
 */
export function toHttpError(error: AppError): ReturnType<typeof createError> {
  switch (error._tag) {
    case 'InvalidRunKey':
    case 'InvalidRequestQuery':
    case 'InvalidChatAction':
      return createError({ statusCode: 400, statusMessage: error.message })
    case 'ChatBusy':
      return createError({ statusCode: 409, statusMessage: error.message })
    case 'ChatCapacity':
      return createError({ statusCode: 429, statusMessage: error.message })
    case 'UnknownProject':
    case 'NoTranscriptsFound':
    case 'UnknownRun':
      return createError({ statusCode: 404, statusMessage: error.message })
    case 'PlatformError':
      return createError({ statusCode: 500, statusMessage: `Filesystem error: ${error.reason._tag}` })
    case 'AcpAgentError':
      return createError({ statusCode: 502, statusMessage: error.message })
    default: {
      const _exhaustive: never = error
      return createError({ statusCode: 500, statusMessage: 'Internal Server Error' })
    }
  }
}

/**
 * Run an Effect for an HTTP handler, mapping typed failures onto status codes.
 *
 * `event`'s underlying request is wired to an `AbortSignal` so a client that
 * disconnects mid-poll interrupts the in-flight filesystem scan instead of
 * letting it run to completion for nobody. Typed failures are captured with
 * `Effect.result` and mapped to status codes; everything else surfaces in the
 * exit's `Cause`. Only a cause that is *interruption and nothing else* — the
 * signature of the disconnect-triggered interrupt — is reported as the benign
 * 499; a genuine defect is rethrown unchanged even when the client happens to
 * have disconnected while it fired, so real bugs are never masked as
 * cancellations.
 */
export async function runRequest<A>(
  event: H3Event,
  effect: Effect.Effect<A, AppError, AppServices>,
): Promise<A> {
  const controller = new AbortController()
  const onClientDisconnect = () => controller.abort()
  event.node.req.once('close', onClientDisconnect)
  try {
    const exit = await runtime.runPromiseExit(Effect.result(effect), { signal: controller.signal })
    if (Exit.isSuccess(exit)) {
      const result = exit.value
      if (Result.isSuccess(result)) return result.success
      throw toHttpError(result.failure)
    }
    if (controller.signal.aborted && Cause.hasInterruptsOnly(exit.cause)) {
      throw createError({ statusCode: 499, statusMessage: 'Client Closed Request' })
    }
    throw Cause.squash(exit.cause)
  } finally {
    event.node.req.removeListener('close', onClientDisconnect)
  }
}
