import type { Feed } from '~/atoms/feed'
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import * as Cause from 'effect/Cause'

/**
 * What a polled resource looks like to a template: one string discriminant, no
 * `AsyncResult` refinement calls in template expressions.
 */
export type FeedView<A> =
  | { readonly tag: 'loading' }
  | { readonly tag: 'ready', readonly value: A }
  /** Data on screen, most recent refresh failed. The offline banner state. */
  | { readonly tag: 'stale', readonly value: A, readonly message: string, readonly remedy: string }
  | { readonly tag: 'error', readonly message: string, readonly remedy: string }

/**
 * What to tell the user when the stream itself died rather than a request.
 *
 * That is a defect — no `ApiError` reached the view — so there is no informed
 * advice to give beyond starting the page over.
 */
const DEFECT_REMEDY = 'Reload the page. If it happens again, check the server output.'

const causeMessage = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.findError(cause)
  if (error._tag === 'Success') {
    const failure: unknown = error.success
    return failure instanceof Error ? failure.message : String(failure)
  }
  return Cause.squash(cause) instanceof Error
    ? (Cause.squash(cause) as Error).message
    : String(Cause.squash(cause))
}

/**
 * Projects a polled atom's `AsyncResult` into a view model.
 *
 * Deliberately **not** written with `AsyncResult.matchWithWaiting`. That matcher
 * returns `onWaiting` whenever `result.waiting` is set, before it looks at the
 * tag (`AsyncResult.ts:648-651`), and a stream-backed atom sets
 * `waiting: true` on *every* emitted chunk and clears it only when the stream
 * ends (`Atom.ts:846-849`). `Stream.tick` never ends, so a `matchWithWaiting`
 * projection of a poll atom reports `loading` forever and the dashboard never
 * renders. Branching on the tag is the only correct read here.
 *
 * `AsyncResult.value` is likewise never used on its own: it returns the retained
 * `previousSuccess` on a `Failure` (`AsyncResult.ts:416-423`), so a naive render
 * shows stale data with no indication anything is wrong.
 */
export const toFeedView = <A, E>(
  result: AsyncResult.AsyncResult<Feed<A>, E>,
): FeedView<A> => {
  // An explicit cancellation is not a fault; it means a rebuild is under way.
  // Checked before the tag switch because an interrupt-only cause carries no
  // typed error and would otherwise be reported as a defect.
  //
  // Written inline rather than through `AsyncResult.isInterrupted`, whose type
  // predicate narrows `Failure` out of `result` for the rest of the function and
  // makes the `Failure` branch below unreachable to the compiler.
  if (result._tag === 'Failure' && Cause.hasInterruptsOnly(result.cause)) {
    return { tag: 'loading' }
  }

  switch (result._tag) {
    case 'Initial':
      return { tag: 'loading' }

    case 'Failure':
      // The feed loop folds transport failures into the emitted value, so a
      // Failure here is the stream itself dying — a defect, or the atom being
      // rebuilt. Either way there is nothing on screen to keep.
      return { tag: 'error', message: causeMessage(result.cause), remedy: DEFECT_REMEDY }

    case 'Success': {
      const feed = result.value
      if (feed.value === null) {
        return feed.error
          ? { tag: 'error', message: feed.error.message, remedy: feed.error.remedy }
          : { tag: 'loading' }
      }
      return feed.error
        ? {
            tag: 'stale',
            value: feed.value,
            message: feed.error.message,
            remedy: feed.error.remedy,
          }
        : { tag: 'ready', value: feed.value }
    }
  }
}

/**
 * The value a feed currently has, if any — for the many consumers that want
 * "the last projects list" and read `offline` separately.
 */
export const feedValue = <A, B, E>(
  result: AsyncResult.AsyncResult<Feed<A>, E>,
  project: (value: A) => B,
  fallback: B,
): B => {
  const feed = AsyncResult.isSuccess(result) ? result.value : null
  return feed?.value == null ? fallback : project(feed.value)
}

/** Whether the most recent poll of this feed failed. Drives the offline banner. */
export const feedIsOffline = <A, E>(
  result: AsyncResult.AsyncResult<Feed<A>, E>,
): boolean =>
  AsyncResult.isSuccess(result) ? result.value.error !== null : AsyncResult.isFailure(result)
