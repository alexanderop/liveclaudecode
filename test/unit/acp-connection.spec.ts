import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer, Queue, Sink, Stream } from 'effect'
import { ChildProcessSpawner } from 'effect/unstable/process'
import { AcpConnector } from '#server/utils/acp-connection'

const encoder = new TextEncoder()

function fakeSpawner(writes: Array<Record<string, unknown>>) {
  return Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
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
          writes.push(message)
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

      return ChildProcessSpawner.make(() => Effect.succeed(ChildProcessSpawner.makeHandle({
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
      })))
    }),
  )
}

describe('ACP connection', () => {
  it.effect('multiplexes responses, updates, and agent permission requests over NDJSON', () => {
    const writes: Array<Record<string, unknown>> = []
    const layer = AcpConnector.layer.pipe(Layer.provide(fakeSpawner(writes)))

    return Effect.gen(function*() {
      const connector = yield* AcpConnector
      const updates: string[] = []
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
      yield* Effect.forkScoped(Stream.runForEach(connection.updates, notification => Effect.sync(() => {
        const update = notification.update
        if (update.kind !== 'known') return
        if ('content' in update.data && typeof update.data.content.text === 'string') {
          updates.push(update.data.content.text)
        }
      })))

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

      assert.deepStrictEqual(updates, ['Answer'])
      assert.deepStrictEqual(
        writes.find(message => message.id === 'agent-request-7'),
        {
          jsonrpc: '2.0',
          id: 'agent-request-7',
          result: { outcome: { outcome: 'selected', optionId: 'no' } },
        },
      )
    }).pipe(Effect.scoped, Effect.provide(layer))
  })
})
