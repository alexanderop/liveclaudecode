import { Effect, Layer, ManagedRuntime, Result } from 'effect'
import type * as PlatformError from 'effect/PlatformError'
import { NodeServices } from '@effect/platform-node'
import { createError, type H3Event } from 'h3'
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
import { AcpAgentError, AcpConnector } from './acp-connection'
import {
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

export type AppError =
  | NoTranscriptsFound
  | UnknownProject
  | UnknownRun
  | InvalidRunKey
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
 * The `default` branch is dead for every `AppError` known today; it exists so
 * that adding a tag without a case here fails to typecheck instead of falling
 * through silently at runtime.
 */
function toHttpError(error: AppError): ReturnType<typeof createError> {
  switch (error._tag) {
    case 'InvalidRunKey':
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
    default:
      return error satisfies never
  }
}

/**
 * Run an Effect for an HTTP handler, mapping typed failures onto status codes.
 *
 * `event`'s underlying request is wired to an `AbortSignal` so a client that
 * disconnects mid-poll interrupts the in-flight filesystem scan instead of
 * letting it run to completion for nobody. An interruption triggered by that
 * disconnect surfaces as a rejected `runPromise`, not as a typed `AppError`;
 * that path is swallowed rather than rethrown, since a request nobody is
 * waiting on isn't worth logging as a server error. Any other rejection (a
 * genuine defect) is rethrown unchanged, keeping the contract for live
 * requests exactly as it was.
 */
export async function runRequest<A>(
  event: H3Event,
  effect: Effect.Effect<A, AppError, AppServices>,
): Promise<A> {
  const controller = new AbortController()
  const onClientDisconnect = () => controller.abort()
  event.node.req.once('close', onClientDisconnect)
  try {
    const result = await runtime.runPromise(Effect.result(effect), { signal: controller.signal })
    if (Result.isSuccess(result)) return result.success
    throw toHttpError(result.failure)
  } catch (error) {
    if (controller.signal.aborted) {
      throw createError({ statusCode: 499, statusMessage: 'Client Closed Request' })
    }
    throw error
  } finally {
    event.node.req.removeListener('close', onClientDisconnect)
  }
}
