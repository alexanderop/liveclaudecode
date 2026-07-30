import { parseHours } from '#shared/schemas/request'

export function resolveHours(configuredValue: unknown, requestedValue: unknown): number {
  return parseHours(configuredValue, requestedValue)
}
