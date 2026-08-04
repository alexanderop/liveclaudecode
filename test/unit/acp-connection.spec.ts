import { assert, describe, it } from '@effect/vitest'
import { type Cause, Deferred, Effect, Fiber, Layer, Queue, Sink, Stream } from 'effect'
import * as PlatformError from 'effect/PlatformError'
import { ChildProcessSpawner } from 'effect/unstable/process'
import { AcpConnector } from '#server/utils/acp-connection'
import { makeCallLog, type CallLog } from '../fixtures/call-log'

const encoder = new TextEncoder()

function fakeSpawner(writes: CallLog<Record<string, unknown>>) {
  return Layer.unwrap(
    Effect.gen(function*() {
      const stdout = yield* Queue.make<Uint8Array>()
      let buffered = ''
      const decoder = new TextDecoder()

      const emit = (message: unknown) => Queue.offer(stdout, encoder.encode(`${JSON.stringify(message)}\n`))

      const receive = Effect.fn('fakeAcp.receive')(function*(chunk: Uint8Array) {
        buffered += decoder.decode(chunk, { stream: true })
        const lines = buffered.split('\n')
        buffered = lines.pop() ?? ''
        for (const line of lines) {
          if (!line) continue
          const message = JSON.parse(line) as Record<string, unknown>
          yield* writes.record(message)
          switch (message.method) {
            case 'initialize':
              yield* emit({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
              break
            case 'session/new':
              yield* emit({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'chat-session' } })
              break
            case 'session/prompt':
              yield* emit({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId: 'chat-session',
                  update: {
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: 'Answer' },
                  },
                },
              })
              yield* emit({
                jsonrpc: '2.0',
                id: 'agent-request-7',
                method: 'session/request_permission',
                params: {
                  sessionId: 'chat-session',
                  toolCall: { toolCallId: 'write-1', title: 'Edit file', kind: 'edit' },
                  options: [
                    { optionId: 'yes', kind: 'allow_once' },
                    { optionId: 'no', kind: 'reject_once' },
                  ],
                },
              })
              yield* emit({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
              break
          }
        }
      })

      // Only `spawn` is implemented: the connection has no business calling
      // `exitCode`, `lines`, or the streaming helpers, and a mock says so at
      // the call rather than quietly deriving them from this handle.
      return Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {
        spawn: () => Effect.succeed(ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(42),
          stdin: Sink.forEach(receive),
          stdout: Stream.fromQueue(stdout),
          stderr: Stream.empty,
          all: Stream.fromQueue(stdout),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        })),
      })
    }),
  )
}

/** Drives one fake agent's stdout from inside the test. */
interface AgentControls {
  /** Push one JSON-RPC message onto the agent's stdout. */
  readonly emit: (message: unknown) => Effect.Effect<void>
  /** Push a raw line, for lines that are not valid JSON-RPC at all. */
  readonly emitLine: (line: string) => Effect.Effect<void>
  /** End stdout, which is what the reader sees when the process exits. */
  readonly exit: Effect.Effect<void>
}

/**
 * A fake agent whose replies the test writes, rather than the fixed
 * happy-path script above. `onWrite` runs for each line the connection sends.
 */
function scriptedSpawner(options: {
  readonly writes?: CallLog<Record<string, unknown>>
  readonly onWrite?: (
    message: Record<string, unknown>,
    agent: AgentControls,
  ) => Effect.Effect<void>
  /** Fail every write, as a closed stdin pipe does. */
  readonly stdinFails?: boolean
}) {
  return Layer.unwrap(
    Effect.gen(function*() {
      // `Done` in the error channel is what lets the test end stdout the way
      // an exiting process does, rather than only failing it.
      const stdout = yield* Queue.make<Uint8Array, Cause.Done>()
      const decoder = new TextDecoder()
      let buffered = ''

      const controls: AgentControls = {
        emit: message => Effect.asVoid(
          Queue.offer(stdout, encoder.encode(`${JSON.stringify(message)}\n`)),
        ),
        emitLine: line => Effect.asVoid(Queue.offer(stdout, encoder.encode(`${line}\n`))),
        exit: Effect.asVoid(Queue.end(stdout)),
      }

      const receive = Effect.fn('scriptedAcp.receive')(function*(chunk: Uint8Array) {
        buffered += decoder.decode(chunk, { stream: true })
        const lines = buffered.split('\n')
        buffered = lines.pop() ?? ''
        for (const line of lines) {
          if (!line) continue
          const message = JSON.parse(line) as Record<string, unknown>
          if (options.writes) yield* options.writes.record(message)
          yield* options.onWrite?.(message, controls) ?? Effect.void
        }
      })

      return Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {
        spawn: () => Effect.succeed(ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(43),
          stdin: options.stdinFails
            ? Sink.forEach(() => Effect.fail(PlatformError.systemError({
                _tag: 'BadResource',
                module: 'Command',
                method: 'stdin',
                pathOrDescriptor: 'stdin',
              })))
            : Sink.forEach(receive),
          stdout: Stream.fromQueue(stdout),
          stderr: Stream.empty,
          all: Stream.fromQueue(stdout),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        })),
      })
    }),
  )
}

const connect = (permission: 'allow' | 'reject' = 'allow') =>
  Effect.flatMap(AcpConnector, connector => connector.connect({
    command: 'fake-acp',
    args: [],
    env: {},
    cwd: '/repo',
    permission: () => permission,
  }))

describe('ACP connection', () => {
  it.effect('multiplexes responses, updates, and agent permission requests over NDJSON', () =>
    Effect.gen(function*() {
      const writes = yield* makeCallLog<Record<string, unknown>>()
      const updates = yield* makeCallLog<string>()
      const layer = AcpConnector.layer.pipe(Layer.provide(fakeSpawner(writes)))

      yield* Effect.gen(function*() {
        const connector = yield* AcpConnector
        const connection = yield* connector.connect({
          command: 'fake-acp',
          args: [],
          env: {},
          cwd: '/repo',
          permission: () => 'reject',
        })
        // The connection no longer takes a callback — updates arrive on a
        // Stream fed by a Queue, so the test forks its own consumer, same as
        // the chat feature does.
        yield* Effect.forkScoped(Stream.runForEach(connection.updates, (notification) => {
          const update = notification.update
          if (update.kind !== 'known') return Effect.void
          if ('content' in update.data && typeof update.data.content.text === 'string') {
            return updates.record(update.data.content.text)
          }
          return Effect.void
        }))

        assert.deepStrictEqual(
          yield* connection.request('initialize', { protocolVersion: 1 }),
          { protocolVersion: 1 },
        )
        assert.deepStrictEqual(
          yield* connection.request('session/new', { cwd: '/repo', mcpServers: [] }),
          { sessionId: 'chat-session' },
        )
        assert.deepStrictEqual(
          yield* connection.request('session/prompt', { sessionId: 'chat-session', prompt: [] }),
          { stopReason: 'end_turn' },
        )
        yield* Effect.yieldNow
        yield* Effect.yieldNow

        assert.deepStrictEqual(yield* updates.all, ['Answer'])
        assert.deepStrictEqual(
          (yield* writes.all).find(message => message.id === 'agent-request-7'),
          {
            jsonrpc: '2.0',
            id: 'agent-request-7',
            result: { outcome: { outcome: 'selected', optionId: 'no' } },
          },
        )
      }).pipe(Effect.scoped, Effect.provide(layer))
    }))

  it.effect('reports a spawn that never produced a process', () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(connect())
      assert.strictEqual(error._tag, 'AcpAgentError')
      assert.include(error.message, 'spawn failed')
    }).pipe(
      Effect.scoped,
      Effect.provide(AcpConnector.layer.pipe(Layer.provide(
        Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {
          spawn: () => Effect.fail(PlatformError.systemError({
            _tag: 'NotFound',
            module: 'Command',
            method: 'spawn',
            pathOrDescriptor: 'fake-acp',
          })),
        }),
      ))),
    ))

  it.effect('fails the in-flight request when the agent exits, and every request after it', () =>
    Effect.gen(function*() {
      const connection = yield* connect()

      const inFlight = yield* Effect.flip(connection.request('initialize', {}))
      assert.strictEqual(inFlight.message, 'Agent error: agent exited')

      // The connection is dead: a later request short-circuits rather than
      // enqueueing a message nothing will ever answer.
      const afterwards = yield* Effect.flip(connection.request('session/new', {}))
      assert.strictEqual(afterwards.message, 'Agent error: agent exited')
      const notified = yield* Effect.flip(connection.notify('session/cancel', {}))
      assert.strictEqual(notified.message, 'Agent error: agent exited')
    }).pipe(
      Effect.scoped,
      Effect.provide(AcpConnector.layer.pipe(Layer.provide(scriptedSpawner({
        onWrite: (_message, agent) => agent.exit,
      })))),
    ))

  it.effect('fails a pending request when the agent stdin pipe breaks', () =>
    Effect.gen(function*() {
      const connection = yield* connect()
      const error = yield* Effect.flip(connection.request('initialize', {}))
      assert.include(error.message, 'stdin closed')
    }).pipe(
      Effect.scoped,
      Effect.provide(AcpConnector.layer.pipe(Layer.provide(scriptedSpawner({ stdinFails: true })))),
    ))

  it.effect('surfaces a JSON-RPC error response as a typed failure', () =>
    Effect.gen(function*() {
      const connection = yield* connect()

      const described = yield* Effect.flip(connection.request('session/new', {}))
      assert.strictEqual(described.message, 'Agent error: no workspace trust')

      // An error object with only a code still has to say something.
      const bare = yield* Effect.flip(connection.request('session/prompt', {}))
      assert.strictEqual(bare.message, 'Agent error: agent returned error -32000')
    }).pipe(
      Effect.scoped,
      Effect.provide(AcpConnector.layer.pipe(Layer.provide(scriptedSpawner({
        onWrite: (message, agent) => message.method === 'session/new'
          ? agent.emit({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32001, message: 'no workspace trust' },
            })
          : agent.emit({ jsonrpc: '2.0', id: message.id, error: { code: -32000 } }),
      })))),
    ))

  it.effect('answers an agent request it does not implement with method-not-found', () =>
    Effect.gen(function*() {
      // The agent never answers `initialize`; the assertion is on what the
      // connection writes back unprompted, so wait for that write itself
      // rather than for a fixed number of scheduler turns.
      const answered = yield* Deferred.make<Record<string, unknown>>()
      const connection = yield* Effect.provide(
        connect(),
        AcpConnector.layer.pipe(Layer.provide(scriptedSpawner({
          onWrite: (message, agent) => message.method === 'initialize'
            ? agent.emit({ jsonrpc: '2.0', id: 'agent-1', method: 'fs/read_text_file', params: {} })
            : Effect.asVoid(Deferred.succeed(answered, message)),
        }))),
      )

      yield* Effect.forkScoped(connection.request('initialize', {}))

      assert.deepStrictEqual(yield* Deferred.await(answered), {
        jsonrpc: '2.0',
        id: 'agent-1',
        error: { code: -32601, message: 'Method not found' },
      })
    }).pipe(Effect.scoped))

  it.effect('cancels a permission request it cannot answer with a matching option', () =>
    Effect.gen(function*() {
      const answers = yield* Queue.make<Record<string, unknown>>()
      const connection = yield* Effect.provide(
        connect('allow'),
        AcpConnector.layer.pipe(Layer.provide(scriptedSpawner({
          onWrite: (message, agent) => Effect.gen(function*() {
            if (message.method !== 'initialize') {
              yield* Queue.offer(answers, message)
              return
            }
            // No `allow_*` option exists, so the decided outcome names nothing.
            yield* agent.emit({
              jsonrpc: '2.0',
              id: 'no-option',
              method: 'session/request_permission',
              params: {
                sessionId: 'chat-session',
                options: [{ optionId: 'no', kind: 'reject_once' }],
              },
            })
            // Params that do not decode at all are answered the same way,
            // rather than left pending until the agent gives up.
            yield* agent.emit({
              jsonrpc: '2.0',
              id: 'unparseable',
              method: 'session/request_permission',
              params: { options: 'not a list' },
            })
          }),
        }))),
      )

      yield* Effect.forkScoped(connection.request('initialize', {}))

      const cancelled = { outcome: { outcome: 'cancelled' } }
      assert.deepStrictEqual(yield* Queue.take(answers), {
        jsonrpc: '2.0',
        id: 'no-option',
        result: cancelled,
      })
      assert.deepStrictEqual(yield* Queue.take(answers), {
        jsonrpc: '2.0',
        id: 'unparseable',
        result: cancelled,
      })
    }).pipe(Effect.scoped))

  it.effect('drops JSON lines it cannot use and keeps serving the request behind them', () =>
    Effect.gen(function*() {
      const connection = yield* connect()
      const delivered = yield* Effect.forkScoped(
        Stream.runCollect(Stream.take(connection.updates, 1)),
      )

      assert.deepStrictEqual(yield* connection.request('initialize', {}), { protocolVersion: 1 })

      // The malformed `agent_message_chunk` never reached the queue, so the
      // first notification a consumer sees is the one behind it.
      const updates = yield* Fiber.join(delivered)
      assert.deepStrictEqual([...updates].map(update => update.update.kind), ['unknown'])
    }).pipe(
      Effect.scoped,
      Effect.provide(AcpConnector.layer.pipe(Layer.provide(scriptedSpawner({
        onWrite: (message, agent) => Effect.gen(function*() {
          yield* agent.emit({ jsonrpc: '2.0', method: 42 })
          yield* agent.emit({
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionId: 'chat-session', update: { sessionUpdate: 'agent_message_chunk', content: 7 } },
          })
          yield* agent.emit({
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionId: 'chat-session', update: { sessionUpdate: 'plan' } },
          })
          // A response to an id nobody is waiting on is ignored, not fatal.
          yield* agent.emit({ jsonrpc: '2.0', id: 'nobody', result: {} })
          yield* agent.emit({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })
        }),
      })))),
    ))

  it.effect('fails the connection when the agent writes a line that is not JSON at all', () =>
    Effect.gen(function*() {
      // Unlike a JSON line of the wrong shape, this breaks the NDJSON framing
      // itself, so the reader cannot resynchronise and the connection dies.
      const connection = yield* connect()
      const error = yield* Effect.flip(connection.request('initialize', {}))
      assert.include(error.message, 'agent stream failed')
    }).pipe(
      Effect.scoped,
      Effect.provide(AcpConnector.layer.pipe(Layer.provide(scriptedSpawner({
        onWrite: (_message, agent) => agent.emitLine('{"truncated'),
      })))),
    ))
})
