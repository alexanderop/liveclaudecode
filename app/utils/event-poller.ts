import type { Ref } from 'vue'
import type { EventsResponse, TranscriptEvent } from '#shared/types/run'

export interface EventCursor {
  /** Line offset of the next event to request. */
  readonly since: Ref<number>
  /** Provider revision; a mismatch means the transcript was rebuilt. */
  readonly revision: Ref<number>
  /** Accumulated events for the current target. */
  readonly events: Ref<TranscriptEvent[]>
}

export interface EventPollerOptions {
  /** Key of the agent currently being polled, or `null` to pause. */
  readonly currentKey: () => string | null
  /** Project the key belongs to, or `null` to pause. */
  readonly currentProject: () => string | null
  /** Active time-range filter, forwarded to the API. */
  readonly currentHours: () => number
  readonly cursor: EventCursor
  /** Transport; must resolve `null` for failed or superseded requests. */
  readonly request: (
    url: string,
    isCurrent: () => boolean,
  ) => Promise<EventsResponse | null>
  /** Called after a poll settles while its target is still the newest one. */
  readonly settled?: (requestedKey: string) => void
}

export interface EventPoller {
  readonly poll: () => Promise<void>
  readonly reset: () => void
}

/**
 * Incrementally polls transcript events for one target, appending after the
 * cursor and replacing the buffer when the provider signals a rebuild.
 * Concurrent polls for the same target are deduplicated, and `reset`
 * invalidates every in-flight response.
 */
export function createEventPoller(options: EventPollerOptions): EventPoller {
  let generation = 0
  let pending: { readonly key: string, readonly generation: number } | null = null

  async function poll(): Promise<void> {
    const key = options.currentKey()
    const project = options.currentProject()
    if (!key || !project) return
    const hours = options.currentHours()
    const requestKey = `${project}\0${key}\0${hours}`
    const requestGeneration = generation
    if (pending?.key === requestKey && pending.generation === requestGeneration) return
    const request = { key: requestKey, generation: requestGeneration }
    pending = request
    const isCurrent = () => generation === requestGeneration
      && options.currentKey() === key
      && options.currentProject() === project
      && options.currentHours() === hours
    try {
      const response = await options.request(
        `/api/events?project=${encodeURIComponent(project)}&key=${encodeURIComponent(key)}&since=${options.cursor.since.value}&revision=${options.cursor.revision.value}&hours=${hours}`,
        isCurrent,
      )
      if (!response || !isCurrent()) return
      options.cursor.since.value = response.next
      options.cursor.revision.value = response.revision
      options.cursor.events.value = response.reset
        ? [...response.events]
        : [...options.cursor.events.value, ...response.events]
    } finally {
      if (pending === request) pending = null
      if (generation === requestGeneration) options.settled?.(key)
    }
  }

  function reset(): void {
    generation += 1
    options.cursor.since.value = 0
    options.cursor.revision.value = 0
    options.cursor.events.value = []
  }

  return { poll, reset }
}
