import { Effect } from 'effect'
import * as Atom from 'effect/unstable/reactivity/Atom'
import { Api } from '~/api/api'
import { pollingFeed } from './feed'
import { appRuntime } from './runtime'

/**
 * How often the debug page re-reads which records were skipped.
 *
 * The same reasoning as the cost overview, and the same interval: `/api/debug`
 * re-scans every transcript in the range, and parse health is a page somebody
 * opens to answer a question, not one they watch. The loop exists so the
 * offline banner clears itself rather than because the number moves.
 */
const POLL_INTERVAL = '30 seconds'

/** The family key for the parse-health feed. `hours: 0` means all time. */
export interface ParseHealthKey {
  readonly hours: number
}

/** The one constructor for a {@link ParseHealthKey}. */
export const parseHealthKey = (hours: number): ParseHealthKey => ({ hours })

/** Parse health, polled per range. Read it through `toFeedView`. */
export const makeParseHealthAtoms = (runtime: Atom.AtomRuntime<Api>) => {
  /**
   * "Read it again now." Merged into the running feed rather than refreshed,
   * because refreshing a stream atom rebuilds it and empties the page.
   *
   * A counter, because the registry only notifies on a changed value;
   * `keepAlive` so a click between two renders is not lost with the node.
   */
  const refresh: Atom.Writable<number, void> = Atom.writable<number, void>(
    () => 0,
    ctx => ctx.setSelf(ctx.get(refresh) + 1),
  ).pipe(Atom.keepAlive)

  return {
    refresh,
    parseHealth: Atom.family((key: ParseHealthKey) =>
    runtime.atom((get) => {
      // Materialise the pulse before subscribing: a node that has never been
      // read is evaluated by its first *write*, which would notify twice.
      get.once(refresh)
      return pollingFeed({
        interval: POLL_INTERVAL,
        initial: () => null,
        pulses: get.stream(refresh, { withoutInitialValue: true }),
        fetch: () =>
          Effect.gen(function*() {
            const api = yield* Api
            const response = yield* api.parseHealth({ hours: key.hours })
            return [null, response] as const
          }),
      })
    })),
  }
}

/** The parse-health atoms, as one bundle. */
export type ParseHealthAtoms = ReturnType<typeof makeParseHealthAtoms>

/** The live instance every component reads. Tests call the factory instead. */
export const parseHealthAtoms: ParseHealthAtoms = makeParseHealthAtoms(appRuntime)
