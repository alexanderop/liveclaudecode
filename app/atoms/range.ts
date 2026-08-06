import * as Atom from 'effect/unstable/reactivity/Atom'

/** Time range of sessions to show, in hours; `0` means all time. */
export type SessionRangeHours = number

/**
 * What the sidebar shows before the server has said anything.
 *
 * Only a placeholder for the first paint. The range the dashboard actually runs
 * at is the server's, learned from the first `/api/tree` response, and this
 * value is never sent to it.
 */
const PLACEHOLDER_HOURS = 168

/**
 * The visible time range, as three atoms rather than one.
 *
 * The dashboard's range is *server-declared*. `liveclaudecode --hours 24` and
 * the Electron shell set `NUXT_LCC_HOURS`, which reaches the server's private
 * config only; `parseHours` lets a client-supplied value override the configured
 * one outright, so a client that guesses a default and sends it would silently
 * win — the user asks for a day and gets a week. The first request therefore
 * carries no `hours` at all, and the response's `hours` — already clamped by
 * `clampConfiguredHours` — is what the dashboard adopts.
 *
 * That is why {@link makeRangeAtoms.query} reads only the *explicit* choice.
 * If it fell back to the adopted value, the tree atom would be a dependent of
 * something the tree's own response writes: adopting would rebuild the poll
 * loop, which discards the feed's value and refetches — a visible blank on
 * first load, for a request that would return the same data.
 *
 * This replaces the `rangeInitialized` handshake in `useLiveRuns`, which used a
 * `let`, a `nextTick`, and a generation counter to express the same rule.
 */
export const makeRangeAtoms = () => {
  /**
   * The range the user picked, or null if they have not picked one.
   *
   * `keepAlive` because it is user-entered: the idle sweep must not quietly
   * return the dashboard to the server's default between two panels.
   */
  const explicit = Atom.make<number | null>(null).pipe(Atom.keepAlive)

  /** The server's effective, clamped range, learned from the first tree poll. */
  const server = Atom.make<number | null>(null).pipe(Atom.keepAlive)

  return {
    explicit,
    server,
    /**
     * The range every reader displays and every *detail* request sends.
     *
     * Writing it is choosing one, which is why the write lands on `explicit`.
     */
    hours: Atom.writable<SessionRangeHours, SessionRangeHours>(
      get => get(explicit) ?? get(server) ?? PLACEHOLDER_HOURS,
      (ctx, value) => ctx.set(explicit, value),
    ),
    /**
     * What `/api/tree` is asked for. `undefined` omits the parameter, which is
     * exactly the first request the handshake makes.
     */
    query: Atom.make((get): number | undefined => get(explicit) ?? undefined),
  }
}

/** The three range atoms, as one bundle. */
export type RangeAtoms = ReturnType<typeof makeRangeAtoms>

/** The live instance every component reads. Tests call the factory instead. */
export const rangeAtoms: RangeAtoms = makeRangeAtoms()
