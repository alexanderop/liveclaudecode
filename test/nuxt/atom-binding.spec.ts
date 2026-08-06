import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { registryKey, useAtom, useAtomValue } from '@effect/atom-vue'
import * as Atom from 'effect/unstable/reactivity/Atom'
import * as AtomRegistry from 'effect/unstable/reactivity/AtomRegistry'
import { useAtomModel } from '~/composables/atom'

/**
 * `@effect/atom-vue` ships a 94-byte placeholder test suite, so this file owns
 * coverage of the binding itself: that the registry provide reaches
 * `injectRegistry`, that the thunk is reactive, that unmounting releases the
 * subscription, that a `<KeepAlive>`'d component keeps its subscription, and
 * that two registries do not share state.
 */

let component: VueWrapper | null = null

afterEach(() => {
  component?.unmount()
  component = null
})

/** Module scope on purpose: an atom built inside `setup()` is a new atom. */
const countAtom = Atom.make(0)
const familyAtom = Atom.family((key: { readonly id: string }) => Atom.make(`initial-${key.id}`))

const mountWith = async (component_: Parameters<typeof mountSuspended>[0], options: {
  readonly registry?: AtomRegistry.AtomRegistry
  readonly props?: Record<string, unknown>
} = {}) => {
  const registry = options.registry ?? AtomRegistry.make({ defaultIdleTTL: 400 })
  const wrapper = await mountSuspended(component_, {
    props: options.props,
    global: { provide: { [registryKey]: registry } },
  })
  return { wrapper, registry }
}

const Counter = defineComponent({
  setup() {
    const [count, setCount] = useAtom(() => countAtom)
    return () => h('button', { onClick: () => setCount(count.value + 1) }, String(count.value))
  },
})

describe('@effect/atom-vue binding', () => {
  // -------------------------------------------------------------- E1
  it('reads the registry provided through the Vue app, not the module singleton', async () => {
    const { wrapper, registry } = await mountWith(Counter)
    component = wrapper

    expect(wrapper.text()).toBe('0')
    await wrapper.get('button').trigger('click')
    expect(wrapper.text()).toBe('1')
    expect(registry.get(countAtom)).toBe(1)
  })

  it('a second mount with its own registry does not see the first mount\'s write', async () => {
    const first = await mountWith(Counter)
    await first.wrapper.get('button').trigger('click')
    await first.wrapper.get('button').trigger('click')
    expect(first.wrapper.text()).toBe('2')
    first.wrapper.unmount()

    const second = await mountWith(Counter)
    component = second.wrapper

    // Same module-scope atom, different registry. If the provide had missed and
    // both fell back to `defaultRegistry`, this would read '2'.
    expect(second.wrapper.text()).toBe('0')
  })

  it('publishes a value synchronously, before the first render', async () => {
    const registry = AtomRegistry.make({ defaultIdleTTL: 400 })
    registry.set(countAtom, 41)

    const Probe = defineComponent({
      setup() {
        const value = useAtomValue(() => countAtom)
        // Read during setup, not in a lifecycle hook: the binding subscribes
        // with `{ immediate: true }`, so the ref is populated straight away.
        const atSetup = value.value
        return () => h('span', String(atSetup))
      },
    })

    const { wrapper } = await mountWith(Probe, { registry })
    component = wrapper
    expect(wrapper.text()).toBe('41')
  })

  it('re-subscribes when the thunk\'s dependencies change', async () => {
    // The ref lives outside the component so the test drives it directly; a
    // `wrapper.vm` write would need a cast to reach a `setup()`-returned ref.
    const id = ref('a')
    const Switcher = defineComponent({
      setup() {
        const value = useAtomValue(() => familyAtom({ id: id.value }))
        return () => h('span', value.value)
      },
    })

    const { wrapper } = await mountWith(Switcher)
    component = wrapper

    expect(wrapper.text()).toBe('initial-a')
    id.value = 'b'
    await nextTick()
    expect(wrapper.text()).toBe('initial-b')
  })

  it('memoises family keys structurally, so a fresh object literal is the same atom', () => {
    expect(familyAtom({ id: 'x' })).toBe(familyAtom({ id: 'x' }))
    expect(familyAtom({ id: 'x' })).not.toBe(familyAtom({ id: 'y' }))
  })

  it('releases its subscription on unmount', async () => {
    const { wrapper, registry } = await mountWith(Counter)
    const node = registry.getNodes().get(countAtom)
    expect(node).toBeDefined()
    expect(node?.listeners.size).toBeGreaterThan(0)

    wrapper.unmount()
    await nextTick()
    expect(node?.listeners.size).toBe(0)
  })

  it('keeps the subscription alive while deactivated under KeepAlive', async () => {
    const shown = ref(true)
    const Harness = defineComponent({
      components: { Counter },
      setup() {
        return { shown }
      },
      template: `<KeepAlive :max="10"><Counter v-if="shown" /></KeepAlive>`,
    })

    const { wrapper, registry } = await mountWith(Harness)
    component = wrapper

    await wrapper.get('button').trigger('click')
    expect(registry.get(countAtom)).toBe(1)

    const node = registry.getNodes().get(countAtom)
    const whileActive = node?.listeners.size ?? 0

    shown.value = false
    await nextTick()

    // Vue 3.5's `deactivate` moves the subtree and runs the `da` hooks; it never
    // calls `scope.stop()`, so the binding's `watchEffect` — and therefore the
    // registry subscription — survives. Components under KeepAlive that drive
    // polling must gate the work themselves.
    expect(node?.listeners.size).toBe(whileActive)
  })

  it('useAtomModel writes back through a v-model binding', async () => {
    const Model = defineComponent({
      setup() {
        return { count: useAtomModel(() => countAtom) }
      },
      template: `<input :value="count" @input="count = Number($event.target.value)">`,
    })

    const { wrapper, registry } = await mountWith(Model)
    component = wrapper

    const input = wrapper.get('input')
    expect(input.element.value).toBe('0')

    await input.setValue('7')
    expect(registry.get(countAtom)).toBe(7)
    expect(input.element.value).toBe('7')
  })
})
