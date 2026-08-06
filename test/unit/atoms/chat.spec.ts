import { assert, describe, it } from '@effect/vitest'
import { Effect, Ref } from 'effect'
import { TestClock } from 'effect/testing'
import type { ChatEventsResponse } from '#shared/types/chat'
import { ApiUnreachable } from '~/api/errors'
import { chatAtoms, chatTarget, makeChatAtoms } from '~/atoms/chat'
import { toChatView } from '~/utils/chat-view'
import { testAtoms } from '../../fixtures/atom-registry'
import { chatActionResponse, chatEventsResponse } from '../../fixtures/chat'
import { stubApi, type StubApiHandlers } from '../../fixtures/stub-api'

/** The cadence `app/atoms/chat.ts` chose, restated so a change fails here. */
const INTERVAL = '800 millis'

const session = chatTarget('/repo', 'claude:session')
const other = chatTarget('/repo', 'claude:other')

/** A registry, a runtime bound to a fresh stub, and a fresh chat family. */
const withChat = Effect.fn('withChat')(function*(handlers: StubApiHandlers) {
  const stub = stubApi(handlers)
  const atoms = yield* testAtoms(stub.layer)
  const chat = makeChatAtoms(atoms.runtime)
  return { atoms, stub, chat }
})

/**
 * Yields until the feed's subscription to the pulse atom is live.
 *
 * The merged pulse stream registers its listener in a forked fiber one
 * scheduler turn after the feed publishes its first value, and a pulse fired
 * before then is not queued — it is simply not seen. No user can act inside
 * that window; a test can, and it looks like a hang rather than a failure.
 */
const pulseIsLive = Effect.yieldNow

/** Answers each poll from a script, one entry per call, repeating the last. */
const replying = (pages: ReadonlyArray<Partial<ChatEventsResponse>>): StubApiHandlers => {
  let call = 0
  return {
    chatEvents: () => {
      const page = pages[Math.min(call++, pages.length - 1)] ?? {}
      return Effect.succeed(chatEventsResponse(page))
    },
  }
}

describe('chat atoms', () => {
  describe('the activation gate', () => {
    it.effect('does not poll a conversation nobody is looking at', () =>
      Effect.gen(function*() {
        const { atoms, stub, chat } = yield* withChat(replying([{}]))

        yield* atoms.mount(chat.conversation(session))
        yield* TestClock.adjust('10 seconds')

        // Not "polls and discards": a hidden panel must cost nothing, because
        // `<KeepAlive :max="10">` can be holding ten of them.
        assert.deepStrictEqual(yield* stub.calls.chatEvents.all, [])
      }).pipe(Effect.scoped))

    it.effect('never polls a panel with no session selected', () =>
      Effect.gen(function*() {
        const empty = chatTarget('', '')
        const { atoms, stub, chat } = yield* withChat(replying([{}]))

        yield* atoms.set(chat.active, { target: empty, delta: 1 })
        yield* atoms.mount(chat.conversation(empty))
        yield* TestClock.adjust('10 seconds')

        assert.deepStrictEqual(yield* stub.calls.chatEvents.all, [])
      }).pipe(Effect.scoped))

    it.effect('resumes from the cursor it paused on, not from zero', () =>
      Effect.gen(function*() {
        const { atoms, stub, chat } = yield* withChat(replying([
          { events: [{ kind: 'user', text: 'why?' }], next: 1, revision: 7 },
          { next: 1, revision: 7 },
        ]))

        yield* atoms.set(chat.active, { target: session, delta: 1 })
        yield* atoms.mount(chat.conversation(session))
        yield* atoms.settled(chat.conversation(session))

        yield* atoms.set(chat.active, { target: session, delta: -1 })
        yield* TestClock.adjust('10 seconds')
        assert.strictEqual((yield* stub.calls.chatEvents.all).length, 1)

        yield* atoms.set(chat.active, { target: session, delta: 1 })
        yield* TestClock.adjust(INTERVAL)

        // The point of gating inside the loop rather than re-keying the family:
        // a different key is a different node, so the cursor would restart at 0
        // and the panel would refetch the whole conversation on every switch.
        const calls = yield* stub.calls.chatEvents.all
        assert.deepStrictEqual(calls.map(call => call.since), [0, 1])
        assert.deepStrictEqual(calls.map(call => call.revision), [0, 7])
      }).pipe(Effect.scoped))

    it.effect('keeps polling while either of two panels shows the conversation', () =>
      Effect.gen(function*() {
        const { atoms, stub, chat } = yield* withChat(replying([{}]))

        // The session panel and the inspector's subagent tab can be showing the
        // same session: the inspector is handed the selected node's key, and the
        // selected node is often the root.
        yield* atoms.set(chat.active, { target: session, delta: 1 })
        yield* atoms.set(chat.active, { target: session, delta: 1 })
        yield* atoms.mount(chat.conversation(session))
        yield* atoms.settled(chat.conversation(session))

        yield* atoms.set(chat.active, { target: session, delta: -1 })
        yield* TestClock.adjust(INTERVAL)

        assert.strictEqual((yield* stub.calls.chatEvents.all).length, 2)
      }).pipe(Effect.scoped))
  })

  describe('the cursor', () => {
    it.effect('appends the events after the cursor and advances it', () =>
      Effect.gen(function*() {
        const { atoms, stub, chat } = yield* withChat(replying([
          { events: [{ kind: 'user', text: 'why?' }], next: 1, revision: 4 },
          {
            events: [{ kind: 'assistant-chunk', agent: 'claude', text: 'because' }],
            next: 2,
            revision: 4,
            status: 'busy',
          },
        ]))

        yield* atoms.set(chat.active, { target: session, delta: 1 })
        yield* atoms.mount(chat.conversation(session))
        yield* atoms.settled(chat.conversation(session))
        yield* TestClock.adjust(INTERVAL)

        const view = toChatView(yield* atoms.get(chat.conversation(session)))
        assert.deepStrictEqual(view.events, [
          { kind: 'user', text: 'why?' },
          { kind: 'assistant-chunk', agent: 'claude', text: 'because' },
        ])
        assert.strictEqual(view.status, 'busy')
        assert.deepStrictEqual((yield* stub.calls.chatEvents.all).map(call => call.since), [0, 1])
      }).pipe(Effect.scoped))

    it.effect('replaces the log when the server says the revision changed', () =>
      Effect.gen(function*() {
        const { atoms, chat } = yield* withChat(replying([
          { events: [{ kind: 'user', text: 'first' }], next: 1, revision: 1 },
          { events: [{ kind: 'user', text: 'second' }], next: 1, revision: 2, reset: true },
        ]))

        yield* atoms.set(chat.active, { target: session, delta: 1 })
        yield* atoms.mount(chat.conversation(session))
        yield* atoms.settled(chat.conversation(session))
        yield* TestClock.adjust(INTERVAL)

        // `reset` is the server saying this cursor belongs to a log it no longer
        // has. Appending would leave the old conversation above the new one.
        const view = toChatView(yield* atoms.get(chat.conversation(session)))
        assert.deepStrictEqual(view.events, [{ kind: 'user', text: 'second' }])
      }).pipe(Effect.scoped))

    it.effect('keeps two conversations apart', () =>
      Effect.gen(function*() {
        const { atoms, stub, chat } = yield* withChat({
          chatEvents: query =>
            Effect.succeed(chatEventsResponse({
              events: [{ kind: 'user', text: query.key }],
              next: 1,
              revision: 1,
            })),
        })

        for (const target of [session, other]) {
          yield* atoms.set(chat.active, { target, delta: 1 })
          yield* atoms.mount(chat.conversation(target))
          yield* atoms.settled(chat.conversation(target))
        }

        assert.deepStrictEqual(
          toChatView(yield* atoms.get(chat.conversation(session))).events,
          [{ kind: 'user', text: 'claude:session' }],
        )
        assert.deepStrictEqual(
          toChatView(yield* atoms.get(chat.conversation(other))).events,
          [{ kind: 'user', text: 'claude:other' }],
        )
        assert.deepStrictEqual(
          (yield* stub.calls.chatEvents.all).map(call => call.key).sort(),
          ['claude:other', 'claude:session'],
        )
      }).pipe(Effect.scoped))
  })

  describe('a failed poll', () => {
    it.effect('keeps the conversation on screen and recovers on the next tick', () =>
      Effect.gen(function*() {
        const calls = yield* Ref.make(0)
        const { atoms, chat } = yield* withChat({
          chatEvents: () =>
            Effect.flatMap(Ref.updateAndGet(calls, n => n + 1), n =>
              n === 2
                ? Effect.fail(new ApiUnreachable({ url: '/api/chat', detail: 'connect refused' }))
                : Effect.succeed(chatEventsResponse({
                  events: n === 1 ? [{ kind: 'user', text: 'why?' }] : [],
                  next: 1,
                  revision: 1,
                }))),
        })

        yield* atoms.set(chat.active, { target: session, delta: 1 })
        yield* atoms.mount(chat.conversation(session))
        yield* atoms.settled(chat.conversation(session))

        yield* TestClock.adjust(INTERVAL)
        const offline = toChatView(yield* atoms.get(chat.conversation(session)))
        assert.deepStrictEqual(offline.events, [{ kind: 'user', text: 'why?' }])
        assert.include(offline.error?.message ?? '', 'unreachable')

        // A stream that fails has ended, and nothing re-arms it. The loop folds
        // the failure into the value precisely so the next tick still happens.
        yield* TestClock.adjust(INTERVAL)
        const recovered = toChatView(yield* atoms.get(chat.conversation(session)))
        assert.strictEqual(recovered.error, null)
        assert.deepStrictEqual(recovered.events, [{ kind: 'user', text: 'why?' }])
      }).pipe(Effect.scoped))
  })

  describe('actions', () => {
    it.effect('sends the action and the range the caller is looking at', () =>
      Effect.gen(function*() {
        const { atoms, stub, chat } = yield* withChat({
          chatAction: () => Effect.succeed(chatActionResponse()),
        })

        yield* atoms.set(chat.action(session), {
          action: { action: 'cancel', project: '/repo', key: 'claude:session' },
          hours: 24,
        })
        yield* atoms.settled(chat.action(session))

        // `hours` is dead on the GET and load-bearing on the POST: it is how the
        // handler locates the session to attach an agent to.
        assert.deepStrictEqual(yield* stub.calls.chatAction.all, [{
          action: { action: 'cancel', project: '/repo', key: 'claude:session' },
          query: { hours: 24 },
        }])
      }).pipe(Effect.scoped))

    it.effect('polls immediately when a pulse arrives, without waiting out the interval', () =>
      Effect.gen(function*() {
        const { atoms, stub, chat } = yield* withChat(replying([{ next: 1, revision: 1 }]))

        yield* atoms.set(chat.active, { target: session, delta: 1 })
        const feed = chat.conversation(session)
        const next = yield* atoms.published(feed)
        yield* atoms.settled(feed)
        yield* next
        yield* pulseIsLive
        assert.strictEqual((yield* stub.calls.chatEvents.all).length, 1)

        yield* atoms.set(chat.pulse, session)
        yield* next

        // No `TestClock.adjust` anywhere above: the pulse is what polled.
        assert.strictEqual((yield* stub.calls.chatEvents.all).length, 2)
      }).pipe(Effect.scoped))

    it.effect('leaves the other conversation alone when one of them is pulsed', () =>
      Effect.gen(function*() {
        const { atoms, stub, chat } = yield* withChat(replying([{ next: 1, revision: 1 }]))

        for (const target of [session, other]) {
          yield* atoms.set(chat.active, { target, delta: 1 })
          yield* atoms.mount(chat.conversation(target))
          yield* atoms.settled(chat.conversation(target))
        }
        yield* pulseIsLive

        yield* atoms.set(chat.pulse, session)
        yield* Effect.yieldNow
        yield* Effect.yieldNow

        const keys = (yield* stub.calls.chatEvents.all).map(call => call.key)
        assert.strictEqual(keys.filter(key => key === 'claude:session').length, 2)
        assert.strictEqual(keys.filter(key => key === 'claude:other').length, 1)
      }).pipe(Effect.scoped))
  })

  it('exports one live instance built from the app runtime', () => {
    // Components import this; the factory exists so tests do not share its nodes.
    assert.notStrictEqual(chatAtoms.conversation(session), undefined)
  })
})
