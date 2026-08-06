import { Effect } from 'effect'
import * as Atom from 'effect/unstable/reactivity/Atom'
import type { SessionEventsResponseWire } from '#shared/schemas/api'
import { Api } from '~/api/api'
import { pollingFeed } from './feed'
import { appRuntime } from './runtime'

/** How often the merged session feed re-reads the server. */
const POLL_INTERVAL = '4 seconds'

/**
 * How many merged events one poll may return.
 *
 * The server drops the oldest beyond this and says so with `truncated`, which
 * the activity view surfaces. It is a constant rather than part of the key: the
 * dashboard has never varied it, and putting it in the key would make it look
 * like something a caller chooses.
 */
const LIMIT = 800

/**
 * Which *session* — the root key, not the selected agent.
 *
 * `/api/session-events` merges every agent beneath a root, so selecting a
 * subagent must not re-key this feed: the answer is the same one. The page
 * expressed that as `selectedRoot?.key || selectedKey`.
 */
export interface SessionEventsKey {
  readonly project: string
  readonly root: string
  readonly hours: number
}

/** The one constructor for a {@link SessionEventsKey}. */
export const sessionEventsKey = (
  project: string | null,
  root: string | null,
  hours: number,
): SessionEventsKey => ({ project: project ?? '', root: root ?? '', hours })

/**
 * Every agent of one session, merged into one feed.
 *
 * A snapshot rather than a cursor — the server merges and re-sorts across
 * transcripts on every poll — so there is no accumulated state to protect and
 * no `setIdleTTL`.
 */
export const makeSessionEventsAtoms = (runtime: Atom.AtomRuntime<Api>) => ({
  sessionEvents: Atom.family((key: SessionEventsKey) =>
    runtime.atom(() =>
      pollingFeed({
        interval: POLL_INTERVAL,
        initial: () => null,
        enabled: () => Boolean(key.project && key.root),
        fetch: () =>
          Effect.gen(function*() {
            const api = yield* Api
            const response: SessionEventsResponseWire = yield* api.sessionEvents({
              project: key.project,
              key: key.root,
              hours: key.hours,
              limit: LIMIT,
            })
            return [null, response] as const
          }),
      }))),
})

/** The session-activity atoms, as one bundle. */
export type SessionEventsAtoms = ReturnType<typeof makeSessionEventsAtoms>

/** The live instance every component reads. Tests call the factory instead. */
export const sessionEventsAtoms: SessionEventsAtoms = makeSessionEventsAtoms(appRuntime)
