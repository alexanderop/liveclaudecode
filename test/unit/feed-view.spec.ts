import { assert, describe, it } from '@effect/vitest'
import { Cause } from 'effect'
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import type { Feed } from '~/atoms/feed'
import { feedIsOffline, feedValue, toFeedView } from '~/utils/feed-view'
import { ApiUnreachable } from '~/api/errors'

const offline = new ApiUnreachable({ url: '/api/tree', detail: 'connection refused' })

const feed = (value: string | null, error: ApiUnreachable | null = null): Feed<string> => ({
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
      { tag: 'stale', value: 'projects', message: offline.message },
    )
  })

  it('reports error when the very first request failed', () => {
    assert.deepStrictEqual(
      toFeedView(success(feed(null, offline))),
      { tag: 'error', message: offline.message },
    )
  })

  it('reports error for a typed stream failure', () => {
    const result = AsyncResult.failure<Feed<string>, ApiUnreachable>(Cause.fail(offline))
    assert.deepStrictEqual(toFeedView(result), { tag: 'error', message: offline.message })
  })

  it('reports error for a defect', () => {
    const result = AsyncResult.failure<Feed<string>, never>(Cause.die(new Error('boom')))
    assert.deepStrictEqual(toFeedView(result), { tag: 'error', message: 'boom' })
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
