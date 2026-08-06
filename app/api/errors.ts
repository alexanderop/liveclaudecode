import { Schema } from 'effect'

/**
 * The request never got an answer: the dev server is down, the machine went to
 * sleep, the socket died. The dashboard's most common failure and the reason
 * `AtomHttpApi` is not used — this has to stay a typed failure the UI renders
 * as an offline banner, not an unhandled defect. It resolves itself.
 */
export class ApiUnreachable extends Schema.TaggedErrorClass<ApiUnreachable>()(
  'ApiUnreachable',
  { url: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return this.detail ? `${this.url} is unreachable: ${this.detail}` : `${this.url} is unreachable`
  }

  get remedy(): string {
    return 'Check that the dashboard server is still running; the page recovers on its own once it is.'
  }
}

/**
 * The server answered with a non-2xx status. Carries h3's `statusMessage`, which
 * is why the status is inspected before the body is decoded.
 */
export class ApiRejected extends Schema.TaggedErrorClass<ApiRejected>()(
  'ApiRejected',
  { url: Schema.String, status: Schema.Number, detail: Schema.String },
) {
  override get message(): string {
    return this.detail ? this.detail : `${this.url} responded ${this.status}`
  }

  get remedy(): string {
    return 'Check the server output for the failure it reported.'
  }
}

/**
 * A 2xx body this build cannot decode. Version skew between the served client
 * and the running server; retrying will not help, so the UI asks for a reload.
 */
export class ApiMalformed extends Schema.TaggedErrorClass<ApiMalformed>()(
  'ApiMalformed',
  { url: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `${this.url} returned a response this build cannot read`
  }

  get remedy(): string {
    return 'Reload the page — the server was updated while this one was open.'
  }
}

/**
 * The client declined to send: the payload failed the schema both sides share,
 * so the server would only have answered 400. Rendered as inline validation.
 */
export class ApiRefused extends Schema.TaggedErrorClass<ApiRefused>()(
  'ApiRefused',
  { url: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return this.detail
  }

  get remedy(): string {
    return 'Adjust the input and try again.'
  }
}

/**
 * Every failure the `Api` service can produce.
 *
 * Each carries a `message` — what went wrong, with the server's own words where
 * there are any — and a `remedy`, the sentence the UI shows the user underneath
 * it. They are separate because the diagnostic belongs in logs and causes while
 * the instruction only makes sense on screen.
 *
 * Interruption is deliberately not a member. `Effect.catch` never sees an
 * interrupt, and a superseded poll does not produce a `Failure` at all — the
 * node's cancel removes the exit observer before interrupting the fiber
 * (`repos/effect/packages/effect/src/unstable/reactivity/Atom.ts:595-601`).
 */
export type ApiError = ApiUnreachable | ApiRejected | ApiMalformed | ApiRefused
