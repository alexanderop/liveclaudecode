import { Context, Deferred, Effect, Layer, Queue, Result, Schema, Stream } from 'effect'
import type { Scope } from 'effect'
import { Ndjson } from 'effect/unstable/encoding'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import {
  parseInboundMessage,
  parsePermissionRequest,
  parseSessionNotification,
  type PermissionRequest,
  type SessionNotification,
} from '#shared/schemas/acp'

/** The agent process failed, spoke garbage, or went away mid-request. */
export class AcpAgentError extends Schema.TaggedErrorClass<AcpAgentError>()(
  'AcpAgentError',
  { reason: Schema.String },
) {
  override get message(): string {
    return `Agent error: ${this.reason}`
  }
}

export interface AcpConnectionOptions {
  command: string
  args: ReadonlyArray<string>
  env: Record<string, string>
  cwd: string
  /**
   * Decides `session/request_permission` calls. The connection answers with
   * the matching `allow_*`/`reject_*` option immediately, so a permission
   * request can never be left pending across a cancellation.
   */
  permission: (request: PermissionRequest) => 'allow' | 'reject'
}

export interface AcpConnection {
  readonly request: (method: string, params: unknown) => Effect.Effect<unknown, AcpAgentError>
  readonly notify: (method: string, params: unknown) => Effect.Effect<void, AcpAgentError>
  /**
   * Every `session/update` notification, in arrival order. The reader fiber
   * only enqueues — it never waits on a consumer — so a slow handler cannot
   * stall protocol dispatch (permission requests, request/response
   * correlation). One connection has one logical consumer, so this is backed
   * by a `Queue` rather than a `PubSub`.
   */
  readonly updates: Stream.Stream<SessionNotification>
}

interface OutboundMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number, message: string }
}

function permissionOutcome(
  request: PermissionRequest,
  decision: 'allow' | 'reject',
): { outcome: { outcome: 'selected', optionId: string } | { outcome: 'cancelled' } } {
  const kinds = decision === 'allow'
    ? ['allow_once', 'allow_always']
    : ['reject_once', 'reject_always']
  for (const kind of kinds) {
    const option = request.options.find(option => option.kind === kind)
    if (option) return { outcome: { outcome: 'selected', optionId: option.optionId } }
  }
  return { outcome: { outcome: 'cancelled' } }
}

/**
 * Spawns ACP agent subprocesses and speaks newline-delimited JSON-RPC 2.0
 * over their stdio. One connection per agent process; the process dies with
 * the connection's `Scope`.
 */
export class AcpConnector extends Context.Service<AcpConnector, {
  readonly connect: (
    options: AcpConnectionOptions,
  ) => Effect.Effect<AcpConnection, AcpAgentError, Scope.Scope>
}>()('lcc/AcpConnector') {
  static readonly layer = Layer.effect(
    AcpConnector,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      const connect = Effect.fn('AcpConnector.connect')(function*(options: AcpConnectionOptions) {
        const handle = yield* spawner.spawn(
          ChildProcess.make(options.command, options.args, {
            cwd: options.cwd,
            env: options.env,
            extendEnv: true,
            stderr: 'inherit',
          }),
        ).pipe(Effect.mapError(cause => new AcpAgentError({ reason: `spawn failed: ${cause.message}` })))

        const outbox = yield* Queue.make<OutboundMessage>()
        const updates = yield* Queue.make<SessionNotification>()
        yield* Effect.addFinalizer(() => Queue.shutdown(updates))
        const pending = new Map<string, Deferred.Deferred<unknown, AcpAgentError>>()
        let nextId = 1
        let dead: AcpAgentError | null = null

        const failAll = (error: AcpAgentError) => Effect.gen(function*() {
          dead = error
          const waiting = [...pending.values()]
          pending.clear()
          yield* Effect.forEach(waiting, deferred => Deferred.fail(deferred, error))
        })

        const send = (message: OutboundMessage) => Queue.offer(outbox, message)

        const respondPermission = Effect.fn('AcpConnector.respondPermission')(function*(
          id: number | string,
          params: unknown,
        ) {
          const parsed = parsePermissionRequest(params)
          const result = Result.isSuccess(parsed)
            ? permissionOutcome(parsed.success, options.permission(parsed.success))
            : { outcome: { outcome: 'cancelled' as const } }
          yield* send({ jsonrpc: '2.0', id, result })
        })

        const dispatch = Effect.fn('AcpConnector.dispatch')(function*(line: unknown) {
          const parsed = parseInboundMessage(line)
          if (Result.isFailure(parsed)) {
            yield* Effect.logDebug('ACP: dropped unparseable inbound line', {
              line,
              error: parsed.failure,
            })
            return
          }
          const message = parsed.success

          // Agent-initiated request: answer it, or the agent hangs forever.
          if (message.method !== undefined && message.id !== undefined) {
            if (message.method === 'session/request_permission') {
              yield* respondPermission(message.id, message.params)
            } else {
              yield* send({
                jsonrpc: '2.0',
                id: message.id,
                error: { code: -32601, message: 'Method not found' },
              })
            }
            return
          }

          // Notification.
          if (message.method !== undefined) {
            if (message.method === 'session/update') {
              const notification = parseSessionNotification(message.params)
              if (Result.isSuccess(notification)) yield* Queue.offer(updates, notification.success)
            }
            return
          }

          // Response to one of our requests. Agents may echo numeric ids as
          // strings, so the pending map is keyed by the string spelling.
          if (message.id === undefined) return
          const deferred = pending.get(String(message.id))
          if (!deferred) return
          pending.delete(String(message.id))
          if (message.error !== undefined) {
            yield* Deferred.fail(deferred, new AcpAgentError({
              reason: message.error.message ?? `agent returned error ${message.error.code ?? ''}`.trim(),
            }))
          } else {
            yield* Deferred.succeed(deferred, message.result)
          }
        })

        // Writer: serialize outbound messages onto the agent's stdin.
        yield* Effect.forkScoped(
          Stream.fromQueue(outbox).pipe(
            Stream.pipeThroughChannel(Ndjson.encode()),
            Stream.run(handle.stdin),
            Effect.catch(cause => failAll(new AcpAgentError({ reason: `stdin closed: ${String(cause)}` }))),
          ),
        )

        // Reader: decode stdout lines and dispatch until the process exits.
        yield* Effect.forkScoped(
          handle.stdout.pipe(
            Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
            Stream.runForEach(dispatch),
            Effect.flatMap(() => failAll(new AcpAgentError({ reason: 'agent exited' }))),
            Effect.catch(cause => failAll(new AcpAgentError({ reason: `agent stream failed: ${String(cause)}` }))),
          ),
        )

        const request = Effect.fn('AcpConnector.request')(function*(method: string, params: unknown) {
          if (dead) return yield* Effect.fail(dead)
          const id = nextId++
          const deferred = yield* Deferred.make<unknown, AcpAgentError>()
          pending.set(String(id), deferred)
          yield* send({ jsonrpc: '2.0', id, method, params })
          return yield* Deferred.await(deferred)
        })

        const notify = Effect.fn('AcpConnector.notify')(function*(method: string, params: unknown) {
          if (dead) return yield* Effect.fail(dead)
          yield* send({ jsonrpc: '2.0', method, params })
        })

        return { request, notify, updates: Stream.fromQueue(updates) } satisfies AcpConnection
      })

      return AcpConnector.of({ connect })
    }),
  )
}
