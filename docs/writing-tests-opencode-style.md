# Writing Tests Like opencode, In This Repository

## Practical guide

**Companion to:** `docs/opencode-testing-strategy.md` (what they do and why)
and `docs/transcript-cassettes-spec.md` (the one big thing to adopt)
**Scope:** patterns you can apply today, translated from Bun + hand-rolled
harness to `@effect/vitest` + Vitest projects
**Status:** guidance, not a plan. Nothing here needs a migration.

Read the strategy document first if you want the argument. This one is the
cookbook: each section is *their pattern → what it becomes here → when not to
use it*.

One framing point before the recipes. opencode hand-rolled a test harness
because they run on Bun and `@effect/vitest` was not available to them. Almost
every clever thing in `packages/core/test/lib/effect.ts` already exists in the
package you already depend on. **The main opportunity is not copying their
code — it is using the features you are paying for and currently ignoring:**

| Feature | opencode | Available here | Currently used |
| --- | --- | --- | ---: |
| Layer-bound `it` | `testEffect(layer)`, hand-written | `it.layer(layer)` | **0** |
| Loud stub services | `Effect.die("unused")`, by hand | `Layer.mock` | **0** |
| Table-driven Effect tests | manual `forEach` | `it.effect.each` | **0** |
| Property tests from schemas | 1 test, `fast-check` directly | `it.effect.prop` | **0** |
| Flaky-test retry wrapper | none | `flakyTest` | 0 |
| `TestClock` | 4 files | `TestClock` | 32 ✅ |

---

## 1. Bind the layer once, not per test

**Their pattern.** `testEffect(layer)` returns an `it` with the layer already
provided, so no test body mentions `Effect.provide`:

```ts
// packages/core/test/tool-read.test.ts
const readLayer = (imageLayer) => AppNodeBuilder.build(/* … */)
const it = testEffect(readLayer(imageLayer))
const itWithoutResizer = testEffect(readLayer(unavailableImage))

it.effect("registers, authorizes, and reads through the location filesystem", () =>
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    // …
  }),
)
```

**Here.** `@effect/vitest` ships this as `it.layer`, and it nests:

```ts
import { assert, describe, it } from '@effect/vitest'

describe('run aggregation', () => {
  it.layer(baseLayer)('with the default cache', (it) => {
    it.effect('groups sidechains under their spawning tool call', () =>
      Effect.gen(function*() {
        const catalog = yield* SessionCatalog
        // …
      }))
  })
})
```

**What this replaces.** `Effect.provide` appears **156 times** in
`test/unit/**` today. `test/unit/scan-cache.spec.ts` repeats this five times:

```ts
// before
it.effect('evicts the least recently used idle scan at capacity', () =>
  Effect.gen(function*() { /* … */ })
    .pipe(Effect.provide(Layer.mergeAll(ScanCache.layer, testFileSystem(tree)))))
```

**The caveat that matters here.** `it.layer` **memoizes** the layer for the
whole block. That is the point — it is why it is fast — and it directly
conflicts with the CLAUDE.md rule "provide stateful layers per test so caches
do not leak between cases."

So the rule of thumb:

| Layer contains | Use |
| --- | --- |
| Pure config, references, stateless services | `it.layer(…)` |
| A cache, a `Ref`, a queue, an open scope, anything accumulating | **per-test `Effect.provide`** |

`ScanCache` is a cache. It stays as it is. A layer that only supplies
`ProjectsDirectory` and a read-only `testFileSystem` is a good `it.layer`
candidate.

---

## 2. Stub services that fail loudly

**Their pattern**, written by hand in `tool-read.test.ts`:

```ts
const permission = Layer.succeed(PermissionV2.Service, PermissionV2.Service.of({
  assert: (input) => Effect.sync(() => { assertions.push(input) }),
  ask:   () => Effect.die("unused"),
  reply: () => Effect.die("unused"),
  get:   () => Effect.die("unused"),
  list:  () => Effect.die("unused"),
}))
```

Every method the test does not expect dies on call. That is much better than a
`vi.fn()` returning `undefined`, which turns "we called the wrong thing" into
a confusing downstream `TypeError`.

**Here — use the built-in.** Effect v4 ships `Layer.mock`, which does exactly
this and is what opencode themselves reach for in their newer tests
(`session-runner.test.ts` uses `Layer.mock(SkillGuidance.Service, {…})` while
`tool-read.test.ts` still hand-rolls it):

```ts
import { Layer } from 'effect'

const chat = Layer.mock(ChatStore, {
  send: () => Effect.succeed({ accepted: true }),
  // cancel, status, subscribe: omitted → any call fails with an
  // "unimplemented" defect naming the member
})
```

From `Layer.ts` in the vendored source:

> Missing members … will fail with an unimplemented defect when used.

Non-effectful properties stay required, so you cannot forget a plain field.
This is a strict upgrade over both `Effect.die("unused")` and `vi.fn()`, and
nothing in `test/` uses it yet.

---

## 3. Observing calls without module-level mutable state

This is the one place to **not** copy opencode. Their tests carry file-level
mutable state reset in `beforeEach`:

```ts
// packages/core/test/tool-read.test.ts — do not do this here
const assertions: PermissionV2.AssertInput[] = []
const readCalls: { input: AbsolutePath, page: PageInput }[] = []
let allow = true
let resolvedType: "file" | "directory" = "file"

beforeEach(() => {
  assertions.length = 0
  readCalls.length = 0
  allow = true
  resolvedType = "file"
})
```

It works, and it is order-sensitive: a test that fails early leaves state
behind, `it.only` changes behavior, and the reset list must be maintained by
hand as the file grows. CLAUDE.md forbids it, correctly.

**The compliant equivalent** keeps the recorder inside the layer, so each
layer construction gets its own. Add to `test/fixtures/`:

```ts
// test/fixtures/call-log.ts
import { Effect, Ref } from 'effect'

export interface CallLog<A> {
  /** Append one observed call. */
  readonly record: (value: A) => Effect.Effect<void>
  /** Everything recorded so far, oldest first. */
  readonly all: Effect.Effect<ReadonlyArray<A>>
}

export const makeCallLog = <A>(): Effect.Effect<CallLog<A>> =>
  Effect.gen(function*() {
    const entries = yield* Ref.make<ReadonlyArray<A>>([])
    return {
      record: value => Ref.update(entries, current => [...current, value]),
      all: Ref.get(entries),
    }
  })
```

Then build the stub and its log together, returning both:

```ts
function permissionLayer(decision: 'allow' | 'reject') {
  return Effect.gen(function*() {
    const log = yield* makeCallLog<PermissionRequest>()
    const layer = Layer.succeed(Permission, {
      assert: request => log.record(request).pipe(
        Effect.andThen(decision === 'allow' ? Effect.void : Effect.fail(new Blocked())),
      ),
    })
    return { layer, log }
  })
}

it.effect('asks before reading outside the project', () =>
  Effect.gen(function*() {
    const { layer, log } = yield* permissionLayer('allow')
    yield* readTool({ path: '../outside.ts' }).pipe(Effect.provide(layer))
    assert.deepStrictEqual(yield* log.all, [{ action: 'read', resource: '../outside.ts' }])
  }))
```

No `beforeEach`, no reset list, no cross-test leakage, and `it.only` behaves.

`test/fixtures/filesystem.ts` already does the compliant version of this with
`operationConcurrencyProbe()` — closure state created per call, not per
module. That is the local precedent to follow.

---

## 4. Table-driven tests and generated matrices

**Their pattern.** The golden matrix declares targets and scenarios as data,
then generates `describe` blocks (`packages/llm/test/recorded-golden.ts`):

```ts
runTarget({
  name: "Anthropic Messages",
  model: anthropicOpus,
  protocol: "messages",
  scenarios: ["streams-text", "streams-tool-call", "drives-a-tool-loop"],
})
```

Provider × protocol × transport × scenario, all from a table. Adding a
provider is one entry, not a new file.

**Here — `it.effect.each`.** Backed by Vitest's `it.for`, so the case is
passed to the body:

```ts
const SOURCES = [
  { source: 'claude' as const, scan: TranscriptScan, root: ProjectsDirectory },
  { source: 'codex' as const, scan: CodexTranscriptScan, root: CodexSessionsDirectory },
  { source: 'copilot' as const, scan: CopilotTranscriptScan, root: VsCodeUserDataDirectories },
  { source: 'copilot-cli' as const, scan: CopilotCliTranscriptScan, root: CopilotSessionStateDirectory },
]

it.effect.each(SOURCES)('$source reports zero parse issues on a clean transcript', ({ source, scan }) =>
  Effect.gen(function*() {
    const result = yield* new scan(cleanTranscriptFor(source)).refresh
    assert.strictEqual(result.parseIssues.total(), 0)
  }))
```

**Where this pays off here.** You have four transcript formats and one set of
behaviors they are all supposed to implement: a session must produce a title,
a cost sample, file changes, turn timings, and a parse-issue census. Today
those are four independent spec files (`transcript.spec.ts`,
`codex-transcript.spec.ts`, `copilot-transcript.spec.ts`,
`copilot-cli-transcript.spec.ts`), so a behavior added to one silently misses
the others.

A **cross-format conformance table** is the direct analogue of their provider
matrix, and is arguably more valuable here than anywhere in their repo:

```ts
// test/unit/source-conformance.spec.ts
const BEHAVIORS = [
  'reports a session label',
  'aggregates file changes by short path',
  'emits at least one turn timing',
  'produces a cost sample when usage is present',
  'counts malformed records into the parse census',
]
// SOURCES × BEHAVIORS, each source supplying a minimal fixture that should
// exhibit the behavior. A source that cannot satisfy one must say why in a
// documented skip, not by omission.
```

---

## 5. Time

opencode uses `TestClock` in only 4 of 658 test files. You use it in 32
places. **Keep doing what you are doing** — this is the one dimension where
your suite is materially stronger, and it is the reason
`docs/transcript-cassettes-spec.md` can assert relative-time output at all.

The pattern already in use, for reference:

```ts
it.effect('reports a session as live inside the window', () =>
  Effect.gen(function*() {
    yield* TestClock.setTime(anchor)
    const stats = yield* statsNow(scan)
    assert.strictEqual(stats.live, true)
  }))
```

Two rules worth writing down because the cassette work depends on them:

1. **Anything derived from "now" is asserted under `TestClock`, never in
   `test/e2e`, `test/browser`, or `test/desktop`.** Those tiers run against a
   real server clock.
2. `it.live` is for tests that genuinely need real time (a subprocess, a real
   timer). It is currently used 4 times, which is about right.

---

## 6. Property tests, nearly free

opencode has exactly one property test. You have `.prop(` in 12 places
already, but `it.effect.prop` can derive arbitraries **directly from your
Effect schemas**, which is the part worth exploiting:

```ts
import { it } from '@effect/vitest'
import { ClaudeRecordSchema } from '#shared/schemas/claude'

it.effect.prop(
  'every generated record survives a parse round-trip',
  { record: ClaudeRecordSchema },
  ({ record }) =>
    Effect.sync(() => {
      const parsed = parseClaudeRecord(record)
      assert.strictEqual(parsed.success, true)
    }),
)
```

Good invariants to target in this codebase — all cheap, all currently
untested by example:

- A scan's `files` map keys are always short display paths, never absolute.
- `compactText(value, limit).length <= limit` for any input.
- `totalParseIssues(addParseIssueCounts(a, b))` equals the sum of the totals.
- A run tree never contains a cycle, for any generated set of
  parent/child records.
- `formatRelativeAge` is monotonic: a larger age never formats to a smaller
  bucket.

---

## 7. Generated suites that skip when their data is missing

**Their pattern** (`packages/llm/test/recorded-runner.ts`) is the mechanism
that makes cassettes usable day to day. Four behaviors worth copying verbatim
into the cassette work:

```ts
const cassette = cassetteName(prefix, name, caseOptions)

// 1. Duplicate detection — two tests sharing a cassette name is a bug
if (cassettes.has(cassette)) throw new Error(`Duplicate recorded cassette "${cassette}"`)

// 2. Record mode via env
const recording = process.env.RECORD === "true"

// 3. Recording requires credentials; skip rather than fail without them
if (recording && missingEnv(requires).length > 0) return test.skip(name, () => {})

// 4. Replay skips when the cassette does not exist yet
if (!recording && !cassetteExists(cassette)) return test.skip(name, () => {})
```

**Translated for transcript cassettes:**

- **Duplicate detection** → two cassettes claiming the same id is a hard
  error at load, not a silent last-one-wins.
- **`RECORD=true`** → not applicable in the same form; capture is an explicit
  operator command (there is no API to hit). But `LCC_CASSETTE_BLESS=1` for
  regenerating expectations is the same shape.
- **`requires`** → a cassette can declare `requires: ["claude-code"]` so the
  recorder skips when that tool is not installed locally.
- **Skip-if-missing** → the *inverse* here. A missing cassette must **fail**,
  not skip, because §12 gate 1 requires every source to have one. Skipping is
  correct when the fixture is optional; ours are mandatory.

That inversion is worth stating explicitly, because copying their skip
behavior would silently disable the entire cassette suite the first time
someone deleted a directory.

---

## 8. The coverage gate, sized for this repo

Their gate is 2,868 LOC because it also seeds projects, authenticates, and
drives an LLM. The *mechanism* is 3 lines
(`packages/opencode/test/server/httpapi-exercise/index.ts:1759`):

```ts
const missing = effectRoutes.filter(route => !scenarios.some(s => route === routeKey(s)))
const extra   = scenarios.filter(s => !effectRoutes.includes(routeKey(s)))
if (options.failOnMissing && missing.length > 0)
  return yield* Effect.fail(new Error("one or more routes have no scenario"))
```

**Here**, the route list comes from the filesystem rather than an OpenAPI
spec, because Nitro routes are file-based:

```ts
// test/e2e/route-coverage.spec.ts
import { readdirSync } from 'node:fs'

const ROUTES = readdirSync(new URL('../../server/api', import.meta.url), { recursive: true })
  .map(String)
  .filter(name => name.endsWith('.ts'))
  .map(name => `/api/${name.replace(/\.(get|post|put|delete)\.ts$/, '')}`)

// Every spec in this project registers what it hit.
export const exercised = new Set<string>()

it('every server/api route has at least one e2e assertion', () => {
  const missing = ROUTES.filter(route => !exercised.has(route))
  assert.deepStrictEqual(missing, [], `routes with no e2e coverage: ${missing.join(', ')}`)
})
```

Wrap `$fetch` in a helper that records into `exercised`, and the bookkeeping
is automatic. Roughly 30 lines total, and it turns "we should test new
endpoints" into "you cannot merge an untested endpoint" — which is the whole
value of their 2,868.

Today all eight routes (`chat.get`, `chat.post`, `costs.get`, `debug.get`,
`events.get`, `run.get`, `session-events.get`, `tree.get`) are covered by the
single 603-line `test/e2e/api.spec.ts`. The gate is not fixing a hole; it is
keeping the hole closed.

---

## 9. Assertion helpers: canonical projections

Two small utilities of theirs are worth lifting, both in
`test/server/httpapi-exercise/assertions.ts`:

```ts
export function check(value: boolean, message: string): asserts value {
  if (!value) throw new Error(message)
}

export function stable(value: unknown): string {
  return JSON.stringify(sort(value))   // recursively key-sorted
}
```

`check` is a typed assertion that carries a sentence, so a failure reads
`"missing session abort should remain a no-op success"` instead of
`expected false to be true`. `assert.ok(cond, message)` from `@effect/vitest`
does the same thing and should be preferred here — the lesson is the *habit*
of always passing the message, not the helper.

`stable` matters more. Key-sorted JSON is what makes a golden file diffable,
and it is the foundation of the projection design in
`docs/transcript-cassettes-spec.md` §9.3. The rule that goes with it:

> Sort anything whose order is not semantic. Preserve order where order **is**
> the assertion.

For a scan projection: sort the `files` map and `counts` keys; keep
`commands`, `milestones`, `turns`, and `context` in emission order.

---

## 10. Component tests

`packages/app` has 128 test files and **zero** Effect — a hard boundary
identical to the `app/**` rule in CLAUDE.md. Their component tests are
unremarkable and yours are better instrumented:

| | opencode | here |
| --- | --- | --- |
| Environment | happy-dom preload | Nuxt environment via `defineVitestProject` |
| API stubbing | ad-hoc per test | `mockLiveApi()` from `test/fixtures/live-api.ts` |
| Data building | inline literals | `test/fixtures/runs.ts` builders |
| Race testing | inline promises | `deferred()` from `test/fixtures/deferred.ts` |

Nothing to import here. The one habit worth borrowing is **co-locating tests
with source** (`src/context/permission-auto-respond.test.ts` sits next to its
module) — but that conflicts with your `test/{unit,nuxt,e2e}` project split,
which Vitest projects require. Keep the split.

---

## 11. Playwright

Their 62 specs break down as 40 regression + 20 performance + 1 smoke +
1 user-story. Three things transfer and one should be actively resisted.

**Transfer: name specs after the bug.** `remote-tab-busy.spec.ts`,
`review-image-flash.spec.ts`, `open-file-expand-folder.spec.ts`. Each pins one
fixed defect. A `test/browser/regression/` directory with that convention
costs nothing and makes the suite's purpose self-documenting.

**Transfer: a shared waits module.** `e2e/utils/waits.ts` is eleven lines and
centralizes the "app is ready" timeout:

```ts
export const APP_READY_TIMEOUT = 30_000
export async function expectAppVisible(locator: Locator) {
  await expect(locator).toBeVisible({ timeout: APP_READY_TIMEOUT })
}
```

Worth having, especially once cassettes make first paint slower.

**Transfer, later: a performance suite with its own config**, excluded from
normal discovery. `packages/app/e2e/performance/` has its own
`playwright.config.ts`, README, and AGENTS.md, and runs via `test:bench`, not
CI — because benchmarks in CI are noise. This only becomes meaningful once
there is a large cassette to render.

**Resist: their locator strategy.** They lean on internal attributes:

```ts
const tabB = page.locator(`[data-titlebar-tab-slot]:has(a[href="${hrefB}"])`)
await expect(tabB.locator('[data-component="session-progress-indicator-v2"]')).toBeVisible()
```

That pins component internals and a version number into a test. Your existing
specs use role-based queries:

```ts
const costs = page.getByRole('region', { name: 'Estimated Claude API cost' })
await expect(page.getByRole('heading', { name: 'No local sessions found' })).toBeVisible()
```

That is better practice — it survives refactors and doubles as an
accessibility assertion. Do not trade it away.

**Also resist: mocking the server everywhere.** Every one of their browser
specs calls `mockOpenCodeServer(page, …)`. Your `playwright.config.ts` boots
`pnpm preview` against a real transcript directory, which they have nothing
equivalent to. Keep `mockDashboardApi` for states a real server cannot
produce on demand — loading, 500, empty, stale-response races — and keep the
real server for everything else.

---

## 12. Organizing a large test file

`session-runner.test.ts` is 3,365 lines. Their structure, which holds up:

1. **Module top:** stub layers, model fixtures, the composed `runnerLayer`,
   and `const it = testEffect(...)`.
2. **Then helpers** that build or assert on domain values — `insertSession`,
   `messageTexts`, `replaySessionProjection`, `fragmentFixture`.
3. **Then `verify*` functions** that encapsulate a multi-step assertion reused
   across cases — `verifyEphemeralDeltas`, `verifyPartialFlushOnFailure`,
   `verifyPartialFlushOnInterruption`.
4. **Then one `describe`** at line 557 containing the tests, each of which
   reads as a short sentence because everything mechanical is above it.

The `verify*` layer is the part most test files skip and shouldn't. When three
tests differ only in one enum value, the difference should be a parameter to a
named verification, not three near-identical bodies.

Their AGENTS.md rule applies here too, and matches this repo's instincts:

> Do not extract single-use helpers preemptively. Inline the logic at the call
> site unless the helper is reused, hides a genuinely complex boundary, or has
> a clear independent name that improves the caller.

---

## 13. Cheat sheet

Reach for these in this order:

```ts
// 1. Stateless layer shared across a block
it.layer(baseLayer)('with defaults', (it) => { … })

// 2. Stateful layer — per test, no exceptions
it.effect('…', () => Effect.gen(function*() { … }).pipe(Effect.provide(freshLayer())))

// 3. Stub a service; unimplemented members must die loudly
const store = Layer.mock(ChatStore, { send: () => Effect.succeed(reply) })

// 4. Observe calls without module state
const { layer, log } = yield* permissionLayer('allow')
assert.deepStrictEqual(yield* log.all, expected)

// 5. Same behavior across the four sources
it.effect.each(SOURCES)('$source …', ({ source, scan }) => …)

// 6. Invariants, not examples
it.effect.prop('…', { record: ClaudeRecordSchema }, ({ record }) => …)

// 7. Anything time-derived
yield* TestClock.setTime(anchor)

// 8. Golden comparison
assert.strictEqual(stable(projection), stable(expected))
```

And the things to keep doing that opencode does not:

- In-memory filesystem in unit tests (`testFileSystem()`), never `mkdtemp`.
- `TestClock` wherever "now" is involved.
- No module-level mutable state, no `beforeEach` reset lists.
- Role-based Playwright locators.
- A real server in the browser tier.
- Zero `as any`.
