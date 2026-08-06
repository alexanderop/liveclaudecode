import { Effect } from 'effect'
import * as Atom from 'effect/unstable/reactivity/Atom'
import type {
  CostSummaryWire,
  ProjectRunsWire,
  SessionSourceStatusWire,
} from '#shared/schemas/api'
import { Api } from '~/api/api'
import { feedIsOffline, feedValue, toFeedView } from '~/utils/feed-view'
import { pollingFeed } from './feed'
import { rangeAtoms, type RangeAtoms } from './range'
import { appRuntime } from './runtime'

/** Stable empties, so an unanswered poll does not publish a new array per read. */
const NO_PROJECTS: ReadonlyArray<ProjectRunsWire> = []
const NO_SOURCES: ReadonlyArray<SessionSourceStatusWire> = []

/**
 * How often the run tree re-reads the server.
 *
 * The dashboard's heartbeat. Every other cadence is described relative to this
 * one, and it is the poll whose failure means "the viewer is offline" — a run
 * detail that is momentarily unreachable is a gap; a tree that is unreachable is
 * a dashboard that has stopped being live.
 */
const POLL_INTERVAL = '4 seconds'

/**
 * The run tree, polled for whichever range is selected.
 *
 * One feed, not three. `projects`, `sources`, and `costs` are three fields of a
 * single response, and polling them separately would triple the request count
 * against the most expensive route the sidebar depends on.
 *
 * **No `Atom.withEquality`.** Suppressing a re-render when a poll returns
 * unchanged data is impossible here and would not be cheap if it were: every
 * node carries `ago = now - mtime`, recomputed per request
 * (`server/utils/transcript.ts:903`), so two consecutive responses always
 * differ. Measured against a 405-node, 942 KB tree on this machine: decoding
 * costs 5.8 ms — against a 2.5 ms `JSON.parse` round trip and a 16 ms frame —
 * while one `Equal.equals` against a freshly decoded graph costs 20.4 ms,
 * because `Hash` caches per object and the new graph is uncached. Paying 20 ms
 * every four seconds to learn "not equal" is the worst of both.
 */
export const makeTreeAtoms = (
  runtime: Atom.AtomRuntime<Api>,
  range: RangeAtoms = rangeAtoms,
) => {
  const tree = runtime.atom((get) => {
    // Tracked: choosing a different range rebuilds the loop, which is the
    // immediate refetch the old `watch(hours, …)` cascade did by hand. It reads
    // the *explicit* choice only, so adopting the server's range below cannot
    // invalidate this atom — see `app/atoms/range.ts`.
    const hours = get(range.query)
    return pollingFeed({
      interval: POLL_INTERVAL,
      // No cursor: every poll returns the whole tree for the range.
      initial: () => null,
      fetch: () =>
        Effect.gen(function*() {
          const api = yield* Api
          const response = yield* api.tree({ hours })
          // The handshake, in one line: the first response teaches the client
          // the server's effective range. Only on the null transition, so a
          // user who has since picked a range is not overruled by a poll that
          // was already in flight.
          if (get.once(range.server) === null) get.set(range.server, response.hours)
          return [null, response] as const
        }),
    })
  })

  /**
   * The four fields of the response, and the two states of the poll.
   *
   * These are projections of this module's own feed rather than derivations
   * across domains — the rule that keeps a fetching module from becoming an
   * aggregator is not violated by unwrapping the response it just fetched.
   * Everything that combines the tree with something else (the filters, the
   * selection) lives in the file that owns that other thing.
   */
  return {
    tree,
    projects: Atom.map(tree, result =>
      feedValue(result, response => response.projects, NO_PROJECTS)),
    sources: Atom.map(tree, result =>
      feedValue(result, response => response.sources, NO_SOURCES)),
    costs: Atom.map(tree, result =>
      feedValue(result, response => response.costs, null as CostSummaryWire | null)),
    /** True until the first response — or the first failure — arrives. */
    loading: Atom.map(tree, result => toFeedView(result).tag === 'loading'),
    /**
     * True while the *tree* poll is failing, cleared by its next success.
     *
     * Narrower than the flag it replaces, which latched on any failed request
     * and cleared on any success — so a failing run detail would raise the
     * offline banner and an unrelated events poll would clear it again. The tree
     * is the heartbeat: if it is answering, the viewer is connected.
     */
    offline: Atom.map(tree, feedIsOffline),
  }
}

/** The tree feed and its projections, as one bundle. */
export type TreeAtoms = ReturnType<typeof makeTreeAtoms>

/** The live instance every component reads. Tests call the factory instead. */
export const treeAtoms: TreeAtoms = makeTreeAtoms(appRuntime)
