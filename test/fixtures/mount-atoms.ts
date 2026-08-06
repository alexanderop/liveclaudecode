import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { GlobalMountOptions, VueWrapper } from '@vue/test-utils'
import { registryKey } from '@effect/atom-vue'
import * as AtomRegistry from 'effect/unstable/reactivity/AtomRegistry'
import { apiLayerAtom } from '~/atoms/runtime'
import { stubApi, type StubApi, type StubApiHandlers } from './stub-api'

/**
 * This file is typechecked under both `tsconfig.test.json` (nitro, no app
 * auto-imports) and the Nuxt app tsconfig, so every Vue-side symbol is imported
 * explicitly and `global` reuses `@vue/test-utils`' own type rather than a
 * hand-rolled shape that would only accidentally line up.
 */
export interface MountWithAtomsOptions {
  /** Endpoints this test scripts. Anything omitted becomes a named defect. */
  readonly api?: StubApiHandlers
  /** Route to mount at, e.g. `/costs?hours=24`. */
  readonly route?: string
  readonly props?: Record<string, unknown>
  /** Forwarded as-is, except that `provide` also carries the registry. */
  readonly global?: GlobalMountOptions
}

export interface MountedAtoms {
  readonly wrapper: VueWrapper
  /** This mount's registry. Dispose it alongside `wrapper.unmount()`. */
  readonly registry: AtomRegistry.AtomRegistry
  /** The stub behind `apiLayerAtom`, and its call logs. */
  readonly api: StubApi
}

/**
 * Mounts a component against an isolated atom registry and a stub `Api`.
 *
 * Both are built fresh per call. The registry has to be, or one test's atom
 * state answers the next test's read; the *layer* has to be for a subtler
 * reason — `Layer.MemoMap` is keyed by layer reference identity, so a shared
 * layer object would be built once and its call log shared across mounts.
 *
 * The layer is written into `apiLayerAtom` **before** mounting. Seeding the
 * registry with `initialValues` is not an alternative: `value()` calls
 * `this.atom.read(…)` before it looks at the seeded flag
 * (`AtomRegistry.ts:619-634`), so a seeded atom shows the seed *and* issues the
 * real request.
 */
export const mountWithAtoms = async (
  component: Parameters<typeof mountSuspended>[0],
  options: MountWithAtomsOptions = {},
): Promise<MountedAtoms> => {
  const api = stubApi(options.api)
  // 400ms idle grace, matching `app/plugins/atom-registry.ts`.
  const registry = AtomRegistry.make({ defaultIdleTTL: 400 })
  registry.set(apiLayerAtom, api.layer)

  const wrapper = await mountSuspended(component, {
    props: options.props,
    route: options.route,
    global: {
      ...options.global,
      provide: { ...options.global?.provide, [registryKey]: registry },
    },
  })

  return { wrapper, registry, api }
}
