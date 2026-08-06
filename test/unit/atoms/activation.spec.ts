import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import * as Atom from 'effect/unstable/reactivity/Atom'
import { makeActivation } from '~/atoms/activation'
import { testAtoms } from '../../fixtures/atom-registry'

/** A target with two fields, so identity is not just the value itself. */
interface Target {
  readonly project: string
  readonly key: string
}

const target = (project: string, key: string): Target => ({ project, key })
const identify = (value: Target): string => `${value.project}\0${value.key}`

const withActivation = Effect.fn('withActivation')(function*() {
  const atoms = yield* testAtoms(Layer.empty)
  const activation = makeActivation(identify)

  /**
   * What a feed's `enabled` predicate sees.
   *
   * `shows` takes an `AtomContext`, which only exists inside an atom's read, so
   * the question is asked the way a poll loop asks it: from within one.
   */
  const shows = (value: Target) =>
    atoms.get(Atom.make(get => activation.shows(get, value)))

  return {
    atoms,
    activation,
    shows,
    atom: activation.atom,
    show: (value: Target) => atoms.set(activation.atom, { target: value, delta: 1 }),
    hide: (value: Target) => atoms.set(activation.atom, { target: value, delta: -1 }),
  }
})

const ALPHA = target('/repo', 'alpha')
const BETA = target('/repo', 'beta')

describe('activation', () => {
  it.effect('says nothing is on screen until something says otherwise', () =>
    Effect.gen(function*() {
      const { shows } = yield* withActivation()

      assert.isFalse(yield* shows(ALPHA))
    }))

  it.effect('answers per target, not globally', () =>
    Effect.gen(function*() {
      const { shows, show } = yield* withActivation()

      yield* show(ALPHA)

      assert.isTrue(yield* shows(ALPHA))
      assert.isFalse(yield* shows(BETA))
    }))

  it.effect('reads a structurally equal target as the same one', () =>
    Effect.gen(function*() {
      const { shows, show } = yield* withActivation()

      yield* show(target('/repo', 'alpha'))

      // The component that announces and the atom that asks build their keys
      // independently and never share an object. Identity has to come from the
      // fields, which is the whole reason `makeActivation` takes an `identify`.
      assert.isTrue(yield* shows(target('/repo', 'alpha')))
    }))

  it.effect('stays on while a second holder still has it', () =>
    Effect.gen(function*() {
      const { shows, show, hide } = yield* withActivation()

      yield* show(ALPHA)
      yield* show(ALPHA)
      yield* hide(ALPHA)

      // The case a boolean gets wrong: two panels showing one conversation, and
      // the first of them closing. Counting is the only reason the second one
      // keeps polling.
      assert.isTrue(yield* shows(ALPHA))

      yield* hide(ALPHA)
      assert.isFalse(yield* shows(ALPHA))
    }))

  it.effect('forgets a target rather than keeping it at zero', () =>
    Effect.gen(function*() {
      const { atoms, atom, show, hide } = yield* withActivation()

      yield* show(ALPHA)
      yield* hide(ALPHA)

      // A dashboard left open cycles through every session the user browses. An
      // entry that lingered at 0 would make this map grow for the lifetime of
      // the page, and it is `keepAlive`, so nothing would ever collect it.
      assert.deepStrictEqual([...(yield* atoms.get(atom)).keys()], [])
    }))

  it.effect('is kept alive, having no subscriber of its own to keep it', () =>
    Effect.gen(function*() {
      const { atom } = yield* withActivation()

      // Nothing ever subscribes to this map — it is written by whatever is on
      // screen and read with `once` from inside running streams. Left
      // disposable, the registry's idle sweep would discard it between a write
      // and the next tick and hand every reader an empty map, at which point
      // every visible panel silently stops polling.
      assert.isTrue(atom.keepAlive)
    }))

  it.effect('does not make its readers depend on it', () =>
    Effect.gen(function*() {
      const { atoms, activation, show, hide } = yield* withActivation()
      let reads = 0
      const reader = Atom.make((get) => {
        reads += 1
        return activation.shows(get, ALPHA)
      })

      yield* atoms.mount(reader)
      yield* atoms.get(reader)
      const before = reads

      yield* show(ALPHA)
      yield* hide(ALPHA)
      yield* atoms.get(reader)

      // `shows` reads with `once`. A tracked `get` would make every gated feed a
      // dependent of this map, so a panel appearing anywhere would rebuild every
      // running stream — and a rebuild runs `initial()` again, discarding the
      // cursor the gate exists to protect. Pausing would cost what re-keying
      // costs, and the gate would be pointless.
      assert.strictEqual(reads, before)
    }).pipe(Effect.scoped))
})
