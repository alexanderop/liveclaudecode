import * as Atom from 'effect/unstable/reactivity/Atom'
import type { RunNodeWire, TranscriptEventWire } from '#shared/schemas/api'
import { activityBase, mergeActivityEvents } from '~/utils/activity-feed'
import { flattenRunTree } from '~/utils/execution-analysis'
import { feedValue } from '~/utils/feed-view'
import { eventsAtoms, eventsKey, type EventsAtoms } from './events'
import { rangeAtoms, type RangeAtoms } from './range'
import { runAtoms, runKey, type RunAtoms } from './run-detail'
import { selectionAtoms, type SelectionAtoms } from './selection'
import {
  sessionEventsAtoms,
  sessionEventsKey,
  type SessionEventsAtoms,
} from './session-events'

/** Every agent of the session, or one of them. */
const WHOLE_SESSION = 'all'

/** How long the agent chosen for a session outlives looking at that session. */
const IDLE_TTL = '10 minutes'

const NO_EVENTS: ReadonlyArray<TranscriptEventWire> = []
const NO_AGENTS: ReadonlyArray<RunNodeWire> = []

/** Which session's activity view — the project and the session root. */
export interface ActivitySession {
  readonly project: string
  readonly root: string
}

/** The one constructor for an {@link ActivitySession}. */
export const activitySession = (
  project: string | null,
  root: string | null,
): ActivitySession => ({ project: project ?? '', root: root ?? '' })

/**
 * The activity view: one feed, assembled from four sources.
 *
 * This is the only module that reads more than one domain, which is what it is
 * for — the merge was seventeen lines inside `index.vue`, reaching into the
 * session feed, the selected agent's transcript, the run's diagnostics, and the
 * tree. Being an atom rather than a `computed` is what lets it be tested without
 * mounting the page.
 *
 * The merge is *not* wrapped in `Atom.withEquality`. That combinator exists in
 * the vendored source but not in the published `effect@4.0.0-beta.101` dist,
 * which is the one hazard the migration plan named and did not otherwise hit:
 * a claim read off `repos/effect` that the installed package does not honour.
 * `index.vue` keeps its `structuralComputed` over this value instead, which is
 * the same suppression by the means the codebase already had — and the reason
 * that helper still has three consumers rather than two.
 */
export const makeActivityAtoms = (
  selection: SelectionAtoms = selectionAtoms,
  range: RangeAtoms = rangeAtoms,
  events: EventsAtoms = eventsAtoms,
  sessionEvents: SessionEventsAtoms = sessionEventsAtoms,
  run: RunAtoms = runAtoms,
) => {
  /**
   * Which agent the activity view is filtered to, per session.
   *
   * A family with a TTL rather than `index.vue`'s capacity-20 MRU `Map`. The
   * two are not the same rule: the MRU dropped the twenty-first-oldest session's
   * choice the moment a twenty-first appeared, this drops whatever nobody has
   * looked at for ten minutes. The intent — a long-lived dashboard does not
   * accumulate one entry per session ever visited — is kept, restated as a time
   * bound. `keepAlive` would not do: nothing subscribes to a choice for a
   * session that is not on screen.
   */
  const agent = Atom.family((session: ActivitySession) => {
    void session
    return Atom.make(WHOLE_SESSION).pipe(Atom.setIdleTTL(IDLE_TTL))
  })

  /** The agents of the selected session, as the filter lists them. */
  const agents = Atom.make((get): ReadonlyArray<RunNodeWire> => {
    const root = get(selection.root)
    return root ? flattenRunTree(root) : NO_AGENTS
  })

  const feed = Atom.make((get): ReadonlyArray<TranscriptEventWire> => {
    const project = get(selection.project)
    const key = get(selection.key)
    const root = get(selection.root)
    const hours = get(range.hours)
    const merged = get(sessionEvents.sessionEvents(
      sessionEventsKey(project, root?.key ?? key, hours),
    ))
    const transcript = get(events.events(eventsKey(project, key, hours)))
    const detail = get(run.run(runKey(project, key, hours)))
    return mergeActivityEvents({
      base: activityBase({
        sessionEvents: feedValue(merged, response => response.events, NO_EVENTS),
        agentEvents: feedValue(transcript, value => value, NO_EVENTS),
        root,
      }),
      incidents: feedValue(detail, response => response.diagnostics.incidents, []),
      agents: get(agents),
      agentKey: get(agent(activitySession(project, root?.key ?? key))),
    })
  })

  return { agent, agents, feed, WHOLE_SESSION }
}

/** The activity atoms, as one bundle. */
export type ActivityAtoms = ReturnType<typeof makeActivityAtoms>

/** The live instance every component reads. Tests call the factory instead. */
export const activityAtoms: ActivityAtoms = makeActivityAtoms()
