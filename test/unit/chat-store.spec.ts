import { assert, describe, it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Scope } from 'effect'
import { TestClock } from 'effect/testing'
import { ChatStore } from '#server/utils/chat-store'

describe('chat resource store', () => {
  it.effect('expires idle chats and closes their retained ACP scope', () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(0)
      const store = yield* ChatStore
      const reservation = yield* store.reserve('idle-chat', 'codex', 'Hello')
      assert.strictEqual(reservation._tag, 'Reserved')
      if (reservation._tag !== 'Reserved') return

      let closed = false
      const scope = yield* Scope.make()
      yield* Scope.addFinalizer(scope, Effect.sync(() => { closed = true }))
      reservation.record.scope = scope
      reservation.record.status = 'idle'
      yield* store.settle('idle-chat', reservation.record, reservation.generation)

      yield* TestClock.setTime(30 * 60 * 1_000 - 1)
      assert.strictEqual(yield* store.get('idle-chat'), reservation.record)
      assert.isFalse(closed)

      yield* TestClock.setTime(30 * 60 * 1_000)
      assert.strictEqual(yield* store.get('idle-chat'), undefined)
      assert.isTrue(closed)
    }).pipe(Effect.provide(ChatStore.layer)))

  it.effect('bounds idle chats without evicting an active turn', () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(0)
      const store = yield* ChatStore
      const active = yield* store.reserve('active-chat', 'codex', 'Keep working')
      assert.strictEqual(active._tag, 'Reserved')

      const closed: string[] = []
      for (let index = 0; index < 10; index += 1) {
        yield* TestClock.setTime(index + 1)
        const key = `idle-${index}`
        const reservation = yield* store.reserve(key, 'codex', 'Hello')
        assert.strictEqual(reservation._tag, 'Reserved')
        if (reservation._tag !== 'Reserved') continue
        const scope = yield* Scope.make()
        yield* Scope.addFinalizer(scope, Effect.sync(() => { closed.push(key) }))
        reservation.record.scope = scope
        reservation.record.status = 'idle'
        yield* store.settle(key, reservation.record, reservation.generation)
      }

      assert.isTrue((yield* store.get('active-chat')) !== undefined)
      assert.strictEqual(yield* store.get('idle-0'), undefined)
      assert.deepStrictEqual(closed, ['idle-0'])

      yield* TestClock.setTime(30 * 60 * 1_000 + 1)
      assert.isTrue((yield* store.get('active-chat')) !== undefined)
    }).pipe(Effect.provide(ChatStore.layer)))

  it.effect('rejects a new chat when every retained slot owns an active turn', () =>
    Effect.gen(function*() {
      const store = yield* ChatStore
      for (let index = 0; index < 10; index += 1) {
        const reservation = yield* store.reserve(`active-${index}`, 'codex', 'Keep working')
        assert.strictEqual(reservation._tag, 'Reserved')
      }

      const overflow = yield* store.reserve('active-overflow', 'codex', 'One more')
      assert.strictEqual(overflow._tag, 'Full')
      assert.strictEqual(yield* store.get('active-overflow'), undefined)
    }).pipe(Effect.provide(ChatStore.layer)))

  it.effect('finishes eviction cleanup when its triggering read is interrupted', () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(0)
      const store = yield* ChatStore
      const reservation = yield* store.reserve('expiring-chat', 'codex', 'Hello')
      assert.strictEqual(reservation._tag, 'Reserved')
      if (reservation._tag !== 'Reserved') return

      const cleanupStarted = yield* Deferred.make<void>()
      const releaseCleanup = yield* Deferred.make<void>()
      let closed = false
      const scope = yield* Scope.make()
      yield* Scope.addFinalizer(scope, Effect.gen(function*() {
        yield* Deferred.succeed(cleanupStarted, undefined)
        yield* Deferred.await(releaseCleanup)
        closed = true
      }))
      reservation.record.scope = scope
      reservation.record.status = 'idle'
      yield* store.settle('expiring-chat', reservation.record, reservation.generation)
      yield* TestClock.setTime(30 * 60 * 1_000)

      const reading = yield* Effect.forkChild(store.get('expiring-chat'))
      yield* Deferred.await(cleanupStarted)
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(reading))
      yield* Effect.yieldNow
      assert.isFalse(closed)

      yield* Deferred.succeed(releaseCleanup, undefined)
      yield* Fiber.join(interrupting)
      assert.isTrue(closed)
      assert.strictEqual(yield* store.get('expiring-chat'), undefined)
    }).pipe(Effect.provide(ChatStore.layer)))

  it.effect('closes retained chat scopes when the store layer is released', () =>
    Effect.gen(function*() {
      let closed = false
      yield* Effect.gen(function*() {
        const store = yield* ChatStore
        const reservation = yield* store.reserve('retained-chat', 'codex', 'Hello')
        assert.strictEqual(reservation._tag, 'Reserved')
        if (reservation._tag !== 'Reserved') return
        const scope = yield* Scope.make()
        yield* Scope.addFinalizer(scope, Effect.sync(() => { closed = true }))
        reservation.record.scope = scope
        reservation.record.status = 'idle'
        yield* store.settle('retained-chat', reservation.record, reservation.generation)
      }).pipe(Effect.provide(ChatStore.layer))
      assert.isTrue(closed)
    }))
})
