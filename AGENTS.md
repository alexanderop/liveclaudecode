# AGENTS.md

Instructions for coding agents working in this repository.

## Reference repositories

Source-of-truth code for libraries we depend on. Treat as **read-only reference material** — do not edit files under `repos/`. When asked about a library listed below, explore its source here first instead of guessing or relying on training data.

- `repos/effect/` — https://github.com/Effect-TS/effect.git @ main (squashed)

## Effect

This project uses **Effect v4 (`4.0.0-beta.101`)**, vendored at `repos/effect/`.

### Read these before writing Effect code

1. `repos/effect/LLMS.md` — the condensed agent guide. Read it first, every time.
2. `repos/effect/ai-docs/src/**` — runnable examples, organised by topic.
3. `repos/effect/packages/effect/SCHEMA.md` — the Schema guide. 7400 lines; read it in chunks, not all at once.
4. `repos/effect/packages/effect/src/**` — the actual source. Authoritative when docs and behaviour disagree.

Do **not** consult `node_modules`, effect.website, or blog posts. They document v3.

### v4 is not v3 — this is the most common failure mode

Your training data is overwhelmingly Effect **v3**. Most v3 APIs do not exist in v4. If you catch yourself writing any of the left column, stop and use the right:

| v3 (wrong here) | v4 (correct) |
|---|---|
| `Effect.Service` | `Context.Service` |
| `Data.TaggedError` / `Schema.TaggedError` | `Schema.TaggedErrorClass` |
| `Effect.catchAll` | `Effect.catch` |
| `@effect/platform`, `@effect/platform-node` | `effect/unstable/*` |
| `@effect/schema` | `Schema` from `effect` |

`Effect.catchAll` and `Effect.Service` genuinely do not exist in this version — if you write them, the build fails. When unsure whether an API exists, grep the source:

```bash
grep -n "^export const <name>" repos/effect/packages/effect/src/Effect.ts
```

### House rules

- **Write `Effect.gen` and `Effect.fn("name")`.** Attach extra behaviour with combinators. Do not build functions that return `Effect.gen(...)` — use `Effect.fn` so we get stack traces and spans. Do not `.pipe` an `Effect.fn`; pass combinators as trailing arguments instead.
- **All parsing goes through `Schema`.** Never hand-roll validation, coercion helpers, or manual `typeof` narrowing at a data boundary. Defaults belong in the schema, not at call sites.
- **Never write your own type guards.** No `isRecord`, `isString`, `isNumber`. Use the `Predicate` module.
- **No silent `catch`.** Failures belong in the error channel as `Schema.TaggedErrorClass` types so they appear in the signature. `catch {}` that swallows an error is a bug, not a style choice.
- **Use `DateTime`, not `Date`/`Date.now()`,** in Effect code — it is Clock-driven and therefore testable.
- **Services over free functions** for anything holding state or I/O. Provide them via `Layer` rather than module-level mutable globals.

### Where Effect applies in this codebase

Effect is being adopted at the data boundary, not everywhere. Respect these lines:

| Area | Status |
|---|---|
| `shared/schemas/**` | Effect `Schema`. No zod in new code. |
| `server/utils/**` | Effect — typed errors, services, `Layer`. |
| `server/api/**` | Thin adapters only. Run the Effect, map typed errors to h3 `createError`. No domain logic. |
| `app/**` (Vue, composables) | Plain TypeScript. Do **not** introduce Effect here. |

Rationale: the parsing and filesystem layer is where the bugs are and where typed errors pay off. Vue components gain nothing and lose readability.

## Services and dependency injection

No module-level mutable state, and no parameters that exist only so tests can
inject. Both go through the context.

| Concern | Service | Provided by |
|---|---|---|
| Filesystem | `FileSystem` (`effect/FileSystem`) | `NodeFileSystem.layer` in prod, `testFileSystem()` in tests |
| Current time | `Clock` | real clock in prod, `TestClock` under `it.effect` |
| Transcript root | `ProjectsDirectory` (`Context.Reference`) | default is `~/.claude/projects` |
| Working directory | `WorkingDirectory` (`Context.Reference`) | default is `process.cwd()` |
| Parsed transcripts | `ScanCache` | `ScanCache.layer` |
| First prompts | `PromptCache` | `PromptCache.layer` |

`AppLayer` in `server/utils/services.ts` composes them. Never call `node:fs`,
`Date.now()`, or `new Date()` in `server/` — use the service.

## Errors

Domain failures are `Schema.TaggedErrorClass` types in `server/utils/services.ts`
and travel in the error channel, never as thrown exceptions or swallowed
`catch {}` blocks. `server/utils/runtime.ts` is the only place that maps them to
HTTP status codes, and its `switch` is exhaustive — a new error type there is a
compile error until it gets a status.

Currently: `InvalidRunKey` → 400, `UnknownRun`/`UnknownProject`/`NoTranscriptsFound`
→ 404, `PlatformError` → 500.

## Testing

- `pnpm test` — full vitest run; `pnpm check` also runs typecheck and build.
- Reference: `repos/effect/ai-docs/src/09_testing/`, and `packages/effect/test/`
  for real examples at scale.

**Use `it.effect` for anything touching a service.** It scopes the Effect and
provides `TestClock` + `TestConsole` automatically, so `Effect.sleep` is instant
and time is controlled with `TestClock.setTime` / `TestClock.adjust`. Use
`it.live` only when you genuinely need the real clock.

**Unit tests do not touch the disk.** Build an in-memory tree with
`testFileSystem()` from `test/fixtures/filesystem.ts`. It also takes a `denied`
list for injecting `PermissionDenied`, which is how failure paths get covered.
Real filesystem access belongs in `test/e2e` only.

**Provide layers per test, not shared**, unless the setup is genuinely
expensive. `layer(X)("name", ...)` from `@effect/vitest` builds once per block
and *shares state across the tests inside it* — that is the opposite of the
isolation these caches need.

**Assertions:** `assert.strictEqual` / `assert.deepStrictEqual` from
`@effect/vitest`, matching upstream style. Avoid `toMatchObject` for schema
results — it passes when only some fields match and hides shape drift.

**Property tests** (`it.prop`, arbitraries from `effect/testing`'s `FastCheck`)
for pure functions where example-based tests give false confidence: `pathFor`
containment, `rollup` aggregation over arbitrary trees, regex `lastIndex`
idempotence. Bound recursive arbitraries with `FastCheck.memo` and an explicit
depth — an unbounded `letrec` blows the stack instead of generating a tree.

Property tests cannot tell you a schema is wrong about reality, because
generators only produce data the schema already accepts. For that, run the
parser over the real transcript corpus.
