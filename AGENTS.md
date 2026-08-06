# Agent guide

## Purpose

`liveclaudecode` is a local, read-only Nuxt dashboard for observing running
Claude Code, OpenAI Codex, GitHub Copilot CLI, and VS Code Copilot Chat
sessions and their subagents. It reads session transcripts from disk and
presents the run hierarchy, timeline, activity, diagnostics, and changed
files. It must remain useful without telemetry or runtime network access. See
`README.md` for the product behavior and transcript model.

## Repository map

- `app/` — Nuxt/Vue UI, client state, and display helpers.
- `server/api/` — thin Nitro/h3 adapters; no domain logic.
- `server/utils/` — Effect services, transcript parsing, project resolution,
  run aggregation, and the Effect-to-HTTP bridge.
- `shared/schemas/` — Effect `Schema` definitions for external data.
- `shared/types/` — contracts shared by client and server.
- `bin/liveclaudecode` — CLI launcher.
- `electron/` — desktop shell. `main.js` is the Electron entry; `desktop.js`
  holds the Electron-free logic it is assembled from.
- `test/{unit,nuxt,e2e}/` — Node units, mounted Nuxt components, and built API
  integration tests; `test/fixtures/` contains synthetic data and test services.
- `repos/effect/` — vendored Effect source-of-truth. It is read-only reference
  material; never edit anything under `repos/`.

Generated directories such as `.nuxt/`, `.output/`, and `dist-desktop/` are not
source code.

## Working in this repository

- Use Node 22+ and pnpm 11.
- Inspect the nearest implementation and tests before changing behavior.
- Keep the server read-only with respect to Claude transcript data.
- Run the narrowest relevant test while iterating. Before handing off a change,
  run `pnpm check` when practical; it runs linting, tests, typechecking, and
  the build.
- Useful narrower commands are `pnpm lint`, `pnpm test:unit`, `pnpm test:nuxt`,
  `pnpm test:e2e`, `pnpm test:desktop`, `pnpm test:types`, and `pnpm build`.
- `pnpm test:types` checks the Nuxt projects and, via `tsconfig.test.json`,
  the plain-node test sources (`test/unit`, `test/e2e`, `test/fixtures`,
  `test/browser`, `test/desktop`, and the Playwright configs). Keep test code
  typecheck-clean too.

## Architecture boundaries

- Keep `electron/**` in plain JavaScript with hand-written `.d.ts` siblings, the
  way `bin/` does; Electron loads it with no build step, and Effect has no place
  there. Electron APIs stay in `electron/main.js`; anything worth asserting on
  goes in `electron/desktop.js` behind injected dependencies. Do not add a
  preload bridge or otherwise hand the renderer access to Node.
- Use Effect at data and I/O boundaries in `shared/schemas/**` and
  `server/utils/**`.
- Keep `server/api/**` limited to reading request context, running an Effect,
  and returning its result. Domain logic belongs in `server/utils/**`.
- Parse external data with Effect `Schema`; do not hand-roll validation or add
  new Zod schemas.
- Model state and I/O as services supplied by `Layer`. Do not add module-level
  mutable state or test-only dependency parameters.
- In server domain code, use the Effect filesystem and clock abstractions rather
  than `node:fs`, `Date`, or `Date.now()`.
- Domain failures belong in the typed error channel as
  `Schema.TaggedErrorClass` values. `server/utils/runtime.ts` is the sole place
  that translates those failures to h3 errors; keep its mapping exhaustive.

## Frontend reactivity (`app/**`)

This replaces the former rule "Keep `app/**` in plain TypeScript. Do not
introduce Effect into Vue components or composables." What that rule protected —
an Effect-free, declarative render layer with display logic that unit-tests
without mounting — survives. Only the mechanism changed.

### Layout

- `app/api/**` — the client-side `Api` service. Plain Effect v4, held to the
  same rules as `server/utils/**`: `Context.Service`, `Layer`,
  `Schema.TaggedErrorClass`, `Effect.catch`, named `Effect.fn` with `Effect.gen`
  inside and combinators as trailing arguments. No module-level mutable state,
  no test-only dependency parameters.
- `app/atoms/**` — Effect v4 atoms. The only place in `app/**` that constructs
  an `Effect`, a `Layer`, or a `Stream`. Deep-import
  `effect/unstable/reactivity/Atom`, never the `effect/unstable/reactivity`
  barrel (~20 KB gz more). `AtomHttpApi` and `AtomRpc` are banned outright
  (+60 KB gz, and both turn `HttpClientError` and `SchemaError` into defects),
  including through `@effect/atom-vue`, which re-exports them. Enforced by
  `no-restricted-imports` in `eslint.config.mjs`.
- `app/utils/**` — pure TypeScript, no Vue, no Effect, with one exception:
  `AsyncResult` projections may import
  `effect/unstable/reactivity/AsyncResult` (~2 KB gz) and nothing else.
  `app/utils/session-state.ts` is also imported by `server/utils/**` and must
  never gain a client-only dependency.
- `app/components/**`, `app/pages/**`, `app/composables/**` — plain Vue. No
  `Effect.gen`, no `Effect.fn`, no `Effect.run*`, no `Layer`, no
  `HttpClientRequest`, no `$fetch`.
- `app/atoms/**` and `app/api/**` must not use Nuxt *app* auto-imports
  (`useState`, `useRoute`, `useFetch`, `useNuxtApp`). `tsconfig.test.json`
  resolves `#imports` to the *nitro* auto-imports, so an app auto-import passes
  `nuxt typecheck` and fails `pnpm test:types` — but only once a `test/unit/**`
  or `test/fixtures/**` file imports the module, since `app/**` is not in that
  tsconfig's `include`. `app/plugins/atom-registry.ts` is the only exception.

### Atoms

- Each atom module exports a factory `makeXAtoms(runtime)` and a module-level
  live instance `export const xAtoms = makeXAtoms(appRuntime)`. Components
  import the live instance; tests call the factory with an isolated runtime.
- Never construct an atom inside `setup()` or any function other than a factory
  or `Atom.family` — it mints a new atom, node, and state per call. The same
  applies to the combinators: `keepAlive`, `setIdleTTL`, `withEquality`, and
  friends all return a *new* object, so applying one inside a render function
  creates a fresh atom every time.
- Parameterised atoms use `Atom.family` with an object key built by ONE exported
  key constructor per family. Keys memoise on structural `Equal`/`Hash`, so
  object literals are correct — but an explicitly-`undefined` property is a
  different key from an absent one, and a key object mutated after first use
  returns the stale atom (`Hash` caches per object). Never pass a `reactive()`
  proxy.
- `Atom.family` returns a plain function, not an atom. Policy combinators
  (`setIdleTTL`, `keepAlive`, `withEquality`) go inside the family factory.
- `Atom.family` is a memo, not a store: identity is not stable across GC for
  auto-dispose atoms. Anything holding accumulated or user-entered state needs
  `keepAlive`, an explicit `setIdleTTL`, or the registry's `defaultIdleTTL`.
- Model recurring work as `Stream.tick` inside `runtime.atom`.
  `Atom.withRefresh`, `Atom.debounce`, `Atom.swr`, and `Atom.searchParam` are
  BANNED: they schedule raw `setTimeout` and read `Date.now()`, so `TestClock`
  cannot control them. Enforced by `no-restricted-syntax` under `app/atoms/**`.
  A `Stream.tick` inside `runtime.atom` *is* controllable, because the stream is
  forked with the layer's services and `Clock` is a `Context.Reference` a layer
  can override.
- **A poll loop's per-tick effect must not fail.** A stream that fails has
  ENDED — `makeStream` writes the failure and returns, and nothing re-arms the
  loop. Fold transport failures into the emitted value with `Effect.catch`; use
  `pollingFeed` from `app/atoms/feed.ts`. Defects may terminate the stream; they
  are bugs.
- A stream atom surfaces only the *last* element of each emitted chunk. Emit one
  value per tick, or emit cumulative snapshots.
- **Never refresh a poll feed with `registry.refresh` / `useAtomRefresh`.**
  Refreshing rebuilds the node, so the stream is constructed again, `initial()`
  runs again, and the value the feed was holding is gone — a refresh against a
  server that is down empties the screen instead of going stale over the data
  already on it. Give `pollingFeed` a `pulses` stream built with
  `get.stream(pulseAtom, { withoutInitialValue: true })`: it subscribes rather
  than registering a parent, so it cannot rebuild the node either. `costs.ts` is
  the worked example.
- A writable atom that is only ever *subscribed* to is never evaluated, and its
  first write evaluates it — notifying listeners with the initial value **and**
  then the written one. Two pulses, two requests. Materialise it with
  `get.once(atom)` before subscribing.
- An atom holding configuration a test substitutes — `apiLayerAtom` — needs
  `keepAlive`. It has no subscribers of its own, so the idle sweep can discard it
  between the write and the first read and silently restore the production
  default. The same applies to any atom a *stream body* reads with `get.once`:
  `chat.ts`'s activation map has no subscribers either, and losing it stops every
  visible panel from polling.
- **A feed that has to pause reads a flag per tick; it does not change key.**
  `pollingFeed`'s `enabled` runs before each request and, when it turns one away,
  emits nothing — so the accumulator survives and a resumed feed continues from
  its cursor. Putting the flag in the `Atom.family` key makes a paused feed a
  different atom and a different node, so resuming refetches everything. Read the
  flag with `AtomContext.once`: a tracked `get` makes the feed a dependent and
  rebuilds the stream when the flag flips, which is the same loss by another
  route. A `get.once` from inside a running stream body does observe the live
  registry value — experiment E7, and `test/unit/atoms/chat.spec.ts` pins it.
- Whatever writes that flag must write it **during `setup()`**, before the feed
  is subscribed to. Subscribing starts the stream, and its first tick reads the
  flag; announcing the component from `onMounted` costs a whole interval before
  anything appears.
- Imports between `app/atoms/**` follow a one-way DAG:
  `runtime → range → tree → {filters, selection} → {run-detail, events,
  session-events} → activity`. A back-edge is a review blocker. One file per
  domain noun; a file that needs a second noun in its name is two files. A file
  may fetch OR derive, never both.
- `app/atoms/**` is not auto-imported and has no `index.ts` barrel.

### Components

- Read atoms only through `useAtomValue`, `useAtom`, and `useAtomSet` from
  `@effect/atom-vue`, always with the THUNK form: `useAtomValue(() => atom)`,
  never `useAtomValue(atom)`. The thunk is reactive — depend on a prop or a ref
  inside it and the subscription swaps when the atom identity changes.
- Call every `useAtom*` composable during `setup()`. The binding resolves the
  registry with Vue `inject` and FALLS BACK TO A MODULE-LEVEL SINGLETON instead
  of erroring, so a call from `onMounted`, a watcher, a plugin body, or a bare
  util silently binds to shared global state.
- The registry comes from `app/plugins/atom-registry.ts`. Never import
  `defaultRegistry`.
- Two-way bindings use `useAtomModel` from `app/composables/atom.ts`. The
  binding returns a readonly `Ref` plus a separate setter and ships no
  writable-ref helper.
- Mutations go through `useAtomAction` from the same file, which answers whether
  the write succeeded. Do not reach for `mode: 'promiseExit'` in a component —
  reading the `Exit` means importing Effect into the render layer, and the
  failure is already on the atom, where `toActionError` renders it from.
- Data that differs between two mount sites of the same component stays a PROP.
  Only app-wide preferences (feed density, errors-only, follow-output,
  follow-active) are read from global atoms.
- `<KeepAlive>` does not pause effect scopes in Vue 3.5 — `deactivate` moves the
  subtree and runs the `da` hooks; it never calls `scope.stop()`. A subscription
  survives deactivation and keeps polling; `test/nuxt/atom-binding.spec.ts`
  asserts this. Components under `<KeepAlive>` that drive polling write an
  `active` flag the poll atom reads per tick. Do not put that flag in the family
  key — re-keying discards the accumulated cursor.

### Async state

- The async type is `AsyncResult` (v4 core), not the v3 `Result`. Three tags —
  `Initial`, `Success`, `Failure` — and `waiting` is an orthogonal boolean on
  all three. There is no `Loading` tag, and there is no `successWithWaiting`.
- Project `AsyncResult` into a plain discriminated view model in `app/utils/**`
  and branch on a string discriminant in the template. Never render off
  `AsyncResult.value` or `getOrElse` alone: `value()` returns the retained
  `previousSuccess` on a `Failure`, so a naive render shows stale data with no
  error indication.
- **Do not use `AsyncResult.matchWithWaiting` on a stream-backed atom.** It
  returns `onWaiting` whenever `waiting` is set, before it looks at the tag, and
  a stream atom sets `waiting: true` on every chunk and clears it only when the
  stream ends. A poll loop never ends, so `matchWithWaiting` reports loading
  forever. Branch on `_tag`; see `app/utils/feed-view.ts`.
- For the same reason, do not drive a spinner off `result.waiting` for a
  stream-backed atom, and do not call `get.result(atom, { suspendOnWaiting: true })`
  or `AtomRegistry.getResult(…, { suspendOnWaiting: true })` on one — both
  suspend forever.
- Check `AsyncResult.isInterrupted` BEFORE matching. An interrupt-only cause has
  no typed error, so a matcher routes it to the defect branch, and the defect it
  hands over is a synthetic `Error("All fibers interrupted without error")`, not
  one of this app's tagged errors.
- A superseded request does not produce an interrupt `Failure` at all: the
  node's cancel removes the exit observer before interrupting the fiber. Only an
  explicit `Atom.Interrupt` write does.
- `useAtomSet(atom, { mode: 'promise' | 'promiseExit' })` never settles for
  `Atom.Reset`, because `Reset` returns the atom to `Initial` and the promise
  waits for a non-`Initial` result. Take a separate value-mode setter for
  `Reset` and `Interrupt`.
- Parse every API response with a `Schema` in `shared/schemas/api.ts`. A
  `$fetch` result cast with `as` is not validation. Decoded types are readonly
  and live under `*Wire` names; `shared/types/run.ts` keeps the mutable
  interfaces the server builds with.

### Reference

`effect/unstable/reactivity` is on the unstable path of a beta release and
`@effect/atom-vue` ships an empty test suite. Online docs, blog posts, and the
standalone `@effect-rx`/`@effect/atom` v3 packages describe a different API (v3
called the async type `Result`). The vendored source under
`repos/effect/packages/` is the only reference; `LLMS.md` and `ai-docs/` do not
cover Atom.

## Composables (`app/composables/**`)

Follow VueUse conventions:

- Keep composables single-purpose and composed from smaller pieces; pure logic
  (request gating, cursors, tree walks, caches) lives in `app/utils/**` where
  it gets plain unit tests without mounting.
- Use `shallowRef` by default. Reach for a deep `ref` only when deep
  reactivity is intentional, and treat arrays/objects held in `shallowRef` as
  immutable — replace, never mutate in place.
- Export `UseXOptions` and `UseXReturn` interfaces with JSDoc on every option
  (including `@default`) and every returned field. Options objects are the
  last parameter, defaulted to `{}`, and destructured once at the top.
- Expose outputs via `shallowReadonly`; only intentional inputs (filters,
  toggles, ranges) stay writable. Long-running work belongs in an atom, whose
  subscription lifetime replaces manual `pause`/`resume`.
- Composables do not own data fetching or polling. A composable that would poll,
  cancel, or gate requests is an atom in `app/atoms/**`. What remains here is
  component-tree-scoped context (`provide`/`inject`), thin adapters over the
  `@effect/atom-vue` composables, and view-local state.
- Register side effects with scope disposal (`tryOnScopeDispose`) inside the
  composable that created them; no manual teardown lists in consumers.
- Provide/inject pairs live together in one composable file
  (`provideX` + `useX`), never a bare key wired up by hand in a component.

## Composable and component tests

- Assert on the composable's returned refs directly; do not serialize state
  into DOM attributes.
- Stub the dashboard API with `mockLiveApi()` from `test/fixtures/live-api.ts`
  and build data with the `test/fixtures/runs.ts` builders; use `deferred()`
  from `test/fixtures/deferred.ts` for stale-response races instead of inline
  promise wiring.
- Unmount in `afterEach` (never as the last line of a test), pair
  `vi.useFakeTimers` with cleanup, and prefer `vi.advanceTimersByTimeAsync`
  so reactivity settles.

## Effect v4

This project uses Effect `4.0.0-beta.101`. Training knowledge and online posts
usually describe v3 and are unsafe sources for API decisions.

Before touching any Effect code — every time, including small edits — invoke
the `effect` skill (`.claude/skills/effect`). It is the opinionated guide for
this project's Effect v4 usage and takes precedence over recollection of
earlier sessions.

Then read `repos/effect/LLMS.md`, and consult only the
relevant runnable examples under `repos/effect/ai-docs/src/**`; use
`repos/effect/packages/effect/SCHEMA.md` for Schema work and
`repos/effect/packages/effect/src/**` when behavior or API availability is in
question. Do not use `node_modules`, effect.website, or blog posts as Effect
documentation.

Common v3 traps: use `Context.Service`, `Schema.TaggedErrorClass`, and
`Effect.catch`; `Effect.Service`, `Data.TaggedError`, `Schema.TaggedError`, and
`Effect.catchAll` do not exist here. Import `Schema` from `effect`.

Follow the local Effect style: define effectful functions with named
`Effect.fn`, use `Effect.gen` inside them, attach combinators as trailing
arguments rather than piping an `Effect.fn`, and use `Predicate` instead of
custom type guards. Defaults belong in schemas, and failures must not be
silently caught.

## Testing

- Use `it.effect` for tests that touch services; use `it.live` only when real
  time is required. Control time with `TestClock`.
- Unit tests must not touch the real filesystem. Use `testFileSystem()` from
  `test/fixtures/filesystem.ts`; real filesystem coverage belongs in `test/e2e`.
- Provide stateful layers per test so caches do not leak between cases.
- Atom tests are registry-driven and live in `test/unit/atoms/**` (node
  environment, no mounting — nothing in `Atom.ts` or `AtomRegistry.ts` imports
  Vue). Use `testAtoms()` from `test/fixtures/atom-registry.ts` and drive time
  with `TestClock`. No `vi.useFakeTimers`, no `flushPromises`.
- `TestClock` reaches a `Stream.tick` inside `runtime.atom`, because the stream
  is forked with the layer's services. It does NOT reach `Atom.setIdleTTL`, the
  registry's `defaultIdleTTL`, or node removal — those use raw `setTimeout` and
  a macrotask. Anything asserting on disposal needs real or `vi`-faked timers,
  and a macrotask flush rather than `await nextTick()`. Keep those cases in their
  own file — `test/unit/atoms/chat-lifetime.spec.ts` — so the behaviour spec next
  to it stays timer-free and fast.
- Assert an out-of-band emission with `published()` from
  `test/fixtures/atom-registry.ts`, not by advancing the clock: it suspends until
  the atom publishes again. A merged pulse stream registers its listener one
  scheduler turn after the feed's first value, so drain that value and yield
  before writing the pulse — no user can click inside that window, but a test
  can, and the symptom is a hang.
- Stub `Api` at the service boundary for pages and atoms, but keep `Api.layer`
  itself covered from below, against a fake `FetchHttpClient.Fetch`
  (`test/fixtures/api-transport.ts`, used by `test/unit/api/**`). Everything
  between the service and the socket — status handling, error classification,
  request body encoding, response decoding, and the URL the client actually
  built — is invisible to a service-level stub.
- A mounted component's poll loop is driven with a **pulse**, not with faked
  timers: write the feed's pulse atom through the mount's own registry and
  flush. A pulse and an interval tick enter `pollingFeed` through the same step,
  so a gate that turns one away turns the other away too, and the interval
  itself is covered by `TestClock` in the atom spec.
- `@effect/atom-vue` ships a placeholder test suite, so
  `test/nuxt/atom-binding.spec.ts` owns coverage of the binding itself:
  synchronous value before first render, re-subscription on thunk dependency
  change, cleanup on unmount, `KeepAlive` survival, and registry isolation.
- Prefer `assert.strictEqual` and `assert.deepStrictEqual` from
  `@effect/vitest`. Use bounded property tests for invariants where examples
  are insufficient.

## Cassettes

`test/cassettes/` holds recorded, redacted sessions captured from real runs of
each supported tool. They answer a question synthetic fixtures cannot: *does
this still work against what the tools actually emit?* Synthetic fixtures stay
exactly as they are and remain the right tool for edge cases — a malformed
line, a zero-token turn, the exact boundary of `LIVE_WINDOW`.

- **Never hand-edit a cassette.** They are recordings. To change one, re-record
  it with `pnpm cassette:record`; to add a variation, add a new cassette.
  `pnpm cassette:verify` checks every file against its recorded hash.
- **Add one** when a supported tool ships a format change, or when a transcript
  shape the dashboard depends on is not represented. Write the scenario into
  `docs/cassette-scenarios.md` *before* recording it, and record against the
  generated sandbox — never against real work.
- **Blessing is explicit.** `pnpm cassette:bless` rewrites the committed
  `expected/*.json`, and `pnpm cassette:bless:api` the e2e projection. Neither
  runs in CI. A pull request that changes a blessed file must explain the change
  in its description; that diff is the point of the system.
- The recorder names every key no classification table covers. Classify new keys
  in `test/cassettes/redaction/rules.ts` before committing, or the alarm stops
  meaning anything.

See `docs/transcript-cassettes-spec.md` for the design.
