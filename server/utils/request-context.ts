import type { H3Event } from 'h3'
import { getQuery } from 'h3'
import { parseHours } from '#shared/schemas/request'

function hoursFor(event: H3Event): number {
  return parseHours(useRuntimeConfig(event).lcc.hours, getQuery(event).hours)
}

export function browserOptionsFor(event: H3Event): { project: string, hours: number } {
  return {
    project: String(useRuntimeConfig(event).lcc.project || ''),
    hours: hoursFor(event),
  }
}
