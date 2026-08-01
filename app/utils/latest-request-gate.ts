export interface RequestToken {
  readonly key: string
  readonly generation: number
}

export interface LatestRequestGate {
  /**
   * Claim a slot for a request identified by `key`. Returns `null` when the
   * same key is already in flight, so callers can skip duplicate work.
   */
  readonly start: (key: string) => RequestToken | null
  /** Whether a token still belongs to the latest generation. */
  readonly isCurrent: (request: RequestToken) => boolean
  /** Release a token so the same key may be requested again. */
  readonly settle: (request: RequestToken) => void
  /** Invalidate every outstanding token and clear the pending slot. */
  readonly invalidate: () => void
}

/**
 * Tracks the newest request for a resource so that late responses from
 * superseded requests can be detected and dropped, including A-B-A cycles
 * where the same key is re-requested while a stale response is pending.
 */
export function createLatestRequestGate(): LatestRequestGate {
  let generation = 0
  let pending: RequestToken | null = null

  return {
    start(key) {
      if (pending?.key === key) return null
      const request = { key, generation: generation += 1 }
      pending = request
      return request
    },
    isCurrent: request => request.generation === generation,
    settle(request) {
      if (pending === request) pending = null
    },
    invalidate() {
      generation += 1
      pending = null
    },
  }
}
