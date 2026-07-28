import { effectScope, ref, watch } from 'vue'
import { describe, expect, it } from 'vitest'
import {
  structuralComputed,
  structurallyEqual,
} from '../../app/utils/structural-computed'

describe('structuralComputed', () => {
  it('keeps its previous reference when derived content is unchanged', () => {
    const source = ref({ count: 1 })
    const value = structuralComputed(
      () => ({ items: [source.value.count] }),
      structurallyEqual,
    )
    const initial = value.value

    source.value = { count: 1 }

    expect(value.value).toBe(initial)
  })

  it('notifies dependents when derived content changes', () => {
    const scope = effectScope()
    const source = ref(1)
    let notifications = 0

    scope.run(() => {
      const value = structuralComputed(
        () => ({ count: source.value }),
        structurallyEqual,
      )
      watch(value, () => notifications++, { flush: 'sync' })
      void value.value
    })
    source.value = 2

    expect(notifications).toBe(1)
    scope.stop()
  })
})
