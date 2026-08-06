import { Effect, Layer } from 'effect'
import * as Atom from 'effect/unstable/reactivity/Atom'
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import * as AtomRegistry from 'effect/unstable/reactivity/AtomRegistry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chatTarget, makeChatAtoms } from '~/atoms/chat'
import { chatEventsResponse } from '../../fixtures/chat'
import { stubApi } from '../../fixtures/stub-api'

/**
 * How long a conversation and its draft outlive the panel that showed them.
 *
 * This is what replaced `useChatSessionState`'s capacity-10 LRU, and it is a
 * different rule: the LRU dropped the eleventh-oldest conversation the instant
 * an eleventh appeared, however recently it had been read, while this drops
 * whatever nobody has looked at for ten minutes, however many there are. The
 * requirement the LRU was written for — "long dashboards do not accumulate
 * unbounded chat buffers" — is the one being kept, restated as a time bound, so
 * it is asserted here rather than assumed from the combinator.
 *
 * Separate from `chat.spec.ts` because it is the one thing about these atoms
 * `TestClock` cannot reach: idle expiry runs on a raw `setTimeout` and a
 * macrotask inside the registry (`AtomRegistry.ts:490-509`), so it needs faked
 * wall-clock timers and a real task flush.
 */
const IDLE_TTL_MINUTES = 10
const minutes = (count: number) => count * 60_000

const session = chatTarget('/repo', 'claude:session')

afterEach(() => {
  vi.useRealTimers()
})

/** A registry and a chat family with no shared state from any other case. */
const setup = () => {
  const stub = stubApi({
    chatEvents: () =>
      Effect.succeed(chatEventsResponse({
        events: [{ kind: 'user', text: 'why did the tests fail?' }],
        next: 1,
        revision: 1,
      })),
  })
  const runtime = Atom.context({ memoMap: Layer.makeMemoMapUnsafe() })(stub.layer)
  // No `defaultIdleTTL`: the expiry under test is the one the atoms declare.
  return { registry: AtomRegistry.make(), chat: makeChatAtoms(runtime) }
}

describe('how long a conversation is kept', () => {
  it('still has the draft when the panel comes back a few minutes later', async () => {
    vi.useFakeTimers()
    const { registry, chat } = setup()
    const draft = chat.draft(session)

    const unmount = registry.mount(draft)
    registry.set(draft, 'half a question')
    unmount()
    await vi.advanceTimersByTimeAsync(minutes(IDLE_TTL_MINUTES - 1))

    // Closing the Ask panel and reopening it is not the same as abandoning the
    // question that was being typed into it.
    expect(registry.get(draft)).toBe('half a question')
  })

  it('lets the draft go once nobody has looked at it for the whole TTL', async () => {
    vi.useFakeTimers()
    const { registry, chat } = setup()
    const draft = chat.draft(session)

    const unmount = registry.mount(draft)
    registry.set(draft, 'half a question')
    unmount()
    await vi.advanceTimersByTimeAsync(minutes(IDLE_TTL_MINUTES + 1))

    expect(registry.get(draft)).toBe('')
  })

  it('releases the event buffer of a conversation nobody returns to', async () => {
    vi.useFakeTimers()
    const { registry, chat } = setup()
    const feed = chat.conversation(session)

    registry.set(chat.active, { target: session, delta: 1 })
    const unmount = registry.mount(feed)
    await vi.advanceTimersByTimeAsync(0)
    expect(AsyncResult.isSuccess(registry.get(feed))).toBe(true)

    registry.set(chat.active, { target: session, delta: -1 })
    unmount()
    await vi.advanceTimersByTimeAsync(minutes(IDLE_TTL_MINUTES + 1))

    // The log is what actually costs memory, and an expired node is back to
    // `Initial` — nothing retained, and the next visit refetches from zero.
    expect(registry.get(feed)._tag).toBe('Initial')
  })
})
