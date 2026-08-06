import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import type { ChatAction } from '#shared/types/chat'
import { call, jsonResponse, useApiOrigin, withFetch } from '../../fixtures/api-transport'
import { chatActionResponse, chatEventsResponse } from '../../fixtures/chat'

useApiOrigin()

const cursor = { project: '/repo', key: 'codex:session', since: 4, revision: 2 }

const ask = (text: string): ChatAction => ({
  action: 'send',
  project: '/repo',
  key: 'codex:session',
  agent: 'copilot',
  text,
})

describe('the chat events route', () => {
  it.effect('decodes a page of events and carries the cursor in the query', () =>
    Effect.gen(function*() {
      const { layer, requests } = yield* withFetch(() =>
        jsonResponse(chatEventsResponse({
          events: [{ kind: 'assistant-chunk', agent: 'copilot', text: 'because' }],
          next: 5,
          revision: 2,
          status: 'busy',
          agent: 'copilot',
        })))

      const page = yield* call(layer, api => api.chatEvents(cursor))

      assert.deepStrictEqual(page.events, [
        { kind: 'assistant-chunk', agent: 'copilot', text: 'because' },
      ])
      assert.strictEqual(page.next, 5)
      const [request] = yield* requests
      assert.include(request?.url ?? '', 'project=%2Frepo')
      assert.include(request?.url ?? '', 'key=codex%3Asession')
      assert.include(request?.url ?? '', 'since=4')
      assert.include(request?.url ?? '', 'revision=2')
    }))

  it.effect('does not send hours, which this handler has never read', () =>
    Effect.gen(function*() {
      const { layer, requests } = yield* withFetch(() => jsonResponse(chatEventsResponse()))

      yield* call(layer, api => api.chatEvents(cursor))

      // `server/api/chat.get.ts` is the one GET that never calls
      // `browserOptionsFor`, and `CursorQuerySchema` has no `hours` field, so
      // the parameter the old transport appended was decoded away on arrival.
      const [request] = yield* requests
      assert.notInclude(request?.url ?? '', 'hours')
    }))

  it.effect('rejects an event kind this build does not know', () =>
    Effect.gen(function*() {
      const { layer } = yield* withFetch(() =>
        jsonResponse({ ...chatEventsResponse(), events: [{ kind: 'video', src: 'x' }] }))

      const failure = yield* Effect.flip(call(layer, api => api.chatEvents(cursor)))

      assert.strictEqual(failure._tag, 'ApiMalformed')
    }))
})

describe('the chat action route', () => {
  it.effect('posts the action as JSON and keeps hours, which this handler does read', () =>
    Effect.gen(function*() {
      const { layer, requests } = yield* withFetch(() => jsonResponse(chatActionResponse()))

      const accepted = yield* call(layer, api => api.chatAction(ask('why?'), { hours: 720 }))

      assert.strictEqual(accepted.status, 'starting')
      const [request] = yield* requests
      assert.strictEqual(request?.method, 'POST')
      // `hours` is how `handleChatAction` locates the session to attach an agent
      // to (`server/api/chat.post.ts:8`). Dropping it here breaks Ask entirely.
      assert.include(request?.url ?? '', 'hours=720')
      assert.deepStrictEqual(JSON.parse(request?.body ?? 'null'), ask('why?'))
    }))

  it.effect('refuses a blank question in the browser instead of asking the server', () =>
    Effect.gen(function*() {
      const { layer, requests } = yield* withFetch(() => jsonResponse(chatActionResponse()))

      const failure = yield* Effect.flip(
        call(layer, api => api.chatAction(ask('   '), { hours: 720 })),
      )

      // The body is encoded through the same `ChatActionSchema` the handler
      // parses it with, so its checks run here first. A behaviour change from
      // the old transport, which posted it and got a 400 back.
      assert.strictEqual(failure._tag, 'ApiRefused')
      assert.deepStrictEqual(yield* requests, [])
    }))

  it.effect('refuses a question past the length the server would accept', () =>
    Effect.gen(function*() {
      const { layer, requests } = yield* withFetch(() => jsonResponse(chatActionResponse()))

      const failure = yield* Effect.flip(
        call(layer, api => api.chatAction(ask('a'.repeat(20_001)), { hours: 720 })),
      )

      assert.strictEqual(failure._tag, 'ApiRefused')
      assert.include(failure.remedy, 'Adjust the input')
      assert.deepStrictEqual(yield* requests, [])
    }))

  it.effect('reports a busy chat in the server\'s own words', () =>
    Effect.gen(function*() {
      const { layer } = yield* withFetch(() =>
        jsonResponse({
          statusCode: 409,
          statusMessage: 'A reply is already in progress for this chat',
        }, 409))

      const failure = yield* Effect.flip(
        call(layer, api => api.chatAction(ask('why?'), { hours: 720 })),
      )

      assert.strictEqual(failure._tag, 'ApiRejected')
      assert.strictEqual(failure.message, 'A reply is already in progress for this chat')
    }))

  it.effect('calls a dead socket unreachable', () =>
    Effect.gen(function*() {
      const { layer } = yield* withFetch(() => Promise.reject(new Error('connect ECONNREFUSED')))

      const failure = yield* Effect.flip(
        call(layer, api => api.chatAction(ask('why?'), { hours: 720 })),
      )

      assert.strictEqual(failure._tag, 'ApiUnreachable')
    }))
})
