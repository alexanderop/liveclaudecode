import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer, Result } from 'effect'
import { AcpConnector, type AcpConnectionOptions } from '#server/utils/acp-connection'
import {
  ChatAgentCommands,
  ChatStore,
  chatAgentCommandsFromEnv,
  pollChatEvents,
  sendChatMessage,
} from '#server/utils/chat'
import { parseChatAction } from '#shared/schemas/chat'
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

function chatLayer(prompts: unknown[], connections: AcpConnectionOptions[] = []) {
  const connector = AcpConnector.of({
    connect: (options: AcpConnectionOptions) => Effect.sync(() => {
      connections.push(options)
      return {
        request: (method, params) => Effect.gen(function*() {
          if (method === 'initialize') return { protocolVersion: 1 }
          if (method === 'session/new') return { sessionId: 'answer-session' }
          if (method === 'session/prompt') {
            prompts.push(params)
            if (options.command === 'copilot') {
              yield* options.onUpdate({
                sessionId: 'answer-session',
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'Info: Disabled tools: apply_patch, bash, edit' },
                },
              })
            }
            yield* options.onUpdate({
              sessionId: 'answer-session',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'The tests failed in setup.' },
              },
            })
            return { stopReason: 'end_turn' }
          }
          return {}
        }),
        notify: () => Effect.void,
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
    testFileSystem({
      '/repo/.keep': '',
      [TRANSCRIPT]: codex.rollout([
        codex.sessionMeta('chat-run', { cwd: '/repo' }),
        codex.message('user', 'Run the tests'),
      ]),
    }),
  )
}

const waitForIdle = Effect.fn('waitForIdle')(function*(project: string, key: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    yield* Effect.yieldNow
    const response = yield* pollChatEvents(project, key, 0, 0)
    if (response.status === 'idle') return response
  }
  return yield* Effect.die('chat turn did not finish')
})

describe('session chat', () => {
  it('configures coding agents with full permissions and accepts Copilot in chat actions', () => {
    const commands = chatAgentCommandsFromEnv({})
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
    assert.deepStrictEqual(
      chatAgentCommandsFromEnv({ LCC_ACP_COPILOT: '/opt/copilot --acp --stdio' }).copilot,
      { command: '/opt/copilot', args: ['--acp', '--stdio'], env: {} },
    )
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
      const firstPrompt = prompts[0] as { prompt: Array<{ text: string }> }
      const secondPrompt = prompts[1] as { prompt: Array<{ text: string }> }
      assert.strictEqual(firstPrompt.prompt.length, 2)
      assert.isTrue(firstPrompt.prompt[0]!.text.includes(TRANSCRIPT))
      assert.deepStrictEqual(secondPrompt.prompt, [{ type: 'text', text: 'What should I fix?' }])
      assert.strictEqual(second.events.filter(event => event.kind === 'turn-end').length, 2)
    }).pipe(Effect.provide(chatLayer(prompts)))
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
})
