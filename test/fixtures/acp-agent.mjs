#!/usr/bin/env node
/**
 * Minimal scripted ACP agent for e2e tests: newline-delimited JSON-RPC 2.0
 * over stdio, the same wire format `AcpConnector` speaks. Modes (argv[2]):
 *
 * - "reply" (default): answers `session/prompt` with one agent message chunk
 *   followed by an `end_turn` stop, exercising the full send flow.
 * - "hang": accepts the prompt but never answers it, so only a cancel action
 *   can end the turn — exercising the cancel flow deterministically.
 */
import { createInterface } from 'node:readline'

const mode = process.argv[2] ?? 'reply'

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = message
  if (method === 'initialize') {
    send({ id, result: { protocolVersion: 1 } })
    return
  }
  if (method === 'session/new') {
    send({ id, result: { sessionId: 'fake-acp-session' } })
    return
  }
  if (method === 'session/prompt') {
    if (mode === 'hang') return
    send({
      method: 'session/update',
      params: {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Fake agent reply.' },
        },
      },
    })
    send({ id, result: { stopReason: 'end_turn' } })
  }
})
