/**
 * The status vocabulary transcripts use to report an explicit tool/command
 * outcome. Codex and Copilot both write a free-form `status` string; these
 * are the values observed in practice. Declared once here so both scanners
 * derive the same `FAILED`/`PASSED` sets instead of maintaining copies.
 */
export const FAILED_OUTCOME_STATUSES = [
  'failed',
  'error',
  'denied',
  'cancelled',
  'canceled',
  'timed_out',
  'timeout',
] as const

export const PASSED_OUTCOME_STATUSES = [
  'completed',
  'success',
  'succeeded',
  'ok',
  'passed',
] as const

export const FAILED_OUTCOME_STATUS_SET: ReadonlySet<string> = new Set(FAILED_OUTCOME_STATUSES)
export const PASSED_OUTCOME_STATUS_SET: ReadonlySet<string> = new Set(PASSED_OUTCOME_STATUSES)
