# How opencode Tests, and Where That Sits on the Pyramid

## Reference note

**Subject:** `anomalyco/opencode` @ `dev`, read 2026-08-04
**Audience:** anyone deciding how liveclaudecode should be tested
**Companion:** `docs/transcript-cassettes-spec.md`, which proposes adopting one
specific piece of this strategy

This is a description of what another project does and an argument about how
to read it, not a proposal. Every claim is backed by something countable in
their repository.

## 1. The shape at a glance

| Measure | Value |
| --- | --- |
| Test files | 658 |
| Test LOC | ~162,000 |
| Source LOC (excluding tests, generated, docs) | ~444,000 |
| Test-to-source ratio | ~0.37 |
| Test runner | `bun test`, per package via Turbo |
| Effect version | `4.0.0-beta.83`, with a patch applied to `effect` itself |
| Files using `it.effect` / `testEffect` | 246 |
| Files using `TestClock` | 4 |
| Property-based tests | 1 |
| Snapshot files | 3 |
| `mock()` / `spyOn` call sites | 185 |
| CI platforms | Linux **and** Windows, for both unit and e2e |

Distribution by package:

| Package | Test files | Effect-bearing |
| --- | ---: | ---: |
| `opencode` (server, CLI, tools) | 250 | 146 |
| `core` (sessions, providers, filesystem) | 142 | 121 |
| `app` (SolidJS UI) | 128 | 0 |
| `tui` | 46 | 1 |
| `llm` | 30 | 22 |
| everything else | 62 | — |

Two numbers in that table do most of the explaining. **121 of 142** core tests
touch Effect services, and **0 of 128** app tests do. Their codebase has a hard
seam, and the testing strategy on each side of it is almost unrelated.

## 2. The six layers

### 2.1 Pure unit tests

Plain functions, no services, no I/O. `packages/tui/test/theme.test.ts`,
`packages/core/test/patch.test.ts`, most of `packages/app/src/utils`. Ordinary
`bun test` with `expect`. Nothing distinctive here.

### 2.2 Service integration under Effect layers

This is the bulk of their suite and the layer they have invested the most in.

They are on Bun, so `@effect/vitest` is unavailable, and they reimplemented it
in 50 lines — `packages/core/test/lib/effect.ts`:

```ts
const testEnv = Layer.mergeAll(TestConsole.layer, TestClock.layer())
const liveEnv = TestConsole.layer

export const it = make(testEnv, liveEnv)
export const testEffect = <R, E>(layer: Layer.Layer<R, E>) =>
  make(Layer.provideMerge(layer, testEnv), Layer.provideMerge(layer, liveEnv))
```

`it.effect` runs under `TestClock` + `TestConsole`; `it.live` under a real
clock. Failures pass through `Cause.prettyErrors` before rethrowing, so an
Effect failure prints readably instead of as an opaque `FiberFailure`.
`testEffect(layer)` returns an `it` pre-bound to a suite's layer, which is the
part worth stealing conceptually — it removes `Effect.provide` from every
single test body.

Dependencies are assembled through a typed DI graph
(`packages/core/src/effect/layer-node.ts`, 333 LOC) with a builder that lets a
test replace any node:

```ts
const imageLayer = AppNodeBuilder.build(Image.node, [[Config.node, config]])
```

Stub services are built with `Layer.succeed(Service, Service.of({...}))`, and
methods the test does not expect to be called are `Effect.die("unused")` —
an unexpected call becomes a loud defect rather than a silent `undefined`.
That idiom is cheap and worth copying outright.

**But these are not unit tests.** Their preload sets
`OPENCODE_DB=":memory:"` — a real SQLite database, not a fake. 38 of 142 core
tests create a real temp directory through `test/fixture/tmpdir.ts`. Others
shell out, drive a real pty, or run real `git`. By any standard definition this
tier is *integration testing*, and it is where their coverage actually lives.

The cost of that choice is visible in the fixture itself:

```ts
async function remove(dir: string, retries = 30): Promise<void> {
  try { await fs.rm(dir, { recursive: true, force: true }) }
  catch (error) {
    if (retries === 0 || error.code !== "EBUSY") throw error
    Bun.gc(true)
    await Bun.sleep(100)
    return remove(dir, retries - 1)
  }
}
```

Thirty retries with a forced GC and a sleep, to delete a directory on Windows.
That is the tax for testing against a real disk instead of an in-memory
filesystem.

### 2.3 Recorded provider integration — the cassettes

Their answer to "how do you test ten LLM providers without hitting them."

`@opencode-ai/http-recorder` is a 1,540-LOC package with its own README,
published to npm in beta. It records real Effect HTTP and WebSocket traffic
into JSON cassettes, then replays deterministically, with header/query/JSON
field redaction and configurable request matching. 46 cassettes are checked in.

On top sits a **golden scenario matrix** (`packages/llm/test/recorded-golden.ts`):
a declarative table of provider × protocol × transport × scenario that
generates `describe` blocks. Anthropic Messages, OpenAI Chat, OpenAI
Responses, Gemini, Bedrock Converse, Cloudflare AI Gateway, Workers AI — each
against recorded real responses, including cache-token accounting
(`reports-cached-tokens-on-identical-second-call.json`) and deliberately
malformed input (`accepts-malformed-assistant-tool-order-with-default-patch.json`).

This is the single most transferable idea in the repository, and it is what
`docs/transcript-cassettes-spec.md` adapts.

### 2.4 API contract exercising

`packages/opencode/test/server/httpapi-exercise/` — 2,868 LOC implementing a
scenario DSL:

```ts
scenario.get("/session/:id").inProject({ git: true }).withLlm().mutating().probe(authRequest)
```

Run three ways in CI:

```
test:httpapi = httpapi-exercise --mode coverage --fail-on-missing --fail-on-skip
            && httpapi-exercise --mode auth     --fail-on-missing --fail-on-skip
            && httpapi-exercise --mode effect   --fail-on-missing --fail-on-skip
```

`--fail-on-missing` is the important flag: it enumerates the routes registered
on the `HttpApi` and fails when one has no scenario. **Adding an endpoint
without a test is a build failure.** `--fail-on-skip` closes the obvious
loophole of marking scenarios TODO.

This runs headlessly against a real server. No browser is involved.

### 2.5 Component tests

`packages/app` — 128 files, zero Effect, happy-dom preloaded:

```
test:unit    = bun test --conditions=solid --preload ./happydom.ts ./src
test:browser = bun test --conditions=browser --preload ./happydom.ts ./test-browser
```

Tests live beside the source (`src/context`, `src/components`,
`src/pages/session/timeline`) rather than in a parallel tree. Ordinary
component and store testing; nothing Effect-shaped crosses into the UI.

### 2.6 Playwright

62 specs in `packages/app/e2e`, and the breakdown is more interesting than the
count:

| Suite | Specs | What it is |
| --- | ---: | --- |
| `regression/` | 40 | One spec per fixed bug — `remote-tab-busy`, `review-image-flash`, `open-file-expand-folder` |
| `performance/` | 20 | Benchmarks, **excluded from normal CI discovery**, run manually via `test:bench` |
| `smoke/` | 1 | Does the app come up |
| `user-story/` | 1 | One multi-step flow |
| `reproduction/` | 0 | Scratch space for in-progress repros |

**The server is mocked.** Every browser spec calls `mockOpenCodeServer(page, …)`
from `e2e/utils/mock-server.ts`, which intercepts routes and serves configured
responses:

```ts
await mockOpenCodeServer(page, { directory, project, provider: () => ({ … }), sessions: [ … ] })
```

So their "e2e" tier is browser-against-fake-backend. Combined with §2.4 —
real-backend-without-browser — the consequence is worth stating plainly:

> **opencode has no test that runs a real browser against a real server.**
> The top of their pyramid is split into two halves that never meet.

The performance suite has its own Playwright config, its own README, and its
own AGENTS.md, and measures cold/hot session-tab timing, RAF gaps, long tasks,
geometry stability, and remount counts, emitting Chrome traces. It is
deliberately kept out of CI because benchmarks in CI are noise.

They also treat test *speed* as a tracked engineering metric —
`packages/opencode/perf/test-suite.md` declares a primary metric
(`METRIC test_suite_seconds=<median wall clock>`) with `bench:test` and
`profile:test` harnesses to move it.

## 3. The classic pyramid, briefly

Mike Cohn's model, and the reason it is drawn as a triangle:

```
        ╱╲          E2E          few, slow, brittle, high confidence
       ╱──╲
      ╱    ╲        Integration  some
     ╱──────╲
    ╱        ╲      Unit         many, fast, stable, low confidence per test
   ╱──────────╲
```

The argument is economic, not moral. Tests get slower and flakier as they
climb, so buy most of your coverage where it is cheap and reserve the
expensive tier for the handful of paths where integration risk actually lives.

Two well-known revisions matter here:

- **The Testing Trophy** (Kent C. Dodds) — widest in the *middle*, on the
  claim that integration tests give the best confidence-per-cost when your
  units are small and your wiring is where bugs live.
- **The Honeycomb** (Spotify) — for service-heavy systems, prefer
  "integrated tests" over both isolated unit tests and full end-to-end ones.

## 4. Where opencode actually sits

Counting test files by tier, with the classification ambiguity noted honestly:

```
browser e2e (mocked server)      42  ████
API contract exerciser            1  █          (one harness, N gated scenarios)
recorded provider integration   ~30  ███
component (happy-dom)           128  ████████████
service integration (Effect)   ~289  ███████████████████████████
pure unit                      ~170  ████████████████
```

That is not a pyramid. The widest tier is the middle, and the second widest is
component tests, which most taxonomies also call integration. Their shape is a
**trophy**, or a diamond:

```
    ▲▲          e2e — thin, and mocked
   ████         component
 ██████████     service integration  ← widest
    ████        pure unit
```

Four specific inversions of classic pyramid advice, each defensible for
different reasons:

**They put the mass in the middle, not the bottom.** Defensible. An agent
runtime is mostly orchestration — session state, tool dispatch, provider
routing, permission checks. There is little pure logic to unit-test in
isolation, and the bugs live in the wiring. Effect's `Layer` makes swapping one
dependency cheap enough that integration tests cost about what unit tests do,
which is precisely the condition under which the trophy beats the pyramid.

**Their fastest tier is not hermetic.** Real SQLite, real temp directories,
real git, real pty. Debatable. It buys realism and costs determinism —
the 30-retry `EBUSY` loop is the receipt. An in-memory filesystem would give
the same coverage of parsing logic with none of the flake, but would not cover
the real `git` invocation.

**They gate coverage mechanically instead of aspirationally.** Strongly
defensible, and under-imitated generally. `--fail-on-missing` converts "we
should test new endpoints" into "you cannot merge an untested endpoint." Most
projects have the former; almost none have the latter.

**The top tier tests the UI against a fake.** Defensible for speed, but it
leaves a real hole. Nothing verifies that the client and server agree in a
running browser. The contract between them is checked twice, on both sides,
against two independently maintained descriptions of it — which is exactly the
configuration in which a contract drifts.

## 5. Things they do that the pyramid does not describe

Three of their strongest practices are orthogonal to the pyramid entirely, and
this is the more useful lens for reading their repository:

**Recording versus authoring.** The cassette layer is not a *tier*, it is a
*fixture-provenance decision*: is this fixture a recording of reality, or a
description of our belief about reality? That question applies at every tier,
and it is independent of how many tests you have at each. A project can be
pyramid-shaped and still have every fixture be fiction.

**Coverage gating versus coverage measuring.** They have no coverage tooling
at all — no `--coverage`, no threshold, no badge. What they have instead is a
gate that enumerates a real surface (registered routes) and fails on a hole.
That is a stronger guarantee than a percentage over lines, and it is
tier-agnostic.

**Regression-driven top tier.** 40 of 62 Playwright specs are named after
bugs. Their e2e tier is not a plan for covering user journeys; it is an
accreted record of things that broke. That is a legitimate strategy — the
observed defect distribution is better evidence than a design document — but
it means their e2e coverage is shaped by history, not by risk analysis.

## 6. Where liveclaudecode sits

By file count across the five existing projects:

```
desktop (Playwright/Electron)     1  █
browser (Playwright, REAL server) 2  ██
e2e (built API, real FS)          1  █          (603 lines, one file)
nuxt (mounted components)        27  ███████████████████████████
unit (Effect + pure)             52  ████████████████████████████████████████████████████
```

By LOC: unit 9,081 · nuxt 4,273 · e2e 603 · browser 352 · desktop 183.

That **is** a pyramid, and a fairly textbook one. Test-to-source ratio is
~0.75 — roughly twice opencode's.

Head to head on the practices that are not about tier counts:

| | opencode | liveclaudecode |
| --- | --- | --- |
| Shape | Trophy / diamond | Pyramid |
| Test:src LOC | 0.37 | **0.75** |
| Fastest tier hermetic? | No (real SQLite, tmpdir, git) | **Yes** (`testFileSystem()`) |
| `TestClock` | 4 files | **32 uses** |
| Module-level mutable test state | Common | **Forbidden by CLAUDE.md, and absent** |
| `as any` in src | 592 | **0** |
| Fixture provenance | **Recorded** (46 cassettes) | Authored |
| Coverage gating | **Mechanical** (`--fail-on-missing`) | None |
| Browser + real server together | **No** | **Yes** (`pnpm preview` + real fixture dir) |
| CI platforms | **Linux + Windows** | Linux only |
| Test-speed tracking | **Yes** | No |

The two rows that matter most are the last-but-three and the last-but-two,
and they cut in opposite directions.

**They have breadth of data without depth of stack.** 46 cassettes of real
provider traffic, but the browser never talks to a real server.

**We have depth of stack without breadth of data.** `playwright.config.ts`
boots `pnpm preview` against a real transcript directory — a genuine
disk → scanner → h3 → SSR → hydration test, which they do not have anywhere.
The directory contains **12 hand-written records**, and the Codex and VS Code
roots point at `missing-*` paths that do not exist.

So the full-stack machinery is already built and is running against almost
nothing. That is the specific reason the cassette proposal lands where it
does: it does not ask for a new tier, it fills the tier that already exists.

## 7. What to copy, what to leave

**Copy — high value, low cost:**

1. `Effect.die("unused")` on stub-layer methods that should never be called.
2. Mechanical coverage gating: enumerate `server/api/**`, fail when a route
   has no e2e assertion. This is `--fail-on-missing` at 1% of the code.
3. Recorded fixtures for the four transcript formats — see the companion spec.
4. Windows (and macOS) CI legs. We ship a desktop app for both and test on
   neither, while the entire product is path-based discovery under `~/.claude`,
   `~/.codex`, and VS Code's user-data directories.

**Copy — worth it once there is enough content to measure:**

5. A separate, CI-excluded performance suite with its own Playwright config,
   the way `packages/app/e2e/performance` is structured. Only becomes
   meaningful with a large cassette to render.
6. Naming e2e specs after the bugs they pin.

**Do not copy:**

7. The HTTP recorder itself. We have no runtime network I/O; the transport
   here is the filesystem.
8. Real temp directories in the fastest tier. `testFileSystem()` is better:
   hermetic, controls `mtime`, injects `PermissionDenied`, and needs no
   `EBUSY` retry loop.
9. Module-level mutable state in test files reset via `beforeEach`. Their
   `packages/core/test/tool-read.test.ts` carries `let allow = true` and four
   mutable arrays. It works, and it is order-sensitive. CLAUDE.md already
   forbids it here.
10. Mocking the server in the browser tier. We have the real thing running
    already; keeping it is a strict advantage.

**Note the contradiction before importing their rules wholesale.** Their
AGENTS.md says "avoid mocks as much as possible." There are 185 `mock()` and
`spyOn` call sites in their test files. A documented convention and 658 test
files written under deadline are different artifacts, and it is the second one
that describes the strategy.
