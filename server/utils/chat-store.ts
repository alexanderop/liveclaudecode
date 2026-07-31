import { Clock, Context, Effect, Exit, Fiber, Layer, Scope } from 'effect'
import type { AcpConnection } from './acp-connection'
import type {
  ChatAgentId,
  ChatEvent,
  ChatStatus,
} from '#shared/types/chat'

export interface ChatRecord {
  agent: ChatAgentId
  status: ChatStatus
  revision: number
  generation: number
  /** Index of `events[0]` in the chat's full history; grows when trimmed. */
  base: number
  events: ChatEvent[]
  scope: Scope.Closeable | null
  connection: AcpConnection | null
  sessionId: string | null
  /** Whether the transcript preamble has been sent on this ACP session. */
  primed: boolean
  /** The currently starting or prompting turn, owned by this record. */
  turn: Fiber.Fiber<void, never> | null
  /** Cancellation owns the turn while its best-effort ACP notification runs. */
  cancelling: boolean
  /** Completion time used for idle expiry and least-recently-idle eviction. */
  idleSince: number | null
}

export type ChatReservation =
  | { readonly _tag: 'Busy' }
  | { readonly _tag: 'Full' }
  | {
      readonly _tag: 'Reserved'
      readonly record: ChatRecord
      readonly generation: number
    }

export type ChatCancellation =
  | { readonly _tag: 'Inactive', readonly status: ChatStatus }
  | {
      readonly _tag: 'Claimed'
      readonly record: ChatRecord
      readonly generation: number
      readonly turn: Fiber.Fiber<void, never> | null
    }

export const CHAT_RECORD_CAPACITY = 10
const CHAT_IDLE_TTL_MILLIS = 30 * 60 * 1_000
const MAX_EVENTS = 4_000
const TRIM_EVENTS = 1_000

export function appendChatEvent(record: ChatRecord, event: ChatEvent): void {
  record.events.push(event)
  if (record.events.length > MAX_EVENTS) {
    record.events.splice(0, TRIM_EVENTS)
    record.base += TRIM_EVENTS
  }
}

const closeChatRecord = Effect.fn('closeChatRecord')(function*(record: ChatRecord) {
  record.generation += 1
  if (record.turn) yield* Fiber.interrupt(record.turn)
  record.turn = null
  record.cancelling = false
  record.status = 'idle'
  const scope = record.scope
  record.scope = null
  record.connection = null
  record.sessionId = null
  record.primed = false
  if (scope) yield* Scope.close(scope, Exit.void)
})

/** Live chats keyed by `${project}\0${key}`, scoped to the provided Layer. */
export class ChatStore extends Context.Service<ChatStore, {
  readonly get: (chatKey: string) => Effect.Effect<ChatRecord | undefined>
  readonly reserve: (
    chatKey: string,
    agent: ChatAgentId,
    text: string,
  ) => Effect.Effect<ChatReservation>
  readonly attach: (
    chatKey: string,
    record: ChatRecord,
    generation: number,
    turn: Fiber.Fiber<void, never>,
  ) => Effect.Effect<boolean>
  readonly settle: (
    chatKey: string,
    record: ChatRecord,
    generation: number,
  ) => Effect.Effect<void>
  readonly claimCancellation: (chatKey: string) => Effect.Effect<ChatCancellation>
  readonly remove: (chatKey: string) => Effect.Effect<ChatRecord | undefined>
}>()('lcc/ChatStore') {
  static readonly layer = Layer.effect(
    ChatStore,
    Effect.gen(function*() {
      const records = new Map<string, ChatRecord>()
      const takeEvictable = (now: number, maximumSize: number): ChatRecord[] => {
        const evicted: ChatRecord[] = []
        for (const [key, record] of records) {
          if (
            record.idleSince !== null
            && now - record.idleSince >= CHAT_IDLE_TTL_MILLIS
          ) {
            records.delete(key)
            evicted.push(record)
          }
        }
        if (records.size > maximumSize) {
          const idle = [...records.entries()]
            .filter((entry): entry is [string, ChatRecord & { idleSince: number }] =>
              entry[1].idleSince !== null,
            )
            .sort((left, right) => left[1].idleSince - right[1].idleSince)
          for (const [key, record] of idle) {
            if (records.size <= maximumSize) break
            records.delete(key)
            evicted.push(record)
          }
        }
        return evicted
      }
      const closeEvicted = (records: ReadonlyArray<ChatRecord>) => Effect.uninterruptible(
        Effect.forEach(records, closeChatRecord, { discard: true }),
      )
      yield* Effect.addFinalizer(() => Effect.forEach(
        records.values(),
        closeChatRecord,
        { discard: true },
      ))
      return ChatStore.of({
        get: chatKey => Effect.uninterruptible(Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          const { record, evicted } = yield* Effect.sync(() => {
            const evicted = takeEvictable(now, CHAT_RECORD_CAPACITY)
            return { record: records.get(chatKey), evicted }
          })
          yield* closeEvicted(evicted)
          return record
        })),
        reserve: (chatKey, agent, text) => Effect.uninterruptible(Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          const { reservation, evicted } = yield* Effect.sync(() => {
            const exists = records.has(chatKey)
            const evicted = takeEvictable(
              now,
              exists ? CHAT_RECORD_CAPACITY : CHAT_RECORD_CAPACITY - 1,
            )
            let record = records.get(chatKey)
            if (
              record
              && (
                record.cancelling
                || record.status === 'busy'
                || record.status === 'starting'
              )
            ) {
              return {
                reservation: { _tag: 'Busy' } as const,
                evicted,
              }
            }
            if (!record && records.size >= CHAT_RECORD_CAPACITY) {
              return {
                reservation: { _tag: 'Full' } as const,
                evicted,
              }
            }
            if (!record) {
              record = {
                agent,
                status: 'idle',
                revision: 1,
                generation: 0,
                base: 0,
                events: [],
                scope: null,
                connection: null,
                sessionId: null,
                primed: false,
                turn: null,
                cancelling: false,
                idleSince: now,
              }
              records.set(chatKey, record)
            } else if (record.agent !== agent) {
              record.agent = agent
              record.connection = null
              record.sessionId = null
              record.primed = false
            }
            record.generation += 1
            record.idleSince = null
            appendChatEvent(record, { kind: 'user', text })
            record.status = record.connection ? 'busy' : 'starting'
            return {
              reservation: {
                _tag: 'Reserved',
                record,
                generation: record.generation,
              } as const,
              evicted,
            }
          })
          yield* closeEvicted(evicted)
          return reservation
        })),
        attach: (chatKey, record, generation, turn) => Effect.sync(() => {
          if (records.get(chatKey) !== record || record.generation !== generation) return false
          record.turn = turn
          return true
        }),
        settle: (chatKey, record, generation) => Effect.uninterruptible(Effect.gen(function*() {
          const now = yield* Clock.currentTimeMillis
          const evicted = yield* Effect.sync(() => {
            if (records.get(chatKey) === record && record.generation === generation) {
              record.turn = null
              record.cancelling = false
              record.idleSince = now
            }
            return takeEvictable(now, CHAT_RECORD_CAPACITY)
          })
          yield* closeEvicted(evicted)
        })),
        claimCancellation: chatKey => Effect.sync(() => {
          const record = records.get(chatKey)
          if (
            !record
            || (record.status !== 'busy' && record.status !== 'starting')
            || record.cancelling
          ) {
            return {
              _tag: 'Inactive',
              status: record?.status ?? 'idle',
            } as const
          }
          const turn = record.turn
          record.cancelling = true
          record.generation += 1
          return {
            _tag: 'Claimed',
            record,
            generation: record.generation,
            turn,
          } as const
        }),
        remove: chatKey => Effect.uninterruptible(Effect.gen(function*() {
          const record = yield* Effect.sync(() => {
            const record = records.get(chatKey)
            records.delete(chatKey)
            return record
          })
          if (record) yield* closeChatRecord(record)
          return record
        })),
      })
    }),
  )
}
