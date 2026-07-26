# Agent guide

## Purpose

`liveclaudecode` is a local, read-only Nuxt dashboard for observing a running
Claude Code session and its subagents. It reads Claude Code JSONL transcripts
from disk and presents the run hierarchy, timeline, activity, diagnostics, and
changed files. It must remain useful without telemetry or runtime network
access. See `README.md` for the product behavior and transcript model.

## Repository map

- `app/` — Nuxt/Vue UI, client state, and display helpers.
- `server/api/` — thin Nitro/h3 adapters; no domain logic.
- `server/utils/` — Effect services, transcript parsing, project resolution,
  run aggregation, and the Effect-to-HTTP bridge.
- `shared/schemas/` — Effect `Schema` definitions for external data.
- `shared/types/` — contracts shared by client and server.
- `bin/liveclaudecode` — CLI launcher.
- `test/{unit,nuxt,e2e}/` — Node units, mounted Nuxt components, and built API
  integration tests; `test/fixtures/` contains synthetic data and test services.
- `repos/effect/` — vendored Effect source-of-truth. It is read-only reference
  material; never edit anything under `repos/`.

Generated directories such as `.nuxt/` and `.output/` are not source code.

## Working in this repository

- Use Node 22+ and pnpm 11.
- Inspect the nearest implementation and tests before changing behavior.
- Keep the server read-only with respect to Claude transcript data.
- Run the narrowest relevant test while iterating. Before handing off a change,
  run `pnpm check` when practical; it runs tests, typechecking, and the build.
- Useful narrower commands are `pnpm test:unit`, `pnpm test:nuxt`,
  `pnpm test:e2e`, `pnpm test:types`, and `pnpm build`.

## Architecture boundaries

- Keep `app/**` in plain TypeScript. Do not introduce Effect into Vue
  components or composables.
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

## Effect v4

This project uses Effect `4.0.0-beta.101`. Training knowledge and online posts
usually describe v3 and are unsafe sources for API decisions.

Before writing Effect code, read `repos/effect/LLMS.md`. Then consult only the
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
