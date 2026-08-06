import { Effect } from 'effect'
import * as Atom from 'effect/unstable/reactivity/Atom'
import type { TranscriptEventWire } from '#shared/schemas/api'
import { Api } from '~/api/api'
import { pollingFeed } from './feed'
import { appRuntime } from './runtime'

/**
 * How often one agent's transcript re-reads the server.
 *
 * The fastest feed in the dashboard after the chat. This is a live tail: the
 * interval is what "watching it work" looks like.
 */
const POLL_INTERVAL = '2 seconds'

/** How long a transcript nobody is watching keeps its accumulated events. */
const IDLE_TTL = '2 minutes'

/** Which agent's transcript, in which range. */
export interface EventsKey {
  readonly project: string
  readonly key: string
  readonly hours: number
}

/**
 * The one constructor for an {@link EventsKey}; call sites never inline a
 * literal. An empty selection is a real key whose feed is gated off, not an
 * absent one — see `runKey`.
 */
export const eventsKey = (
  project: string | null,
  key: string | null,
  hours: number,
): EventsKey => ({ project: project ?? '', key: key ?? '', hours })

/** The cursor threaded across polls, beside the buffer it has accumulated. */
interface EventsCursor {
  readonly since: number
  readonly revision: number
  readonly events: ReadonlyArray<TranscriptEventWire>
}

const EMPTY: ReadonlyArray<TranscriptEventWire> = []

/**
 * One agent's transcript, accumulated across polls.
 *
 * This is `useEventStream` plus `event-poller.ts` plus their generation
 * counter, as one family. The counter existed to answer "is this response still
 * the one we want"; a different agent is now a different atom, so the question
 * cannot be asked.
 *
 * `setIdleTTL` because the buffer is accumulated state: flipping to another
 * agent and back within a couple of minutes resumes from the cursor instead of
 * refetching the whole transcript, which is what the old `reset()` discipline
 * deliberately avoided doing.
 */
export const makeEventsAtoms = (runtime: Atom.AtomRuntime<Api>) => ({
  events: Atom.family((key: EventsKey) =>
    runtime.atom(() =>
      pollingFeed({
        interval: POLL_INTERVAL,
        initial: (): EventsCursor => ({ since: 0, revision: 0, events: EMPTY }),
        enabled: () => Boolean(key.project && key.key),
        fetch: cursor =>
          Effect.gen(function*() {
            const api = yield* Api
            const page = yield* api.events({
              project: key.project,
              key: key.key,
              hours: key.hours,
              since: cursor.since,
              revision: cursor.revision,
            })
            // `reset` is the provider having rewritten the transcript: the
            // buffer is replaced rather than extended.
            const events = page.reset ? page.events : [...cursor.events, ...page.events]
            return [
              { since: page.next, revision: page.revision, events },
              events,
            ] as const
          }),
      })).pipe(Atom.setIdleTTL(IDLE_TTL))),
})

/** The transcript atoms, as one bundle. */
export type EventsAtoms = ReturnType<typeof makeEventsAtoms>

/** The live instance every component reads. Tests call the factory instead. */
export const eventsAtoms: EventsAtoms = makeEventsAtoms(appRuntime)
