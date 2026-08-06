/**
 * The ranges the costs and debug pages offer, and how they read one back out of
 * the URL.
 *
 * Both pages carried their own copy of `normalizeHours` with the same four
 * values and the same 30-day default. The dashboard's own range is not one of
 * these: it is server-declared and lives in `app/atoms/range.ts` — see the note
 * there. These two pages keep their independent, URL-synced ranges on purpose,
 * because a link to a cost report is a link to a *period*.
 */
export interface RangeOption {
  readonly label: string
  readonly value: number
}

/** `0` means all time — a real value the server is asked for, never falsy. */
export const RANGE_OPTIONS: RangeOption[] = [
  { label: 'Last 24 hours', value: 24 },
  { label: 'Last 7 days', value: 168 },
  { label: 'Last 30 days', value: 720 },
  { label: 'All time', value: 0 },
]

const DEFAULT_HOURS = 720

/** Reads a range out of a query parameter, falling back to thirty days. */
export function normalizeHours(value: unknown): number {
  const parsed = Number(Array.isArray(value) ? value[0] : value)
  return RANGE_OPTIONS.some(option => option.value === parsed) ? parsed : DEFAULT_HOURS
}
