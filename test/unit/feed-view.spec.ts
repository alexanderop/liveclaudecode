import { assert, describe, it } from '@effect/vitest'
import { Cause } from 'effect'
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import type { Feed } from '~/atoms/feed'
import { feedIsOffline, feedValue, toActionError, toFeedView } from '~/utils/feed-view'
import type { ApiError } from '~/api/errors'
import { ApiMalformed, ApiUnreachable } from '~/api/errors'

const offline = new ApiUnreachable({ url: '/api/tree', detail: 'connection refused' })

const feed = (value: string | null, error: ApiError | null = null): Feed<string> => ({
  value,
  error,
})

const success = (value: Feed<string>, waiting = false) =>
  AsyncResult.success<Feed<string>, never>(value, { waiting })

describe('toFeedView', () => {
  it('reports loading before the first response', () => {
    assert.deepStrictEqual(
      toFeedView(AsyncResult.initial<Feed<string>, never>()),
      { tag: 'loading' },
    )
  })

  it('reports loading while the first request is in flight', () => {
    assert.deepStrictEqual(
      toFeedView(AsyncResult.initial<Feed<string>, never>(true)),
      { tag: 'loading' },
    )
  })

  it('reports ready for a clean response', () => {
    assert.deepStrictEqual(
      toFeedView(success(feed('projects'))),
      { tag: 'ready', value: 'projects' },
    )
  })

  it('still reports ready while the next poll is in flight', () => {
    // The regression this pins: a stream-backed atom marks EVERY chunk
    // `waiting: true` and clears it only when the stream ends, and a poll loop
    // never ends. Projecting through `AsyncResult.matchWithWaiting` would
    // report loading forever and the dashboard would never render.
    assert.deepStrictEqual(
      toFeedView(success(feed('projects'), true)),
      { tag: 'ready', value: 'projects' },
    )
  })

  it('reports stale when a refresh failed but data is on screen', () => {
    assert.deepStrictEqual(
      toFeedView(success(feed('projects', offline))),
      { tag: 'stale', value: 'projects', message: offline.message, remedy: offline.remedy },
    )
  })

  it('reports error when the very first request failed', () => {
    assert.deepStrictEqual(
      toFeedView(success(feed(null, offline))),
      { tag: 'error', message: offline.message, remedy: offline.remedy },
    )
  })

  it('carries the failure\'s own remedy, not one sentence for every failure', () => {
    // The page renders `message` and `remedy` together, and what to do differs:
    // an unreachable server recovers by itself, a body this build cannot read
    // never will.
    const skew = new ApiMalformed({ url: '/api/costs', detail: 'sessions: expected number' })
    assert.deepStrictEqual(
      toFeedView(success(feed(null, skew))),
      { tag: 'error', message: skew.message, remedy: skew.remedy },
    )
    assert.deepStrictEqual(
      toFeedView(success(feed('projects', skew))),
      { tag: 'stale', value: 'projects', message: skew.message, remedy: skew.remedy },
    )
    assert.notStrictEqual(skew.remedy, offline.remedy)
  })

  it('reports error for a typed stream failure', () => {
    const result = AsyncResult.failure<Feed<string>, ApiUnreachable>(Cause.fail(offline))
    assert.deepStrictEqual(toFeedView(result), {
      tag: 'error',
      message: offline.message,
      // A dead stream is a defect, so there is no ApiError to take advice from.
      remedy: 'Reload the page. If it happens again, check the server output.',
    })
  })

  it('reports error for a defect', () => {
    const result = AsyncResult.failure<Feed<string>, never>(Cause.die(new Error('boom')))
    assert.deepStrictEqual(toFeedView(result), {
      tag: 'error',
      message: 'boom',
      remedy: 'Reload the page. If it happens again, check the server output.',
    })
  })

  it('treats an interrupt-only failure as loading, not as an error', () => {
    // An interrupt-only cause carries no typed error, so a matcher would route
    // it to the defect branch and show the user a synthetic
    // "All fibers interrupted without error".
    const result = AsyncResult.failure<Feed<string>, never>(Cause.interrupt(1))
    assert.deepStrictEqual(toFeedView(result), { tag: 'loading' })
  })
})

describe('feedValue', () => {
  it('projects the current value', () => {
    assert.strictEqual(feedValue(success(feed('abc')), v => v.length, 0), 3)
  })

  it('falls back before the first response', () => {
    assert.strictEqual(
      feedValue(AsyncResult.initial<Feed<string>, never>(), v => v.length, 0),
      0,
    )
  })

  it('keeps the stale value through a failed refresh', () => {
    assert.strictEqual(feedValue(success(feed('abc', offline)), v => v.length, 0), 3)
  })
})

describe('toActionError', () => {
  const pending = AsyncResult.initial<string, ApiError>(true)

  it('has nothing to report before an action is run', () => {
    assert.isNull(toActionError(AsyncResult.initial<string, ApiError>()))
    assert.isNull(toActionError(pending))
  })

  it('has nothing to report for an accepted action', () => {
    assert.isNull(toActionError(AsyncResult.success<string, ApiError>('starting')))
  })

  it('reports the failure and what to do about it', () => {
    const result = AsyncResult.failure<string, ApiError>(Cause.fail(offline))
    assert.deepStrictEqual(toActionError(result), {
      message: offline.message,
      remedy: offline.remedy,
    })
  })

  it('says nothing when the action was superseded rather than refused', () => {
    // Writing the atom again interrupts the run in flight, and the user who did
    // that is looking at the outcome of the second one.
    const result = AsyncResult.failure<string, ApiError>(Cause.interrupt(1))
    assert.isNull(toActionError(result))
  })

  it('reports a defect as itself, with no advice it cannot give', () => {
    const result = AsyncResult.failure<string, ApiError>(Cause.die(new Error('boom')))
    assert.deepStrictEqual(toActionError(result), {
      message: 'boom',
      remedy: 'Reload the page. If it happens again, check the server output.',
    })
  })
})

describe('feedIsOffline', () => {
  it('is false for a clean response', () => {
    assert.isFalse(feedIsOffline(success(feed('abc'))))
  })

  it('is true while the most recent poll is failing', () => {
    assert.isTrue(feedIsOffline(success(feed('abc', offline))))
  })

  it('is false before the first response', () => {
    assert.isFalse(feedIsOffline(AsyncResult.initial<Feed<string>, never>()))
  })
})
