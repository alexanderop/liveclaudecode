import { assert, describe, it } from '@effect/vitest'
import { Context, Deferred, Effect, Layer, Ref } from 'effect'
import { TestClock } from 'effect/testing'
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import * as Atom from 'effect/unstable/reactivity/Atom'
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http'
import { pollingFeed } from '~/atoms/feed'
import { ApiUnreachable } from '~/api/errors'
import { testAtoms } from '../../fixtures/atom-registry'

/**
 * A stand-in for the `Api` service that Stage 2 introduces. The experiments
 * below are about the *seam* — whether a per-registry writable atom can decide
 * which layer a runtime builds from — and that mechanism does not depend on
 * which service sits behind it.
 */
class Counter extends Context.Service<Counter, {
  readonly next: Effect.Effect<number, ApiUnreachable>
}>()('test/Counter') {}

const counterLayer = (options: {
  readonly label: number
  readonly failuresBeforeSuccess?: number
}) =>
  Layer.effect(
    Counter,
    Effect.gen(function*() {
      const calls = yield* Ref.make(0)
      return Counter.of({
        next: Ref.updateAndGet(calls, n => n + 1).pipe(
          Effect.flatMap(n =>
            n <= (options.failuresBeforeSuccess ?? 0)
              ? Effect.fail(new ApiUnreachable({ url: '/test', detail: `attempt ${n}` }))
              : Effect.succeed(options.label * 1000 + n),
          ),
        ),
      })
    }),
  )

/**
 * The production seam, in miniature: one module-scope writable atom holding the
 * layer, and one runtime that reads it. `app/atoms/runtime.ts` is this shape.
 */
const counterLayerAtom = Atom.make<Layer.Layer<Counter>>(counterLayer({ label: 0 }))
const sharedRuntime = Atom.runtime(get => get(counterLayerAtom))
const sharedValueAtom = sharedRuntime.atom(Effect.flatMap(Counter, service => service.next))

describe('atom test harness', () => {
  // ---------------------------------------------------------------- E2
  describe('E2 — the layer-atom seam isolates a stub', () => {
    const isolated = (label: number) =>
      Effect.gen(function*() {
        const atoms = yield* testAtoms(Layer.empty)
        // Substitute the layer BEFORE anything reads the runtime. Seeding a
        // registry with `initialValues` would not do: a seeded node still runs
        // its read (AtomRegistry.ts:619-634).
        yield* atoms.set(counterLayerAtom, counterLayer({ label }))
        yield* atoms.mount(sharedValueAtom)
        return yield* atoms.settled(sharedValueAtom)
      })

    it.effect('one registry sees only its own stub', () =>
      Effect.gen(function*() {
        assert.strictEqual(yield* isolated(1), 1001)
      }).pipe(Effect.scoped))

    it.effect('a second registry is unaffected by the first', () =>
      Effect.gen(function*() {
        assert.strictEqual(yield* isolated(2), 2001)
      }).pipe(Effect.scoped))

    it.effect('two registries in one test do not share the layer', () =>
      Effect.gen(function*() {
        const first = yield* isolated(3)
        const second = yield* isolated(4)
        assert.strictEqual(first, 3001)
        assert.strictEqual(second, 4001)
      }).pipe(Effect.scoped))
  })

  // ---------------------------------------------------------------- E5
  describe('E5 — TestClock drives atom-internal timers', () => {
    it.effect('a poll loop ticks on the test clock, not the wall clock', () =>
      Effect.gen(function*() {
        const atoms = yield* testAtoms(counterLayer({ label: 5 }))
        const feed = atoms.runtime.atom(
          pollingFeed({
            interval: '2 seconds',
            initial: () => null,
            fetch: () =>
              Effect.map(
                Effect.flatMap(Counter, service => service.next),
                value => [null, value] as const,
              ),
          }),
        )
        const read = yield* atoms.recorded(feed)

        const calls = () =>
          Effect.map(read, values =>
            values.filter(v => AsyncResult.isSuccess(v) && v.value.value !== null).length)

        yield* atoms.settled(feed)
        assert.strictEqual(yield* calls(), 1, 'ticks immediately on the first pull')

        yield* TestClock.adjust('2 seconds')
        assert.strictEqual(yield* calls(), 2)

        yield* TestClock.adjust('4 seconds')
        assert.strictEqual(yield* calls(), 4)
      }).pipe(Effect.scoped))
  })

  // ---------------------------------------------------------------- E4
  describe('E4 — the poll loop recovers from a failure', () => {
    it.effect('three failures then a success keeps polling and keeps the value', () =>
      Effect.gen(function*() {
        const atoms = yield* testAtoms(
          counterLayer({ label: 7, failuresBeforeSuccess: 3 }),
        )
        const feed = atoms.runtime.atom(
          pollingFeed({
            interval: '2 seconds',
            initial: () => null,
            fetch: () =>
              Effect.map(
                Effect.flatMap(Counter, service => service.next),
                value => [null, value] as const,
              ),
          }),
        )
        const read = yield* atoms.recorded(feed)
        yield* atoms.settled(feed)
        yield* TestClock.adjust('6 seconds')

        const feeds = (yield* read).flatMap(result =>
          AsyncResult.isSuccess(result) ? [result.value] : [])

        // Four attempts: t=0, 2s, 4s, 6s. The first three fail.
        assert.strictEqual(feeds.length, 4, 'the loop did not stop on the first failure')
        assert.deepStrictEqual(
          feeds.slice(0, 3).map(f => f.value),
          [null, null, null],
        )
        assert.isTrue(feeds.slice(0, 3).every(f => f.error !== null), 'failures are reported')
        assert.strictEqual(feeds[3]?.value, 7004, 'the fourth attempt recovered')
        assert.strictEqual(feeds[3]?.error, null, 'recovery clears the error')
      }).pipe(Effect.scoped))

    it.effect('a failure after a success keeps the stale value on screen', () =>
      Effect.gen(function*() {
        const attempts = yield* Ref.make(0)
        const atoms = yield* testAtoms(Layer.empty)
        const feed = atoms.runtime.atom(
          pollingFeed({
            interval: '2 seconds',
            initial: () => null,
            fetch: () =>
              Ref.updateAndGet(attempts, n => n + 1).pipe(
                Effect.flatMap(n =>
                  n === 2
                    ? Effect.fail(new ApiUnreachable({ url: '/test', detail: 'down' }))
                    : Effect.succeed([null, `value-${n}`] as const),
                ),
              ),
          }),
        )
        const read = yield* atoms.recorded(feed)
        yield* atoms.settled(feed)
        yield* TestClock.adjust('2 seconds')

        const feeds = (yield* read).flatMap(result =>
          AsyncResult.isSuccess(result) ? [result.value] : [])
        const failed = feeds[1]
        assert.strictEqual(failed?.value, 'value-1', 'the previous value survived')
        assert.isNotNull(failed?.error, 'and the failure is reported alongside it')
      }).pipe(Effect.scoped))
  })

  // ---------------------------------------------------------------- E3
  describe('E3 — interrupt tears down the in-flight request', () => {
    it.effect('refreshing an atom runs the previous run\'s finalizer', () =>
      Effect.gen(function*() {
        const atoms = yield* testAtoms(Layer.empty)
        const released = yield* Deferred.make<void>()
        const slow = atoms.runtime.atom(
          Effect.addFinalizer(() => Deferred.succeed(released, undefined)).pipe(
            Effect.andThen(Effect.sleep('10 seconds')),
          ),
        )

        yield* atoms.mount(slow)
        yield* atoms.get(slow)
        yield* atoms.refresh(slow)

        // No timeout guard: under `it.effect` a timeout runs on the TestClock
        // and would never fire. If the superseded fiber is not interrupted this
        // await never resolves and vitest fails the case on its own deadline.
        yield* Deferred.await(released)
      }).pipe(Effect.scoped))

    it.effect('interrupting a request aborts the underlying fetch signal', () =>
      Effect.gen(function*() {
        const aborted = yield* Deferred.make<boolean>()
        const stubFetch: typeof globalThis.fetch = (_input, init) =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal
            signal?.addEventListener('abort', () => {
              Effect.runSync(Deferred.succeed(aborted, true))
              reject(new DOMException('aborted', 'AbortError'))
            })
          })

        const atoms = yield* testAtoms(
          FetchHttpClient.layer.pipe(
            Layer.provide(Layer.succeed(FetchHttpClient.Fetch, stubFetch)),
          ),
        )
        const request = atoms.runtime.atom(
          Effect.flatMap(HttpClient.HttpClient, client =>
            client.execute(HttpClientRequest.get('http://127.0.0.1:1/never'))),
        )

        yield* atoms.mount(request)
        yield* atoms.get(request)
        yield* atoms.refresh(request)

        assert.isTrue(
          yield* Deferred.await(aborted),
          'HttpClient did not abort the fetch when its fiber was interrupted',
        )
      }).pipe(Effect.scoped))
  })
})
