import { Effect, Stream } from 'effect'
import * as Atom from 'effect/unstable/reactivity/Atom'
import type { ChatEventWire, ChatStatusWire } from '#shared/schemas/api'
import type { ChatAction, ChatAgentId } from '#shared/types/chat'
import { Api } from '~/api/api'
import { pollingFeed } from './feed'
import { appRuntime } from './runtime'

/**
 * How often a *visible* chat panel re-reads its log.
 *
 * The same 800 ms the hand-rolled transport used. This is the one feed in the
 * dashboard rendering a stream of text as it is produced, so the interval is
 * what the answer's arrival looks like; the run tree's four seconds would make
 * a reply land in visible chunks.
 *
 * Hidden panels cost nothing regardless — see {@link ChatActivation}.
 */
const POLL_INTERVAL = '800 millis'

/**
 * How long a conversation, a draft, and an agent choice outlive their panel.
 *
 * This replaces `useChatSessionState`'s hard capacity-10 LRU. The two are not
 * the same rule and neither bounds the number of conversations: the LRU dropped
 * the eleventh-oldest the moment an eleventh appeared, however recently the
 * user had been reading it, while this drops anything nobody has looked at for
 * ten minutes, however many there are.
 *
 * The intent behind the LRU — "long dashboards do not accumulate unbounded chat
 * buffers" — is real and is kept, restated as a time bound. What actually
 * bounds the *live* set is unchanged: `<KeepAlive :max="10">` at
 * `index.vue:687` still caps mounted panels at ten, and an unmounted panel's
 * atoms are what this expires.
 */
const IDLE_TTL = '10 minutes'

/**
 * Which conversation a panel is showing.
 *
 * No `hours`. The old transport put the range in its poll-identity key and in
 * the watch that wiped the log, so changing the range threw away the whole
 * conversation and refetched it — against an endpoint that ignores `hours`
 * entirely (`server/api/chat.get.ts`). Keying on the session alone is the same
 * data with none of the churn.
 */
export interface ChatTarget {
  readonly project: string
  readonly key: string
}

/**
 * The one constructor for a {@link ChatTarget}; call sites never inline a
 * literal. `Atom.family` memoises on structural equality, so an optional or
 * explicitly-`undefined` property would silently split the cache.
 */
export const chatTarget = (project: string, key: string): ChatTarget => ({ project, key })

/** Identity of a target, as a string a `Map` and a stream filter can compare. */
const identify = (target: ChatTarget): string => `${target.project}\0${target.key}`

/** A panel appearing or disappearing. `-1` must pair with exactly one `+1`. */
export interface ChatActivation {
  readonly target: ChatTarget
  readonly delta: 1 | -1
}

/** What the server says about one conversation, as the panel renders it. */
export interface ChatConversation {
  /** The whole log, oldest first — the poll appends, the server may replace. */
  readonly events: ReadonlyArray<ChatEventWire>
  readonly status: ChatStatusWire
  /** Agent answering, or null before the first message and after a reset. */
  readonly agent: ChatAgentId | null
}

const EMPTY_CONVERSATION: ChatConversation = { events: [], status: 'idle', agent: null }

/** The cursor threaded across polls, alongside the log it has accumulated. */
interface ChatCursor {
  readonly since: number
  readonly revision: number
  readonly conversation: ChatConversation
}

/** One send, cancel, or reset. `hours` locates the session server-side. */
export interface ChatActionInput {
  readonly action: ChatAction
  readonly hours: number
}

/** A "poll now" pulse, tagged with the conversation that asked for it. */
interface ChatPulse {
  readonly id: string
  readonly n: number
}

/**
 * The chat, as atoms.
 *
 * Ownership is deliberately narrow: **the poll family owns `events`, `since`,
 * and `revision`, and nothing else may write them.** The old code had the same
 * three fields living in a Nuxt `useState` LRU, mutated by the transport, by a
 * range watcher, and by `reset()`, which is why the reset path had to clear
 * them by hand in the right order. Here a reset removes the record on the
 * server and the next poll observes it — one writer, one direction.
 *
 * What is left is view state: {@link makeChatAtoms.draft} and the agent the
 * user picked. Those are per target because a half-typed question belongs to
 * the session it was about.
 */
export const makeChatAtoms = (runtime: Atom.AtomRuntime<Api>) => {
  /**
   * Which conversations are on screen, by identity, counted.
   *
   * A count rather than a flag because the session panel and the inspector's
   * subagent tab can be showing the *same* session at once — the inspector is
   * handed the selected node's key, and the selected node is often the root.
   * A shared boolean would let either one's deactivation stop the other's poll.
   *
   * `keepAlive` for the reason `apiLayerAtom` needs it: nothing subscribes to
   * this, it is only ever written by a mounting panel and read with
   * `AtomContext.once` from inside a running stream, so the registry's idle
   * sweep would otherwise discard it and hand the next read an empty map —
   * every visible panel silently stops polling.
   */
  const active: Atom.Writable<ReadonlyMap<string, number>, ChatActivation> = Atom.writable<
    ReadonlyMap<string, number>,
    ChatActivation
  >(
    () => new Map(),
    (ctx, activation) => {
      const id = identify(activation.target)
      const next = new Map(ctx.get(active))
      const count = (next.get(id) ?? 0) + activation.delta
      if (count > 0) next.set(id, count)
      else next.delete(id)
      ctx.setSelf(next)
    },
  ).pipe(Atom.keepAlive)

  /**
   * "Poll this conversation now", written after an action is accepted.
   *
   * An action changes the server's log — a send appends the question, a reset
   * removes the record — and waiting up to a full interval to see that is what
   * made the old transport re-poll inline. This is that re-poll, as a pulse
   * merged into the already-running stream rather than a refresh, which would
   * rebuild the node and drop the cursor.
   *
   * `Reactivity` keys would have been the idiomatic route and are wrong for the
   * same reason: invalidation rebuilds.
   *
   * A counter, because the registry only notifies on a changed value; tagged
   * with the target, so a send in the session panel does not make the
   * inspector's panel fetch too.
   *
   * The sentinel `id` is what keeps the first pulse from polling twice. A node
   * that has never been read is evaluated by its first *write*, and the
   * subscriber is handed the initial value **and** then the written one; no
   * conversation identity can be the empty string, so the tag filter below
   * drops that first notification.
   */
  const pulse: Atom.Writable<ChatPulse, ChatTarget> = Atom.writable<ChatPulse, ChatTarget>(
    () => ({ id: '', n: 0 }),
    (ctx, target) => ctx.setSelf({ id: identify(target), n: ctx.get(pulse).n + 1 }),
  ).pipe(Atom.keepAlive)

  const conversation = Atom.family((target: ChatTarget) => {
    const id = identify(target)
    return runtime.atom((get) => {
      return pollingFeed({
        interval: POLL_INTERVAL,
        initial: (): ChatCursor => ({ since: 0, revision: 0, conversation: EMPTY_CONVERSATION }),
        // Read per tick, never as a dependency. A tracked read would make this
        // atom a dependent of the flag and rebuild the stream when a panel is
        // hidden, discarding the cursor — the regression §3.9 exists to avoid.
        enabled: () =>
          Boolean(target.project && target.key) && (get.once(active).get(id) ?? 0) > 0,
        pulses: get.stream(pulse, { withoutInitialValue: true }).pipe(
          Stream.filter(published => published.id === id),
        ),
        fetch: cursor =>
          Effect.gen(function*() {
            const api = yield* Api
            const page = yield* api.chatEvents({
              project: target.project,
              key: target.key,
              since: cursor.since,
              revision: cursor.revision,
            })
            // `reset` is the server saying its log is not the one this cursor
            // belongs to: a new revision, or a cursor outside the retained
            // window. Then `events` replaces rather than extends.
            const events = page.reset
              ? page.events
              : [...cursor.conversation.events, ...page.events]
            const next: ChatConversation = {
              events,
              status: page.status,
              agent: page.agent,
            }
            return [
              { since: page.next, revision: page.revision, conversation: next },
              next,
            ] as const
          }),
      })
    }).pipe(Atom.setIdleTTL(IDLE_TTL))
  })

  /** The unsent question, per conversation. */
  const draft = Atom.family((target: ChatTarget) => {
    void target
    return Atom.writable<string, string>(() => '', (ctx, text) => ctx.setSelf(text)).pipe(
      Atom.setIdleTTL(IDLE_TTL),
    )
  })

  /**
   * The agent the user picked, or null if they have not.
   *
   * Only half of the answer: a conversation that has already started reports
   * its own agent and that one wins, because it is the process actually
   * replying. See `chatAgent` in `app/utils/chat-view.ts`, which is where the
   * two are combined — this atom holds the choice, not the outcome.
   */
  const agentChoice = Atom.family((target: ChatTarget) => {
    void target
    return Atom.writable<ChatAgentId | null, ChatAgentId>(
      () => null,
      (ctx, agent) => ctx.setSelf(agent),
    ).pipe(Atom.setIdleTTL(IDLE_TTL))
  })

  /**
   * Send, cancel, and reset, per conversation.
   *
   * Per conversation rather than one shared fn atom because a write without
   * `concurrent: true` cancels the previous run: one shared atom would let a
   * question typed in the inspector abort one being sent from the session
   * panel, and would show both panels as busy while either was.
   */
  const action = Atom.family((target: ChatTarget) => {
    void target
    return runtime.fn(Effect.fn('chatAction')(function*(input: ChatActionInput) {
      const api = yield* Api
      return yield* api.chatAction(input.action, { hours: input.hours })
    }))
  })

  return { active, pulse, conversation, draft, agentChoice, action }
}

/** The live instance every component reads. Tests call the factory instead. */
export const chatAtoms = makeChatAtoms(appRuntime)
