import { Effect } from 'effect'
import * as Atom from 'effect/unstable/reactivity/Atom'
import { Api } from '~/api/api'
import { pollingFeed } from './feed'
import { appRuntime } from './runtime'

/**
 * How often the selected agent's detail re-reads the server.
 *
 * Slower than the transcript it sits beside: lanes, file totals, and
 * diagnostics move per turn, not per token, and `/api/run` re-reads every
 * transcript of the session to build them.
 */
const POLL_INTERVAL = '6 seconds'

/** Which agent's detail, in which range. */
export interface RunKey {
  readonly project: string
  readonly key: string
  readonly hours: number
}

/**
 * The one constructor for a {@link RunKey}; call sites never inline a literal.
 *
 * The empty selection is a real key rather than a missing one: the feed exists,
 * and its `enabled` gate keeps it from asking the server about nothing. That is
 * what lets a component subscribe unconditionally during `setup()`.
 */
export const runKey = (
  project: string | null,
  key: string | null,
  hours: number,
): RunKey => ({ project: project ?? '', key: key ?? '', hours })

/**
 * The run detail, per agent and range.
 *
 * A different agent is a different atom, which is the whole of what
 * `latest-request-gate.ts` used to do: a response can only ever be written into
 * the node that asked for it, and the node nobody is subscribed to any more is
 * interrupted — which aborts its `fetch` — rather than raced.
 */
export const makeRunAtoms = (runtime: Atom.AtomRuntime<Api>) => ({
  run: Atom.family((key: RunKey) =>
    runtime.atom(() =>
      pollingFeed({
        interval: POLL_INTERVAL,
        // No cursor: every poll returns the whole detail for the agent.
        initial: () => null,
        enabled: () => Boolean(key.project && key.key),
        fetch: () =>
          Effect.gen(function*() {
            const api = yield* Api
            const response = yield* api.run(key)
            return [null, response] as const
          }),
      }))),
})

/** The run-detail atoms, as one bundle. */
export type RunAtoms = ReturnType<typeof makeRunAtoms>

/** The live instance every component reads. Tests call the factory instead. */
export const runAtoms: RunAtoms = makeRunAtoms(appRuntime)
