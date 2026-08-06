import type * as Layer from 'effect/Layer'
import * as Atom from 'effect/unstable/reactivity/Atom'
import { Api } from '~/api/api'

/**
 * The layer the app runtime builds from.
 *
 * Writable so a test registry can substitute a stub before anything mounts.
 * `Atom.runtime` accepts a function of `AtomContext` and holds the layer it
 * returns in a per-registry node, so one registry's substitution is invisible to
 * another — proven by `test/unit/atoms/harness.spec.ts`.
 *
 * `AtomRegistry.make({ initialValues })` is not an alternative: seeding marks
 * the node stale but `value()` calls `read` *before* checking that flag, so a
 * seeded atom displays the seeded value and issues the real request anyway.
 *
 * `Layer.MemoMap` is keyed by layer reference identity, so each test must
 * construct its own stub layer value — two tests sharing one layer object share
 * its build.
 *
 * `keepAlive` is load-bearing rather than an optimisation. This node holds a
 * *value*, not a subscription, and it is written before anything reads it; left
 * disposable, the registry's idle sweep discards it during the first await of a
 * mount and the next read rebuilds it from this default — silently handing a
 * test the real `FetchHttpClient`.
 */
export const apiLayerAtom = Atom.make<Layer.Layer<Api>>(Api.layer).pipe(Atom.keepAlive)

/** The runtime every module-level atom in `app/atoms/**` is built from. */
export const appRuntime = Atom.runtime(get => get(apiLayerAtom))
