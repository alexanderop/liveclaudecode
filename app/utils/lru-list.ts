export interface LruEntry<State> {
  readonly identity: string
  readonly state: State
}

/**
 * Returns the state stored for `identity`, creating and appending an entry
 * when none exists yet. Never evicts; combine with {@link touchLruEntry}.
 */
export function ensureLruEntry<State>(
  entries: LruEntry<State>[],
  identity: string,
  create: () => State,
): State {
  const existing = entries.find(entry => entry.identity === identity)
  if (existing) return existing.state
  entries.push({ identity, state: create() })
  // Read back through the array so callers get the reactive proxy when the
  // array is reactive, not the raw object that was pushed.
  return entries.at(-1)!.state
}

/**
 * Upserts the entry for `identity` at the most-recently-used position —
 * re-inserting `state` when the entry was already evicted — and evicts the
 * least recently used entries beyond `capacity`.
 */
export function touchLruEntry<State>(
  entries: LruEntry<State>[],
  identity: string,
  state: State,
  capacity: number,
): void {
  const index = entries.findIndex(entry => entry.identity === identity)
  if (index >= 0) entries.splice(index, 1)
  entries.push({ identity, state })
  while (entries.length > capacity) entries.shift()
}
