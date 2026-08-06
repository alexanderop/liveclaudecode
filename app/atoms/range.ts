import * as Atom from 'effect/unstable/reactivity/Atom'

/** Time range of sessions to show, in hours; `0` means all time. */
export type SessionRangeHours = number

/**
 * The range before the server has said anything.
 *
 * The same 168 the dashboard has always started at, and it is a placeholder in
 * exactly the way it was: the first `/api/tree` request carries no `hours` at
 * all, and the response's effective, clamped value replaces this. Stage 5 makes
 * that handshake explicit — an `explicitHours ?? serverHours ?? undefined`
 * composition — and this constant goes with it.
 */
const DEFAULT_HOURS = 168

/**
 * The visible time range.
 *
 * `keepAlive` because it is user-entered: a range picked in the sidebar must not
 * be reset by the idle sweep between the panels that read it.
 */
export const makeRangeAtoms = () => ({
  hours: Atom.make<SessionRangeHours>(DEFAULT_HOURS).pipe(Atom.keepAlive),
})

/** The live instance every component reads. Tests call the factory instead. */
export const rangeAtoms = makeRangeAtoms()
