import type { ShallowRef } from 'vue'
import type { EventsResponse, TranscriptEvent } from '#shared/types/run'
import { createEventPoller } from '~/utils/event-poller'

export interface UseEventStreamOptions {
  /** Key of the agent to stream; `null` skips polling. */
  readonly key: () => string | null
  /** Project the key belongs to; `null` skips polling. */
  readonly project: () => string | null
  /** Active time-range filter, forwarded to the API. */
  readonly hours: () => number
  /** Transport; must resolve `null` for failed or superseded requests. */
  readonly request: (
    url: string,
    isCurrent: () => boolean,
  ) => Promise<EventsResponse | null>
  /** Called after a poll settles while its target is still the newest one. */
  readonly settled?: (requestedKey: string) => void
}

export interface UseEventStreamReturn {
  /** Accumulated transcript events for the current target. */
  readonly events: ShallowRef<TranscriptEvent[]>
  /** Fetch the next batch after the cursor; deduplicates concurrent calls. */
  readonly poll: () => Promise<void>
  /** Clear the buffer and invalidate in-flight responses. */
  readonly reset: () => void
}

/**
 * Cursor-based incremental transcript stream for one agent. The buffer is
 * replaced wholesale when the provider signals a transcript rebuild and
 * cleared on `reset`, e.g. when the target changes.
 */
export function useEventStream(options: UseEventStreamOptions): UseEventStreamReturn {
  const events = shallowRef<TranscriptEvent[]>([])
  const since = shallowRef(0)
  const revision = shallowRef(0)

  const poller = createEventPoller({
    currentKey: options.key,
    currentProject: options.project,
    currentHours: options.hours,
    cursor: { since, revision, events },
    request: options.request,
    settled: options.settled,
  })

  return { events, poll: poller.poll, reset: poller.reset }
}
