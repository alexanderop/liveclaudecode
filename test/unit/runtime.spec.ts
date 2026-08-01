import { EventEmitter } from 'node:events'
import { assert, describe, expect, it } from '@effect/vitest'
import { vi } from 'vitest'
import { Effect } from 'effect'
import * as PlatformError from 'effect/PlatformError'
import { runRequest, toHttpError, type AppError } from '../../server/utils/runtime'
import {
  InvalidRunKey,
  NoTranscriptsFound,
  UnknownProject,
  UnknownRun,
} from '../../server/utils/services'
import { AcpAgentError } from '../../server/utils/acp-connection'
import { ChatBusy, ChatCapacity, InvalidChatAction } from '../../server/utils/chat'
import { InvalidRequestQuery } from '../../shared/schemas/request'

// `h3` is provided to the real server by Nitro's bundler and is not
// resolvable from the unit-test project, so the entry point runtime.ts uses
// is substituted with a structural equivalent. (`vi.mock` is hoisted above
// the imports, so the mock is in place before runtime.ts loads.)
vi.mock('h3', () => ({
  createError: (input: { statusCode: number, statusMessage: string }) =>
    Object.assign(new Error(input.statusMessage), input),
}))

type RequestEvent = Parameters<typeof runRequest>[0]

function fakeEvent(): { event: RequestEvent, req: EventEmitter } {
  const req = new EventEmitter()
  return { event: { node: { req } } as unknown as RequestEvent, req }
}

const platformError = PlatformError.systemError({
  _tag: 'PermissionDenied',
  module: 'FileSystem',
  method: 'stat',
  pathOrDescriptor: '/p',
})

describe('toHttpError', () => {
  const cases: Array<[AppError, number]> = [
    [new NoTranscriptsFound({ directory: '/p' }), 404],
    [new UnknownProject({ input: 'x', directory: '/p' }), 404],
    [new UnknownRun({ key: 'k' }), 404],
    [new InvalidRunKey({ key: '../k' }), 400],
    [new InvalidRequestQuery({ reason: 'not an object' }), 400],
    [new InvalidChatAction({ reason: 'bad body' }), 400],
    [new ChatBusy({ key: 'k' }), 409],
    [new ChatCapacity({ capacity: 3 }), 429],
    [platformError, 500],
    [new AcpAgentError({ reason: 'agent exited' }), 502],
  ]

  it('maps every member of the error union onto its status code', () => {
    for (const [error, statusCode] of cases) {
      assert.strictEqual(toHttpError(error).statusCode, statusCode, error._tag)
    }
  })

  it('keeps the typed error message as the status message', () => {
    assert.strictEqual(
      toHttpError(new UnknownRun({ key: 'k' })).statusMessage,
      'Unknown run key',
    )
    assert.strictEqual(
      toHttpError(platformError).statusMessage,
      'Filesystem error: PermissionDenied',
    )
  })
})

describe('runRequest', () => {
  it('returns the effect value on success', async () => {
    const { event, req } = fakeEvent()
    assert.strictEqual(await runRequest(event, Effect.succeed(42)), 42)
    assert.strictEqual(req.listenerCount('close'), 0)
  })

  it('throws the mapped http error for a typed failure', async () => {
    const { event } = fakeEvent()
    await expect(runRequest(event, Effect.fail(new UnknownRun({ key: 'k' }))))
      .rejects.toMatchObject({ statusCode: 404 })
  })

  it('rethrows a defect unchanged', async () => {
    const { event } = fakeEvent()
    const boom = new Error('boom')
    await expect(runRequest(event, Effect.die(boom))).rejects.toBe(boom)
  })

  it('reports a client disconnect of a pending request as 499', async () => {
    const { event, req } = fakeEvent()
    const pending = runRequest(event, Effect.never)
    req.emit('close')
    await expect(pending).rejects.toMatchObject({ statusCode: 499 })
    assert.strictEqual(req.listenerCount('close'), 0)
  })

  it('does not mask a defect as a benign 499 when the client has disconnected', async () => {
    const { event, req } = fakeEvent()
    const boom = new Error('genuine defect')
    const effect = Effect.uninterruptible(
      Effect.sync(() => {
        req.emit('close')
      }).pipe(Effect.andThen(Effect.die(boom))),
    )
    await expect(runRequest(event, effect)).rejects.toBe(boom)
  })

  it('still maps a typed failure that races a client disconnect', async () => {
    const { event, req } = fakeEvent()
    const effect = Effect.uninterruptible(
      Effect.sync(() => {
        req.emit('close')
      }).pipe(Effect.andThen(Effect.fail(new InvalidRunKey({ key: 'bad' })))),
    )
    await expect(runRequest(event, effect)).rejects.toMatchObject({ statusCode: 400 })
  })
})
