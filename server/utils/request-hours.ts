export function resolveHours(configuredValue: unknown, requestedValue: unknown): number {
  const configured = Number(configuredValue)
  const fallback = Number.isFinite(configured) && configured >= 0 ? configured : 168
  if (typeof requestedValue !== 'string' || !requestedValue.trim()) return fallback

  const hours = Number(requestedValue)
  return Number.isFinite(hours) && hours >= 0 ? hours : fallback
}
