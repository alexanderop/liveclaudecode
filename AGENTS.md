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

- Keep `app/**` in plain TypeScript. Do not introduce Effect into Vue
  components or composables.
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
  toggles, ranges) stay writable. Long-running work should expose
  `pause`/`resume` controls.
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
- Prefer `assert.strictEqual` and `assert.deepStrictEqual` from
  `@effect/vitest`. Use bounded property tests for invariants where examples
  are insufficient.
