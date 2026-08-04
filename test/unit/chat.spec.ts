import { assert, describe, it } from '@effect/vitest'
import { ConfigProvider, Deferred, Effect, Fiber, Layer, Queue, Result, Scope, Stream } from 'effect'
import { TestClock } from 'effect/testing'
import { AcpConnector, type AcpConnectionOptions } from '#server/utils/acp-connection'
import type { SessionNotification } from '#shared/schemas/acp'
import {
  ChatAgentCommands,
  cancelChat,
  layerChatAgentCommands,
  pollChatEvents,
  resetChat,
  sendChatMessage,
} from '#server/utils/chat'
import { ChatStore } from '#server/utils/chat-store'
import { parseChatAction } from '#shared/schemas/chat'
import type { ChatEvent } from '#shared/types/chat'
import { SessionCatalogCache, SessionLocatorCache } from '#server/utils/session-catalog'
import {
  CodexScanCache,
  CodexSessionsDirectory,
  CopilotScanCache,
  ProjectsDirectory,
  PromptCache,
  ScanCache,
  WorkingDirectory,
  VsCodeUserDataDirectories,
} from '#server/utils/services'
import * as codex from '../fixtures/codex'
import { testFileSystem } from '../fixtures/filesystem'

const CODEX = '/codex/sessions'
const TRANSCRIPT = `${CODEX}/2026/07/28/rollout-chat-run.jsonl`

function chatLayer(
  prompts: unknown[],
  connections: AcpConnectionOptions[] = [],
  connectorOverride?: AcpConnector['Service'],
) {
  const connector = connectorOverride ?? AcpConnector.of({
    connect: (options: AcpConnectionOptions) => Effect.gen(function*() {
      connections.push(options)
      // Mirrors the real connector: updates are queued, not delivered via a
      // direct callback, so a consumer forked onto the stream sees them.
      const updates = yield* Queue.make<SessionNotification>()
      yield* Effect.addFinalizer(() => Queue.shutdown(updates))
      return {
        request: (method, params) => Effect.gen(function*() {
          if (method === 'initialize') return { protocolVersion: 1 }
          if (method === 'session/new') return { sessionId: 'answer-session' }
          if (method === 'session/prompt') {
            prompts.push(params)
            if (options.command === 'copilot') {
              yield* Queue.offer(updates, {
                sessionId: 'answer-session',
                update: {
                  kind: 'known',
                  data: {
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: 'Info: Disabled tools: apply_patch, bash, edit' },
                  },
                },
              })
            }
            yield* Queue.offer(updates, {
              sessionId: 'answer-session',
              update: {
                kind: 'known',
                data: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'The tests failed in setup.' },
                },
              },
            })
            // Give the forked stream consumer a turn to drain the queue
            // before the prompt "response" unblocks the caller, so the
            // resulting event order is deterministic for the assertions
            // below (production has the same queue-then-consume shape, just
            // spread across real I/O instead of a synchronous mock).
            yield* Effect.yieldNow
            yield* Effect.yieldNow
            return { stopReason: 'end_turn' }
          }
          return {}
        }),
        notify: () => Effect.void,
        updates: Stream.fromQueue(updates),
      }
    }),
  })

  return Layer.mergeAll(
    SessionCatalogCache.layer,
    ScanCache.layer,
    CodexScanCache.layer,
    CopilotScanCache.layer,
    SessionLocatorCache.layer,
    PromptCache.layer,
    ChatStore.layer,
    Layer.succeed(AcpConnector)(connector),
    Layer.succeed(ChatAgentCommands)({
      claude: { command: 'claude-agent-acp', args: [], env: {} },
      codex: { command: 'codex-acp', args: [], env: { INITIAL_AGENT_MODE: 'agent-full-access' } },
      copilot: {
        command: 'copilot',
        args: ['--acp', '--stdio', '--allow-all'],
        env: {},
      },
    }),
    Layer.succeed(ProjectsDirectory)('/claude/projects'),
    Layer.succeed(CodexSessionsDirectory)(CODEX),
    Layer.succeed(VsCodeUserDataDirectories)([]),
    Layer.succeed(WorkingDirectory)('/repo'),
  ).pipe(Layer.provideMerge(testFileSystem({
    '/repo/.keep': '',
    [TRANSCRIPT]: codex.rollout([
      codex.sessionMeta('chat-run', { cwd: '/repo' }),
      codex.message('user', 'Run the tests'),
    ]),
  })))
}

/**
 * Resolve the agent launchers against `settings` alone. Replacing the provider
 * rather than stubbing `process.env` keeps the case deterministic on a machine
 * that happens to export `LCC_ACP_*`.
 */
const withAgentSettings = (settings: Record<string, string>) =>
  layerChatAgentCommands.pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(settings))),
  )

const isTurnEnd = (event: ChatEvent): event is Extract<ChatEvent, { kind: 'turn-end' }> =>
  event.kind === 'turn-end'

const waitForIdle = Effect.fn('waitForIdle')(function*(project: string, key: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    yield* Effect.yieldNow
    const response = yield* pollChatEvents(project, key, 0, 0)
    if (response.status === 'idle') return response
  }
  return yield* Effect.die('chat turn did not finish')
})

describe('session chat', () => {
  it.effect('launches vetted agent commands with full permissions when nothing overrides them', () =>
    Effect.gen(function*() {
      const commands = yield* ChatAgentCommands
      assert.deepStrictEqual(commands.codex, {
        command: 'npx',
        args: ['-y', '@agentclientprotocol/codex-acp'],
        env: { INITIAL_AGENT_MODE: 'agent-full-access', NO_BROWSER: '1' },
      })
      assert.deepStrictEqual(commands.copilot, {
        command: 'copilot',
        args: ['--acp', '--stdio', '--allow-all'],
        env: {},
      })
    }).pipe(Effect.provide(withAgentSettings({}))))

  it.effect('takes a whitespace-separated command line from the environment', () =>
    Effect.gen(function*() {
      const commands = yield* ChatAgentCommands
      assert.deepStrictEqual(commands.copilot, {
        command: '/opt/copilot',
        args: ['--acp', '--stdio'],
        env: {},
      })
      // A blank override is not an override; the vetted launcher stands.
      assert.strictEqual(commands.claude.command, 'npx')
    }).pipe(Effect.provide(withAgentSettings({
      LCC_ACP_COPILOT: '/opt/copilot --acp --stdio',
      LCC_ACP_CLAUDE: '   ',
    }))))

  it('accepts Copilot but not an unknown agent in chat actions', () => {
    assert.isTrue(Result.isSuccess(parseChatAction({
      action: 'send',
      project: '/repo',
      key: 'codex:chat-run',
      agent: 'copilot',
      text: 'What happened?',
    })))
    assert.isTrue(Result.isFailure(parseChatAction({
      action: 'send',
      project: '/repo',
      key: 'codex:chat-run',
      agent: 'unknown',
      text: 'What happened?',
    })))
  })

  it.effect('keeps one ACP session for follow-ups and sends transcript context only once', () => {
    const prompts: unknown[] = []
    return Effect.gen(function*() {
      yield* sendChatMessage('', 999_999, '/repo', 'codex:chat-run', 'codex', 'Why did it fail?')
      const first = yield* waitForIdle('/repo', 'codex:chat-run')

      assert.strictEqual(first.agent, 'codex')
      assert.deepStrictEqual(first.events.map(event => event.kind), [
        'user',
        'assistant-chunk',
        'turn-end',
      ])

      yield* sendChatMessage('', 999_999, '/repo', 'codex:chat-run', 'codex', 'What should I fix?')
      const second = yield* waitForIdle('/repo', 'codex:chat-run')

      assert.strictEqual(prompts.length, 2)
      const firstPrompt = prompts[0] as { prompt: Array<{ type: string, text: string }> }
      const secondPrompt = prompts[1] as { prompt: Array<{ type: string, text: string }> }
      assert.strictEqual(firstPrompt.prompt.length, 2)
      assert.isTrue(firstPrompt.prompt[0]!.text.includes(TRANSCRIPT))
      assert.deepStrictEqual(secondPrompt.prompt, [{ type: 'text', text: 'What should I fix?' }])
      assert.strictEqual(second.events.filter(isTurnEnd).length, 2)
    }).pipe(Effect.provide(chatLayer(prompts)))
  })

  it.effect('cancels a new reservation while admission waits for eviction cleanup', () => {
    const prompts: unknown[] = []
    const connections: AcpConnectionOptions[] = []
    return Effect.gen(function*() {
      const store = yield* ChatStore
      const cleanupStarted = yield* Deferred.make<void>()
      const releaseCleanup = yield* Deferred.make<void>()

      for (let index = 0; index < 10; index += 1) {
        yield* TestClock.setTime(index)
        const key = `retained-${index}`
        const reservation = yield* store.reserve(key, 'codex', 'Hello')
        assert.strictEqual(reservation._tag, 'Reserved')
        if (reservation._tag !== 'Reserved') continue
        if (index === 0) {
          const scope = yield* Scope.make()
          yield* Scope.addFinalizer(scope, Effect.gen(function*() {
            yield* Deferred.succeed(cleanupStarted, undefined)
            yield* Deferred.await(releaseCleanup)
          }))
          reservation.record.scope = scope
        }
        reservation.record.status = 'idle'
        yield* store.settle(key, reservation.record, reservation.generation)
      }

      const sending = yield* Effect.forkChild(
        sendChatMessage('', 999_999, '/repo', 'codex:chat-run', 'codex', 'Do not start'),
      )
      yield* Deferred.await(cleanupStarted)
      const cancelled = yield* cancelChat('/repo', 'codex:chat-run')
      assert.strictEqual(cancelled.status, 'idle')

      yield* Deferred.succeed(releaseCleanup, undefined)
      const sendResult = yield* Fiber.join(sending)
      assert.strictEqual(sendResult.status, 'idle')
      assert.strictEqual(connections.length, 0)
      assert.strictEqual(prompts.length, 0)
      const response = yield* pollChatEvents('/repo', 'codex:chat-run', 0, 0)
      assert.deepStrictEqual(response.events.map(event => event.kind), ['user', 'turn-end'])
    }).pipe(Effect.provide(chatLayer(prompts, connections)))
  })

  it.effect('launches Copilot CLI and attributes its streamed answer to Copilot', () => {
    const prompts: unknown[] = []
    const connections: AcpConnectionOptions[] = []
    return Effect.gen(function*() {
      yield* sendChatMessage('', 999_999, '/repo', 'codex:chat-run', 'copilot', 'Summarize this run')
      const response = yield* waitForIdle('/repo', 'codex:chat-run')

      assert.strictEqual(response.agent, 'copilot')
      assert.deepStrictEqual(connections.map(({ command, args, env, cwd }) => ({
        command,
        args,
        env,
        cwd,
      })), [{
        command: 'copilot',
        args: ['--acp', '--stdio', '--allow-all'],
        env: {},
        cwd: '/repo',
      }])
      assert.deepStrictEqual(response.events[1], {
        kind: 'assistant-chunk',
        agent: 'copilot',
        text: 'The tests failed in setup.',
      })
      assert.strictEqual(connections[0]!.permission({
        sessionId: 'answer-session',
        toolCall: { toolCallId: 'edit-1', title: 'Edit file', kind: 'edit' },
        options: [
          { optionId: 'yes', kind: 'allow_once' },
          { optionId: 'no', kind: 'reject_once' },
        ],
      }), 'allow')
    }).pipe(Effect.provide(chatLayer(prompts, connections)))
  })

  it.effect('atomically rejects one of two concurrent sends', () => {
    const prompts: unknown[] = []
    let promptStarted!: Deferred.Deferred<void>
    let releasePrompt!: Deferred.Deferred<void>
    const connector = AcpConnector.of({
      connect: () => Effect.succeed({
        request: (method, params) => Effect.gen(function*() {
          if (method === 'initialize') return { protocolVersion: 1 }
          if (method === 'session/new') return { sessionId: 'concurrent-session' }
          if (method === 'session/prompt') {
            prompts.push(params)
            yield* Deferred.succeed(promptStarted, undefined)
            yield* Deferred.await(releasePrompt)
            return { stopReason: 'end_turn' }
          }
          return {}
        }),
        notify: () => Effect.void,
        updates: Stream.empty,
      }),
    })
    return Effect.gen(function*() {
      promptStarted = yield* Deferred.make<void>()
      releasePrompt = yield* Deferred.make<void>()

      const sends = yield* Effect.all([
        Effect.result(sendChatMessage('', 999_999, '/repo', 'codex:chat-run', 'codex', 'First')),
        Effect.result(sendChatMessage('', 999_999, '/repo', 'codex:chat-run', 'codex', 'Second')),
      ], { concurrency: 2 })
      yield* Deferred.await(promptStarted)

      assert.strictEqual(sends.filter(Result.isSuccess).length, 1)
      const rejected = sends.find(Result.isFailure)
      assert.isTrue(Result.isFailure(rejected!))
      if (Result.isFailure(rejected!)) assert.strictEqual(rejected.failure._tag, 'ChatBusy')

      yield* Deferred.succeed(releasePrompt, undefined)
      const response = yield* waitForIdle('/repo', 'codex:chat-run')
      assert.strictEqual(response.events.filter(event => event.kind === 'user').length, 1)
      assert.strictEqual(prompts.length, 1)
    }).pipe(Effect.provide(chatLayer(prompts, [], connector)))
  })

  it.effect('interrupts a starting turn before resetting its chat', () => {
    let interrupted = false
    let connectStarted!: Deferred.Deferred<void>
    const connector = AcpConnector.of({
      connect: () => Effect.gen(function*() {
        yield* Deferred.succeed(connectStarted, undefined)
        return yield* Effect.never
      }).pipe(Effect.onInterrupt(() => Effect.sync(() => { interrupted = true }))),
    })
    return Effect.gen(function*() {
      connectStarted = yield* Deferred.make<void>()

      const accepted = yield* sendChatMessage(
        '',
        999_999,
        '/repo',
        'codex:chat-run',
        'codex',
        'Start slowly',
      )
      assert.strictEqual(accepted.status, 'starting')
      yield* Deferred.await(connectStarted)

      const reset = yield* resetChat('/repo', 'codex:chat-run')
      assert.strictEqual(reset.status, 'idle')
      assert.isTrue(interrupted)

      const response = yield* pollChatEvents('/repo', 'codex:chat-run', 1, 1)
      assert.strictEqual(response.status, 'idle')
      assert.deepStrictEqual(response.events, [])
      assert.isTrue(response.reset)
    }).pipe(Effect.provide(chatLayer([], [], connector)))
  })

  it.effect('cancels and cleans up an agent that is still starting', () => {
    let interrupted = false
    let connectStarted!: Deferred.Deferred<void>
    const connector = AcpConnector.of({
      connect: () => Effect.gen(function*() {
        yield* Deferred.succeed(connectStarted, undefined)
        return yield* Effect.never
      }).pipe(Effect.onInterrupt(() => Effect.sync(() => { interrupted = true }))),
    })
    return Effect.gen(function*() {
      connectStarted = yield* Deferred.make<void>()

      yield* sendChatMessage('', 999_999, '/repo', 'codex:chat-run', 'codex', 'Start slowly')
      yield* Deferred.await(connectStarted)
      const cancelled = yield* cancelChat('/repo', 'codex:chat-run')

      assert.strictEqual(cancelled.status, 'idle')
      assert.isTrue(interrupted)
      const response = yield* pollChatEvents('/repo', 'codex:chat-run', 0, 0)
      assert.deepStrictEqual(response.events.map(event => event.kind), ['user', 'turn-end'])
      assert.strictEqual(
        response.events.find(isTurnEnd)?.stopReason,
        'cancelled',
      )
    }).pipe(Effect.provide(chatLayer([], [], connector)))
  })

  it.effect('claims concurrent cancellations only once', () => {
    let promptStarted!: Deferred.Deferred<void>
    let releasePrompt!: Deferred.Deferred<void>
    const connector = AcpConnector.of({
      connect: () => Effect.succeed({
        request: (method) => Effect.gen(function*() {
          if (method === 'initialize') return { protocolVersion: 1 }
          if (method === 'session/new') return { sessionId: 'cancel-session' }
          if (method === 'session/prompt') {
            yield* Deferred.succeed(promptStarted, undefined)
            yield* Deferred.await(releasePrompt)
            return { stopReason: 'end_turn' }
          }
          return {}
        }),
        notify: () => Effect.void,
        updates: Stream.empty,
      }),
    })
    return Effect.gen(function*() {
      promptStarted = yield* Deferred.make<void>()
      releasePrompt = yield* Deferred.make<void>()
      yield* sendChatMessage('', 999_999, '/repo', 'codex:chat-run', 'codex', 'Keep working')
      yield* Deferred.await(promptStarted)

      yield* Effect.all([
        cancelChat('/repo', 'codex:chat-run'),
        cancelChat('/repo', 'codex:chat-run'),
      ], { concurrency: 2 })

      const response = yield* pollChatEvents('/repo', 'codex:chat-run', 0, 0)
      const terminalEvents = response.events.filter(isTurnEnd)
      assert.strictEqual(terminalEvents.length, 1)
      assert.strictEqual(terminalEvents[0]!.stopReason, 'cancelled')
    }).pipe(Effect.provide(chatLayer([], [], connector)))
  })

  it.effect('suppresses prompt completion after cancellation is claimed', () => {
    let promptStarted!: Deferred.Deferred<void>
    let releasePrompt!: Deferred.Deferred<void>
    let cancelNotified!: Deferred.Deferred<void>
    let releaseCancel!: Deferred.Deferred<void>
    const connector = AcpConnector.of({
      connect: () => Effect.succeed({
        request: (method) => Effect.gen(function*() {
          if (method === 'initialize') return { protocolVersion: 1 }
          if (method === 'session/new') return { sessionId: 'cancel-race-session' }
          if (method === 'session/prompt') {
            yield* Deferred.succeed(promptStarted, undefined)
            yield* Deferred.await(releasePrompt)
            return { stopReason: 'end_turn' }
          }
          return {}
        }),
        notify: method => method === 'session/cancel'
          ? Effect.gen(function*() {
              yield* Deferred.succeed(cancelNotified, undefined)
              yield* Deferred.await(releaseCancel)
            })
          : Effect.void,
        updates: Stream.empty,
      }),
    })
    return Effect.gen(function*() {
      promptStarted = yield* Deferred.make<void>()
      releasePrompt = yield* Deferred.make<void>()
      cancelNotified = yield* Deferred.make<void>()
      releaseCancel = yield* Deferred.make<void>()
      yield* sendChatMessage('', 999_999, '/repo', 'codex:chat-run', 'codex', 'Keep working')
      yield* Deferred.await(promptStarted)

      const cancelling = yield* Effect.forkChild(cancelChat('/repo', 'codex:chat-run'))
      yield* Deferred.await(cancelNotified)
      yield* Deferred.succeed(releasePrompt, undefined)
      yield* Effect.yieldNow
      yield* Deferred.succeed(releaseCancel, undefined)
      yield* Fiber.join(cancelling)

      const response = yield* pollChatEvents('/repo', 'codex:chat-run', 0, 0)
      const terminalEvents = response.events.filter(isTurnEnd)
      assert.strictEqual(response.status, 'idle')
      assert.strictEqual(terminalEvents.length, 1)
      assert.strictEqual(terminalEvents[0]!.stopReason, 'cancelled')
    }).pipe(Effect.provide(chatLayer([], [], connector)))
  })

  it.effect('keeps a cancelling turn owned so concurrent reset can interrupt it', () => {
    let promptStarted!: Deferred.Deferred<void>
    let cancelNotified!: Deferred.Deferred<void>
    let releaseCancel!: Deferred.Deferred<void>
    let turnInterrupted = false
    const connector = AcpConnector.of({
      connect: () => Effect.succeed({
        request: method => {
          if (method === 'initialize') return Effect.succeed({ protocolVersion: 1 })
          if (method === 'session/new') return Effect.succeed({ sessionId: 'cancel-reset-session' })
          if (method === 'session/prompt') {
            return Effect.gen(function*() {
              yield* Deferred.succeed(promptStarted, undefined)
              return yield* Effect.never
            }).pipe(Effect.onInterrupt(() => Effect.sync(() => { turnInterrupted = true })))
          }
          return Effect.succeed({})
        },
        notify: method => method === 'session/cancel'
          ? Effect.gen(function*() {
              yield* Deferred.succeed(cancelNotified, undefined)
              yield* Deferred.await(releaseCancel)
            })
          : Effect.void,
        updates: Stream.empty,
      }),
    })
    return Effect.gen(function*() {
      promptStarted = yield* Deferred.make<void>()
      cancelNotified = yield* Deferred.make<void>()
      releaseCancel = yield* Deferred.make<void>()
      yield* sendChatMessage('', 999_999, '/repo', 'codex:chat-run', 'codex', 'Keep working')
      yield* Deferred.await(promptStarted)

      const cancelling = yield* Effect.forkChild(cancelChat('/repo', 'codex:chat-run'))
      yield* Deferred.await(cancelNotified)
      const reset = yield* resetChat('/repo', 'codex:chat-run')

      assert.strictEqual(reset.status, 'idle')
      assert.isTrue(turnInterrupted)
      yield* Deferred.succeed(releaseCancel, undefined)
      assert.strictEqual((yield* Fiber.join(cancelling)).status, 'idle')

      const response = yield* pollChatEvents('/repo', 'codex:chat-run', 1, 1)
      assert.deepStrictEqual(response.events, [])
      assert.isTrue(response.reset)
    }).pipe(Effect.provide(chatLayer([], [], connector)))
  })

  it.effect('finishes cancellation cleanup when the cancel action is interrupted', () => {
    let promptStarted!: Deferred.Deferred<void>
    let cancelNotified!: Deferred.Deferred<void>
    let turnInterrupted = false
    const connector = AcpConnector.of({
      connect: () => Effect.succeed({
        request: method => {
          if (method === 'initialize') return Effect.succeed({ protocolVersion: 1 })
          if (method === 'session/new') return Effect.succeed({ sessionId: 'interrupt-cancel' })
          if (method === 'session/prompt') {
            return Effect.gen(function*() {
              yield* Deferred.succeed(promptStarted, undefined)
              return yield* Effect.never
            }).pipe(Effect.onInterrupt(() => Effect.sync(() => { turnInterrupted = true })))
          }
          return Effect.succeed({})
        },
        notify: method => method === 'session/cancel'
          ? Effect.gen(function*() {
              yield* Deferred.succeed(cancelNotified, undefined)
              return yield* Effect.never
            })
          : Effect.void,
        updates: Stream.empty,
      }),
    })
    return Effect.gen(function*() {
      promptStarted = yield* Deferred.make<void>()
      cancelNotified = yield* Deferred.make<void>()
      yield* sendChatMessage('', 999_999, '/repo', 'codex:chat-run', 'codex', 'Keep working')
      yield* Deferred.await(promptStarted)

      const cancelling = yield* Effect.forkChild(cancelChat('/repo', 'codex:chat-run'))
      yield* Deferred.await(cancelNotified)
      yield* Fiber.interrupt(cancelling)

      assert.isTrue(turnInterrupted)
      const response = yield* pollChatEvents('/repo', 'codex:chat-run', 0, 0)
      const terminalEvents = response.events.filter(isTurnEnd)
      assert.strictEqual(response.status, 'idle')
      assert.strictEqual(terminalEvents.length, 1)
      assert.strictEqual(terminalEvents[0]!.stopReason, 'cancelled')
    }).pipe(Effect.provide(chatLayer([], [], connector)))
  })

  it.effect('finishes reset cleanup when the reset action is interrupted', () => {
    let promptStarted!: Deferred.Deferred<void>
    let turnCleanupStarted!: Deferred.Deferred<void>
    let releaseTurnCleanup!: Deferred.Deferred<void>
    let connectionClosed = false
    const connector = AcpConnector.of({
      connect: () => Effect.gen(function*() {
        yield* Effect.addFinalizer(() => Effect.sync(() => { connectionClosed = true }))
        return {
          request: (method: string) => {
            if (method === 'initialize') return Effect.succeed({ protocolVersion: 1 })
            if (method === 'session/new') return Effect.succeed({ sessionId: 'interrupt-reset' })
            if (method === 'session/prompt') {
              return Effect.gen(function*() {
                yield* Deferred.succeed(promptStarted, undefined)
                return yield* Effect.never
              }).pipe(Effect.onInterrupt(() => Effect.gen(function*() {
                yield* Deferred.succeed(turnCleanupStarted, undefined)
                yield* Deferred.await(releaseTurnCleanup)
              })))
            }
            return Effect.succeed({})
          },
          notify: () => Effect.void,
          updates: Stream.empty,
        }
      }),
    })
    return Effect.gen(function*() {
      promptStarted = yield* Deferred.make<void>()
      turnCleanupStarted = yield* Deferred.make<void>()
      releaseTurnCleanup = yield* Deferred.make<void>()
      yield* sendChatMessage('', 999_999, '/repo', 'codex:chat-run', 'codex', 'Keep working')
      yield* Deferred.await(promptStarted)

      const resetting = yield* Effect.forkChild(resetChat('/repo', 'codex:chat-run'))
      yield* Deferred.await(turnCleanupStarted)
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(resetting))
      yield* Effect.yieldNow
      yield* Deferred.succeed(releaseTurnCleanup, undefined)
      yield* Fiber.join(interrupting)

      assert.isTrue(connectionClosed)
      const response = yield* pollChatEvents('/repo', 'codex:chat-run', 1, 1)
      assert.strictEqual(response.status, 'idle')
      assert.deepStrictEqual(response.events, [])
      assert.isTrue(response.reset)
    }).pipe(Effect.provide(chatLayer([], [], connector)))
  })
})
