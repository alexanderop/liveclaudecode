import { computed, type ComputedRef } from 'vue'

export function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => structurallyEqual(value, right[index]))
  }

  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  const rightKeys = Object.keys(rightRecord)
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key =>
      Object.prototype.hasOwnProperty.call(rightRecord, key)
      && structurallyEqual(leftRecord[key], rightRecord[key]),
    )
}

export function structuralComputed<T>(
  derive: () => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
): ComputedRef<T> {
  let cached: T
  let primed = false

  return computed(() => {
    const next = derive()
    if (primed && isEqual(cached, next)) return cached
    cached = next
    primed = true
    return cached
  })
}
