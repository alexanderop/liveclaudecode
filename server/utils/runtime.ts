import { Effect, type Layer, ManagedRuntime, Result } from 'effect'
import type * as PlatformError from 'effect/PlatformError'
import { createError } from 'h3'
import {
  AppLayer,
  type InvalidRunKey,
  type NoTranscriptsFound,
  type UnknownProject,
  type UnknownRun,
} from './services'

type AppServices = Layer.Success<typeof AppLayer>

/**
 * One runtime for the whole server process, built from `AppLayer`.
 *
 * Nitro route handlers cannot themselves be Effects, so this is the single
 * bridge between the h3 world and the Effect world. Domain code stays in
 * services; handlers only run an Effect and translate its typed failures.
 */
let runtime: ManagedRuntime.ManagedRuntime<AppServices, never> | undefined

function getRuntime() {
  runtime ??= ManagedRuntime.make(AppLayer)
  return runtime
}

export type AppError =
  | NoTranscriptsFound
  | UnknownProject
  | UnknownRun
  | InvalidRunKey
  | PlatformError.PlatformError

/**
 * Every failure a handler can produce has a status code. Filesystem faults are
 * genuine server errors, so they surface as 500 with their reason preserved
 * rather than disappearing into a generic message.
 */
function toHttpError(error: AppError) {
  switch (error._tag) {
    case 'InvalidRunKey':
      return createError({ statusCode: 400, statusMessage: error.message })
    case 'UnknownProject':
    case 'NoTranscriptsFound':
    case 'UnknownRun':
      return createError({ statusCode: 404, statusMessage: error.message })
    case 'PlatformError':
      return createError({ statusCode: 500, statusMessage: `Filesystem error: ${error.reason._tag}` })
  }
}

/** Run an Effect for an HTTP handler, mapping typed failures onto status codes. */
export async function runRequest<A>(
  effect: Effect.Effect<A, AppError, AppServices>,
): Promise<A> {
  const result = await getRuntime().runPromise(Effect.result(effect))
  if (Result.isSuccess(result)) return result.success
  throw toHttpError(result.failure)
}
