# Effect v4 Atom Reactivity in the Dashboard

## Engineering specification

**Status:** Proposal, not started
**Product:** liveclaudecode
**Audience:** Frontend / test engineering
**Scope:** Replace the hand-rolled polling, staleness-guard, and request-cancellation
machinery in `app/composables/**` and `app/utils/**` with Effect v4 Atom
reactivity (`effect/unstable/reactivity` + `@effect/atom-vue`); introduce a
client-side `Api` service and response schemas; rewrite the `app/**`
architecture rule in `AGENTS.md`
**Prior art:** `server/utils/**` (the house Effect style this adopts), and the
vendored Effect source at `repos/effect/`

---

## 1. Summary

The decision to adopt Effect v4 Atom reactivity in the frontend is made. This
document specifies how.

`app/composables/useLiveRuns.ts` is 453 lines that own four poll intervals, two
latest-request gates, a generation counter, a pool of `AbortController`s, a
`disposed` flag, a first-load range handshake, and a 39-member return object.
Every one of those mechanisms is a hand-written version of something the atom
registry does structurally: an atom node's finalizer interrupts its in-flight
fiber, and an interrupted `HttpClient` request aborts the underlying `fetch`. A
different query is a different atom, not a race the client has to referee.

The migration lands in nine stages. Each stage ships independently with
`pnpm check` green and the dashboard working. Stage 1 converts no production
behavior at all; it exists to run seven experiments, five of which can change
the design of every stage after it.

Three things about this work deserve to be said plainly before anything else.

**The API is unstable and the Vue binding is untested.** `effect/unstable/reactivity`
is on the unstable path of a beta release. `@effect/atom-vue`'s entire test suite
is a 94-byte placeholder (`repos/effect/packages/atom/vue/test/index.test.ts`).
Nothing in `repos/effect/LLMS.md` or `ai-docs/` mentions Atom. The v3 standalone
package called the async type `Result`; in v4 core it is `AsyncResult`. Every
blog post and every online example is conceptually useful and API-wrong. The
vendored source under `repos/effect/packages/` is the only reference, and this
repository owns test coverage for the binding layer because upstream does not.

**Three of the most natural-looking designs in this space are wrong.** A
`Stream`-based poll loop dies permanently on its first failed request
(§3.6). `AtomRegistry.make({ initialValues })` does not prevent a seeded atom
from running its effect (§3.3). A superseded poll does not produce an
interrupt `Failure`, and `AsyncResult.matchWithWaiting` routes interrupts to
`onDefect`, not `onError` (§3.7). Each is verified below against a file and a
line. Each would have been discovered in production.

**Deriving `shared/types/run.ts` from `Schema` breaks the server.** Schema
structs produce `ReadonlyArray`, and `server/utils/runs.ts` builds the run tree
by calling `.push` and `.sort` on `RunNode.children`. §3.1 specifies a wire-type
boundary instead. This is the single largest correction to the obvious plan and
it is why Stage 2, not Stage 7, is the point of no return.

---

## 2. What this changes

| Concern | Today | After |
| --- | --- | --- |
| Polling | four `useIntervalFn` calls in `useLiveRuns` | a total feed loop inside `runtime.atom` (§3.6) |
| Stale responses | `createLatestRequestGate` + `isCurrent()` predicates | a different family key is a different atom |
| Cancellation | `AbortController` pools, `disposed` flags | node finalizer interrupts the fiber, which aborts `fetch` |
| Loading / offline | two hand-maintained booleans, five write sites | derived from `AsyncResult` and the feed's `error` field |
| Response validation | `return result as T` | `Schema` decode into a wire type |
| Errors | one `offline` boolean, or a message string in chat | four `Schema.TaggedErrorClass` values |
| Per-session caches | a hand-rolled LRU and an MRU `Map` | `Atom.family` + `Atom.setIdleTTL` |
| Rendering | unchanged | unchanged |

What does **not** change: `app/utils/**` stays pure TypeScript and keeps its
plain unit tests; `server/**`, `shared/schemas/**` (the inbound transcript
parsers), and the entire cassette system are untouched; `electron/**` stays
plain JavaScript.

---

## 3. Architecture

### 3.1 Wire types and response schemas

`app/**` currently validates nothing. `useLiveRuns.ts:207-208` does
`await $fetch(url)` then `return result as T`. Once `app/**` is Effect code,
`AGENTS.md`'s "parse external data with Effect `Schema`" rule applies, and this
is the largest single work item in the migration.

The obvious move — define the schemas and re-export `typeof Schema.Type` from
`shared/types/run.ts`, the way `shared/types/chat.ts:12-14` already does for
`ChatAction` — does not work here. `Schema.Struct` keys are readonly and
`Schema.Array` produces `ReadonlyArray` (`repos/effect/packages/effect/SCHEMA.md:328`,
`:1708`), and the server builds the run tree by mutating exactly those fields:

```
server/utils/runs.ts:243            parent.children.push(node)
server/utils/runs.ts:244            byKey.get(node.sid)!.children.push(node)
server/utils/runs.ts:249            roots.sort(bySubLastDesc)
server/utils/runs.ts:317            node.children.sort(...)
server/utils/session-catalog.ts:213 existing.roots.push(...roots)
server/utils/session-catalog.ts:417 project.roots.sort(bySubLastDesc)
server/utils/codex-runs.ts:155,159  and the same in copilot-runs.ts:308,315
```

`ReadonlyArray` has neither `push` nor `sort`. Re-exporting the derived types
would produce a wall of type errors across five server files.

**The boundary.** `shared/types/run.ts` keeps its hand-written, mutable
interfaces and stays the server's *construction* type.
`shared/schemas/api.ts` owns the decoders and exports their readonly `.Type`
under a `*Wire` name. `app/**` migrates its `import type` lines to the `*Wire`
types endpoint by endpoint.

This is stageable precisely because mutable is assignable to readonly: a
component can be switched to `TreeResponseWire` before or after its data source
moves to an atom, in either order, and both compile. Drift between the two is a
one-line compile-time guard per response.

```ts
// shared/schemas/api.ts
import { Schema, Struct } from 'effect'
import type { TreeResponse } from '#shared/types/run'

const SessionSource = Schema.Literals(['claude', 'codex', 'copilot'])

/**
 * Fields `RunNode` inherits from `TranscriptStats` (shared/types/run.ts:408-428),
 * kept as a record so the recursive and non-recursive node schemas can each
 * spread them. `Schema.Struct` does support omission via
 * `.mapFields(Struct.omit([...]))` (SCHEMA.md:1073) — but the recursive node
 * must be annotated `Schema.Codec<…>` for `Schema.suspend`, and `Codec` has no
 * `mapFields`. Records are the way out for `RunNode` specifically; everywhere
 * else prefer `mapFields`.
 */
const TranscriptStatsFields = {
  records: Schema.Number,
  tools: Schema.Number,
  toolCounts: Schema.Record(Schema.String, Schema.Number),
  // … one entry per field of shared/types/run.ts:408-428
} as const

const RunNodeOwnFields = {
  source: SessionSource,
  sourceDetail: Schema.String,
  key: Schema.String,
  kind: Schema.Literals(['session', 'subagent']),
  // … shared/types/run.ts:430-459, minus `children` and `subFiles`
} as const

/** `PublicRunNode` (shared/types/run.ts:461) — the node without its children. */
export const PublicRunNodeSchema = Schema.Struct({
  ...TranscriptStatsFields,
  ...RunNodeOwnFields,
})

export interface RunNodeWire extends Schema.Struct.Type<typeof PublicRunNodeSchema.fields> {
  readonly children: ReadonlyArray<RunNodeWire>
  readonly subFiles: Readonly<Record<string, number>>
}

export const RunNodeSchema = Schema.Struct({
  ...TranscriptStatsFields,
  ...RunNodeOwnFields,
  children: Schema.Array(Schema.suspend((): Schema.Codec<RunNodeWire> => RunNodeSchema)),
  subFiles: Schema.Record(Schema.String, Schema.Number),
})

export const TreeResponseSchema = Schema.Struct({
  projects: Schema.Array(Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    roots: Schema.Array(RunNodeSchema),
  })),
  sources: Schema.Array(SessionSourceStatusSchema),
  now: Schema.Number,
  hours: Schema.Number,
  costs: Schema.optional(CostSummarySchema),
})

export type TreeResponseWire = typeof TreeResponseSchema.Type

/**
 * Drift guard. The server constructs the mutable interface; the wire type must
 * accept it. Deliberately one-directional — a decoded value is readonly and is
 * NOT assignable back to the mutable interface, which is the whole point.
 */
const _treeWireAcceptsServerShape: TreeResponseWire = undefined as unknown as TreeResponse
void _treeWireAcceptsServerShape
```

Whether `TreeResponse.costs` is genuinely optional is unresolved.
`shared/types/run.ts:483` declares `costs?`, and `useLiveRuns.ts:247` does
`response.costs || null`. Read `listSessions` in `server/utils/session-catalog.ts`
before writing that field; an unnecessary `Schema.optional` propagates
`| undefined` through every consumer.

### 3.2 The Api service

Three options were considered and two rejected.

`AtomHttpApi` is rejected because it converts every `HttpClientError` and
`SchemaError` into a **defect**:

```ts
// repos/effect/packages/effect/src/unstable/reactivity/AtomHttpApi.ts:215-217
const catchErrors = Effect.catch((e) =>
  Schema.isSchemaError(e) || HttpClientError.isHttpClientError(e) ? Effect.die(e) : Effect.fail(e))
```

"The local dev server isn't running" is this dashboard's most common failure and
has to be a typed failure the UI renders as an offline banner, not an unhandled
defect.

Moving the server to `HttpApi` is rejected as a separate project: `HttpApiBuilder.layer`
yields an `HttpRouter` layer, so serving it under Nitro means a catch-all
`server/routes/api/[...].ts` using `HttpRouter.toWebHandler` and rewriting the
163 lines of h3 bridge in `server/utils/runtime.ts`, including its 499
client-disconnect handling.

`$fetch` is rejected because it forces manual `AbortController` threading —
reintroducing what this migration deletes. `HttpClient` aborts the underlying
`fetch` when its fiber is interrupted:

```ts
// repos/effect/packages/effect/src/unstable/http/HttpClient.ts:664-666
if (Cause.hasInterrupts(cause)) { controller.abort() }
```

and that controller's signal is handed to `fetch` at
`FetchHttpClient.ts:64-71`. `FetchHttpClient.layer` has zero requirements
(`FetchHttpClient.ts:123`), so no new dependency.

The service reads like `server/utils/chat-store.ts`:

```ts
// app/api/api.ts
import { Context, Effect, Layer, Option, Schema } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http'
import type { HttpClientError } from 'effect/unstable/http'
import { TreeResponseSchema, type TreeResponseWire } from '#shared/schemas/api'
import { ApiMalformed, ApiRejected, ApiUnreachable, type ApiError } from './errors'

/** What h3's `createError` serialises — the only structure a failure has. */
const ServerFailureSchema = Schema.Struct({
  statusCode: Schema.Number,
  statusMessage: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
})
const decodeServerFailure = Schema.decodeUnknownOption(ServerFailureSchema)

const failureDetail = (body: unknown): string =>
  Option.match(decodeServerFailure(body), {
    onSome: failure => failure.statusMessage || failure.message || '',
    onNone: () => '',
  })

/**
 * Splits a transport fault into the two the dashboard treats differently: a
 * body we could not read is version skew, everything else is unreachable.
 * Interruption never arrives here — `Effect.catch` sees only typed failures.
 */
const classify = (url: string) => (failure: HttpClientError.HttpClientError | Schema.SchemaError) =>
  Schema.isSchemaError(failure)
    ? Effect.fail(new ApiMalformed({ url, detail: failure.message }))
    : failure.reason._tag === 'DecodeError' || failure.reason._tag === 'EmptyBodyError'
      ? Effect.fail(new ApiMalformed({ url, detail: failure.message }))
      : Effect.fail(new ApiUnreachable({ url, detail: failure.message }))

export interface RangeQuery {
  /** Hours of history. Omitted lets the server apply its configured default. */
  readonly hours?: number | undefined
}

export class Api extends Context.Service<Api, {
  readonly tree: (query: RangeQuery) => Effect.Effect<TreeResponseWire, ApiError>
  // … one method per route in server/api/
}>()('lcc/Api') {
  static readonly layer: Layer.Layer<Api> = Layer.effect(Api, Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient

    /**
     * One GET route. The decoder is built once per route, not per call —
     * these poll every two to six seconds. The status is inspected before the
     * body is decoded so the server's `statusMessage` survives;
     * `HttpClient.filterStatusOk` would discard it.
     */
    const route = <S extends Schema.Codec<any, any>>(path: string, schema: S) => {
      const decode = Schema.decodeUnknownEffect(schema)
      return Effect.fn(`Api${path}`)(
        function*(urlParams: Record<string, string | number | undefined>) {
          const response = yield* client.execute(HttpClientRequest.get(path, { urlParams }))
          const body = yield* response.json
          if (response.status >= 400) {
            return yield* new ApiRejected({
              url: path,
              status: response.status,
              detail: failureDetail(body),
            })
          }
          return yield* decode(body)
        },
        Effect.catch(classify(path)),
      )
    }

    const tree = route('/api/tree', TreeResponseSchema)

    return Api.of({
      // `HttpClientRequest`'s urlParams skip undefined values, which reproduces
      // the '/api/tree' vs '/api/tree?hours=N' branch at useLiveRuns.ts:231-233
      // with no conditional.
      tree: query => tree({ hours: query.hours }),
    })
  })).pipe(Layer.provide(FetchHttpClient.layer))
}
```

Four typed errors, all `Schema.TaggedErrorClass`, in `app/api/errors.ts`:

| Error | Meaning | UI |
| --- | --- | --- |
| `ApiUnreachable` | the request never got an answer | offline banner over stale data; resolves itself |
| `ApiRejected` | non-2xx; carries `status` and h3's `statusMessage` | error state, message shown |
| `ApiMalformed` | a 2xx body this build cannot decode | version skew; retrying will not help, reload |
| `ApiRefused` | the client declined to send (payload failed the shared schema) | inline validation |

Interruption is deliberately **not** a fifth error. `Effect.catch` does not see
interrupts. See §3.7 for what interruption actually looks like, which is not
what the obvious reading suggests.

`GET /api/chat` takes no `hours` — `server/api/chat.get.ts` never calls
`browserOptionsFor`, unlike every other GET handler, while the client sends
`&hours=` anyway (`useChatTransport.ts:105`). Drop the dead parameter rather
than reproducing it. `POST /api/chat` does use it.

### 3.3 The runtime, the registry, and the test seam

`Atom.runtime(Api.layer)` binds atoms to the live layer permanently. That is
correct for the app and fatal for mounted component tests, because a component
imports the module-level atom and there is no way for a test to swap what it
runs against.

`AtomRegistry.make({ initialValues })` does **not** solve this. Seeding marks the
node stale with `preserveInitialValueOnBuild`, and `value()` calls
`this.atom.read(this.lifetime)` *before* checking that flag:

```ts
// repos/effect/packages/effect/src/unstable/reactivity/AtomRegistry.ts:619-634
value(): A {
  if ((this.state & NodeFlags.waitingForValue) !== 0) {
    this.lifetime = makeLifetime(this)
    const value = this.atom.read(this.lifetime)      // ← the effect has already started
    if ((this.state & NodeFlags.waitingForValue) !== 0) {
      if (this.preserveInitialValueOnBuild) { … }
```

A seeded atom displays the seeded value *and* issues the real request. Every
mounted spec from Stage 2 onward would make live network calls with a late state
flip.

**The seam is the layer atom.** `RuntimeFactory` accepts a function of
`AtomContext`, and the layer it returns is held in a per-registry node:

```ts
// repos/effect/packages/effect/src/unstable/reactivity/Atom.ts:702-710, 740-746
<R, E>(create: Layer.Layer<…> | ((get: AtomContext) => Layer.Layer<…>)): AtomRuntime<R, E>
…
const layerAtom = keepAlive(
  typeof create === "function"
    ? readable((get) => Layer.provideMerge(create(get), globalLayer))
    : readable(() => Layer.provideMerge(create, globalLayer)))
```

So:

```ts
// app/atoms/runtime.ts — the only module in app/** that calls Atom.runtime
import * as Atom from 'effect/unstable/reactivity/Atom'
import type * as Layer from 'effect/Layer'
import { Api } from '~/api/api'

/**
 * The layer the app runtime builds from. Writable so a test registry can
 * substitute a stub before anything mounts; the registry holds this node, so
 * one registry's substitution is invisible to another.
 *
 * `Layer.MemoMap` is keyed by layer reference identity
 * (repos/effect/packages/effect/src/Layer.ts:423), so each test must construct
 * its own stub layer value — two tests sharing one layer object share its build.
 */
export const apiLayerAtom = Atom.make<Layer.Layer<Api>>(Api.layer)

export const appRuntime = Atom.runtime((get) => get(apiLayerAtom))
```

This is unverified end-to-end and is Stage 1 experiment **E2**. If it fails, the
fallback is stubbing `FetchHttpClient.Fetch` in the Nuxt test setup — which is
the URL-string stubbing this migration is trying to delete, so the experiment
matters.

The registry itself is provided once per Nuxt app instance.
`@effect/atom-vue` exports no provider component; `injectRegistry()` falls back
to a module-level singleton (`repos/effect/packages/atom/vue/src/index.ts:59,
:65-67`), and its `defaultRegistry` is built with no options, so every atom is
torn down the instant its last subscriber unmounts. The React binding's default
registry passes `defaultIdleTTL: 400` (`repos/effect/packages/atom/react/src/RegistryContext.ts:44-47`);
match it.

```ts
// app/plugins/atom-registry.ts
import * as AtomRegistry from 'effect/unstable/reactivity/AtomRegistry'
import { registryKey } from '@effect/atom-vue'

export default defineNuxtPlugin({
  name: 'atom-registry',
  enforce: 'pre',
  setup(nuxtApp) {
    // 400ms grace before an unobserved atom is torn down. Node removal is
    // scheduled through a setImmediate/setTimeout(0) macrotask
    // (AtomRegistry.ts:458-465), so a synchronous remount keeps the node but an
    // async route transition does not — the TTL is what makes navigation free.
    nuxtApp.vueApp.provide(registryKey, AtomRegistry.make({ defaultIdleTTL: 400 }))
  },
})
```

`ssr: false` goes in `nuxt.config.ts` in the same stage. Two independent
process-global leak vectors make server-side atom evaluation unsafe:
`defaultRegistry` is a module singleton whose nodes survive a synchronous render
(reproduced with `vue/server-renderer` — two concurrent `renderToString` calls
with different inputs both rendered the first request's value), and
`Atom.defaultMemoMap` is a module-level `Layer.MemoMap` (`Atom.ts:788`) that
memoizes service builds process-wide regardless of which registry is used. SSR
costs this app nothing today: `useLiveRuns` defers every fetch to `onMounted`
(`useLiveRuns.ts:399-402`), so the server renders an empty shell. Electron loads
the same local HTTP URL (`electron/main.js:97`) and Nitro still serves the SPA
index under `preset: 'node-server'`.

### 3.4 Layout of `app/atoms/**`

One file per domain noun. Imports follow a one-way DAG; a back-edge is a review
blocker, not a nit. `useLiveRuns` reached 39 return members because every concern
could reach every other through shared closure variables, and a global registry
recreates that temptation without the closure.

```
app/api/errors.ts        four Schema.TaggedErrorClass values
app/api/api.ts           the Api Context.Service + its Layer

app/atoms/runtime.ts     apiLayerAtom, appRuntime          (imports nothing else)
app/atoms/range.ts       hoursAtom, serverDefaultHoursAtom
app/atoms/preferences.ts densityAtom, errorsOnlyAtom, followOutputAtom, followActiveAtom
app/atoms/tree.ts        treeAtom + projects/sources/costs/loading/offline
app/atoms/filters.ts     eight filter atoms + visibleProjects + projectOptions
app/atoms/selection.ts   explicit/bootstrap/liveFollow → selectionAtom, inspectedKeyAtom
app/atoms/run-detail.ts  runAtom
app/atoms/events.ts      transcriptAtom (family)
app/atoms/session-events.ts sessionEventsAtom (family, keyed on the session ROOT)
app/atoms/activity.ts    activityAgentAtom (family), activityEventsAtom
app/atoms/chat.ts        chat poll family, chat action fn, chat session state family
```

Allowed direction, top to bottom: `runtime → range → tree → {filters, selection}
→ {run-detail, events, session-events} → activity`. `filters` imports `tree`;
`tree` never imports `filters`.

`app/atoms/**` is **not** added to Nuxt's auto-import directories and gets no
`index.ts` barrel. `nuxt.config.ts` has no `imports` key, so `app/composables/**`
and `app/utils/**` are ambient today. Explicit `import { treeAtom } from '~/atoms/tree'`
keeps each component's real dependency set visible in review.

Each atom module exports a factory and a live instance:

```ts
// app/atoms/tree.ts
export const makeTreeAtoms = (rt: Atom.AtomRuntime<Api>) => ({ … })
export const treeAtoms = makeTreeAtoms(appRuntime)
```

Components import `treeAtoms`. Tests call `makeTreeAtoms` with an isolated
runtime. The live instance is module-scope, which is load-bearing: an atom
constructed inside `setup()` mints a new atom, node, and state per component
instance.

Parameterised atoms use `Atom.family`. Family keys memoise on Effect v4
structural `Equal`/`Hash`, not reference identity — a fresh object literal on
every render returns the same atom, verified empirically against the installed
`effect@4.0.0-beta.101`. This is the opposite of the v3/Jotai intuition. Two
hazards survive, so every family gets one exported key constructor and no call
site ever inlines a literal:

- an explicitly-present `undefined` property is a *different* key from an absent
  one (`{a:1}` vs `{a:1,b:undefined}` → not equal), so optional spreads silently
  split cache entries;
- `Hash` caches per object in a `WeakMap` (`Hash.ts:129-155`), so a key object
  mutated after first use returns the stale atom while a fresh literal with the
  new contents does not match it. Never pass a Vue `reactive()` proxy.

`Atom.family` returns a plain function, not an atom:

```ts
// repos/effect/packages/effect/src/unstable/reactivity/Atom.ts:1345-1379
export const family = … <Arg, T extends object>(f: (arg: Arg) => T): (arg: Arg) => T => {
  …
  return function(arg) { … return newAtom }
}
```

so `Atom.family(…).pipe(Atom.setIdleTTL(…))` does not compile. Policy
combinators go *inside* the factory:

```ts
export const chatSessionAtom = Atom.family((target: ChatTarget) =>
  Atom.make(initialChatSessionState()).pipe(Atom.setIdleTTL('10 minutes')))
```

Family identity is also not stable across garbage collection for auto-dispose
atoms (`repos/effect/packages/effect/test/reactivity/Atom.test.ts:816-838` asserts
the hash differs after `global.gc()` and that a value written before GC is lost).
**`Atom.family` is a memo, not a store.** Anything holding user-entered or
accumulated state needs `keepAlive`, an explicit `setIdleTTL`, or the registry's
`defaultIdleTTL`.

### 3.5 Reading atoms in a component

All four `@effect/atom-vue` composables take a **thunk**, and the thunk is
reactive — depend on props or refs inside it and the subscription swaps
automatically when the atom identity changes.

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { useAtomValue } from '@effect/atom-vue'
import { toFeedView } from '~/utils/feed-view'
import { treeAtoms } from '~/atoms/tree'

const result = useAtomValue(() => treeAtoms.tree)   // THUNK, not the atom
const view = computed(() => toFeedView(result.value))
</script>

<template>
  <RunTree v-if="view.tag === 'ready'" :projects="view.value" />
  <RunTree v-else-if="view.tag === 'stale'" :projects="view.value" offline />
  <RunTreeSkeleton v-else-if="view.tag === 'loading'" />
  <ErrorBanner v-else :message="view.message" />
</template>
```

Templates branch on a plain string discriminant, never on `AsyncResult.isSuccess`.
`vue-tsc`'s narrowing of imported refinement functions across template expressions
is unverified here, and a silent regression would fail only `pnpm test:types`.

The Vue binding ships four composables where React ships eleven. Three are
missing and get written locally, in `app/composables/atom.ts`, so they get the
tests upstream does not have:

```ts
// app/composables/atom.ts
import type * as Atom from 'effect/unstable/reactivity/Atom'
import { injectRegistry, useAtom } from '@effect/atom-vue'
import { computed, watchEffect, type WritableComputedRef } from 'vue'

/** Mirrors react Hooks.ts:250. Keeps the atom mounted, returns a refresher. */
export const useAtomRefresh = <A>(atom: () => Atom.Atom<A>): (() => void) => {
  const registry = injectRegistry()
  const atomRef = computed(atom)
  watchEffect((onCleanup) => { onCleanup(registry.mount(atomRef.value)) })
  return () => registry.refresh(atomRef.value)
}

/** Mirrors react Hooks.ts:185. Keeps an atom warm without reading its value. */
export const useAtomMount = <A>(atom: () => Atom.Atom<A>): void => {
  const registry = injectRegistry()
  const atomRef = computed(atom)
  watchEffect((onCleanup) => { onCleanup(registry.mount(atomRef.value)) })
}

/**
 * `v-model` adapter. The binding returns a readonly `Ref` plus a separate
 * setter (atom-vue index.ts:85-102) and ships no writable-ref helper, so every
 * two-way binding needs this shim.
 */
export const useAtomModel = <A>(atom: () => Atom.Writable<A, A>): WritableComputedRef<A> => {
  const [value, set] = useAtom(atom)
  return computed({ get: () => value.value, set })
}
```

Twelve members of `UseLiveRunsReturn` are declared writable (`useLiveRuns.ts:90-114`)
— the eight filters plus `followActive`, `followOutput`, `errorsOnly`, `density`,
and `hours` — and index.vue binds them with `v-model="live.query.value"`. All of
them need `useAtomModel`, not just the nine on `RunSidebar`.

Every `useAtom*` call must happen during `setup()`. `injectRegistry` falls back
to the module singleton rather than throwing, so a call from `onMounted`, a
watcher, a plugin body, or a bare util silently binds to shared global state with
no warning. This is the most likely silent-flake source in the migration.

### 3.6 Polling: the total feed loop

**A `Stream`-backed atom dies permanently on its first failed request.** This is
the correction that shapes every poll atom in the migration.

```ts
// repos/effect/packages/effect/src/unstable/reactivity/Atom.ts:850-873
Effect.catchCause((cause) => {
  if (Pull.isDoneCause(cause)) { … } else {
    ctx.setSelf(AsyncResult.failureWithPrevious(cause as Cause.Cause<E>, { previous: … }))
  }
  return Effect.void        // ← the whileLoop is gone; nothing re-arms it
})
```

A typed failure from the mapping effect fails the stream. The atom latches into
`Failure` and never polls again. The component is still mounted, so nothing
re-subscribes; nothing calls `registry.refresh`. Today the opposite is true:
`request()` swallows the error and returns `null` (`useLiveRuns.ts:211-213`) and
`useIntervalFn` keeps firing (`:387`), so the dashboard self-heals the moment the
server comes back. A `pnpm dev` restart or a laptop sleep would leave a frozen
transcript behind an offline banner that never clears.

`Atom.withRefresh` would re-run after a failure, but it is banned for a different
reason: it schedules a raw `setTimeout` (`Atom.ts:1779`), as do `Atom.debounce`
(`:1753`) and `Atom.swr`'s `Date.now()` staleness check (`:1879`). None goes
through Effect's `Clock`, so `TestClock` cannot reach them, and `AGENTS.md`
mandates `TestClock`. By contrast `makeEffect` and `makeStream` fork with the
layer's services map (`Atom.ts:548-551`, `:876-881`) and `Clock` is a
`Context.Reference` a layer can override, so an Effect-internal sleep *is*
controllable.

The resolution is a poll loop whose per-tick effect **cannot fail**. Failure is
folded into the emitted value, so the stream never ends and the last good value
is never lost.

```ts
// app/atoms/feed.ts
import { Effect, Stream } from 'effect'
import type { ApiError } from '~/api/errors'

/**
 * One polled resource. `value` is the last thing the server returned and is
 * never cleared by a failure; `error` is the outcome of the most recent attempt.
 * Together they are the typed form of today's "keep showing stale data behind an
 * offline banner", which `useLiveRuns` achieves by returning early on `null`.
 */
export interface Feed<A> {
  readonly value: A | null
  readonly error: ApiError | null
}

/**
 * Polls `fetch` on `interval`, threading `S` across ticks.
 *
 * `Stream.tick` emits immediately on the first pull and delays only subsequent
 * ones (Stream.ts:570-582), which is the load-then-interval behaviour the
 * current pollers have. The `Effect.catch` is load-bearing: a stream that fails
 * is a stream that has ENDED (Atom.ts:850-873), and a poll loop that ends on
 * the first hiccup never recovers. Defects still terminate the stream, which is
 * correct — a defect is a bug, not a network blip.
 */
export const pollingFeed = <S, A>(options: {
  readonly interval: Duration.Input
  readonly initial: () => S
  readonly fetch: (state: S) => Effect.Effect<readonly [S, A], ApiError>
}): Stream.Stream<Feed<A>, never, Api> =>
  Stream.tick(options.interval).pipe(
    Stream.mapAccumEffect(
      () => ({ state: options.initial(), last: null as A | null }),
      (acc) =>
        options.fetch(acc.state).pipe(
          Effect.map(([state, value]) =>
            [{ state, last: value }, [{ value, error: null }]] as const),
          Effect.catch((error) =>
            // Keep the cursor and the last value; report the failure alongside.
            Effect.succeed([acc, [{ value: acc.last, error }]] as const)),
        ),
    ),
  )
```

The atom is then ordinary:

```ts
// app/atoms/tree.ts
export const makeTreeAtoms = (rt: Atom.AtomRuntime<Api>) => {
  const tree = rt.atom((get) =>
    pollingFeed({
      interval: '4 seconds',
      initial: () => null,
      fetch: () => Effect.gen(function*() {
        const api = yield* Api
        const response = yield* api.tree({ hours: get(hoursAtom) })
        return [null, response] as const
      }),
    }))

  return {
    tree,
    projects: Atom.map(tree, feedValue(r => r.projects, [])),
    sources: Atom.map(tree, feedValue(r => r.sources, [])),
    costs: Atom.map(tree, feedValue(r => r.costs ?? null, null)),
  }
}
```

Note the atom's error type still carries `Cause.NoSuchElementError` — `makeStream`
adds it for the empty-stream case (`Atom.ts:852-866`). `Stream.tick` never ends,
so it is unreachable, but it is in the type and the view model has to accept it.

Two further consequences of the stream shape:

- **Do not drive a spinner off `result.waiting` for a stream atom.** Every emitted
  chunk sets `Success(value, { waiting: true })` (`Atom.ts:846-848`) and it clears
  only when the stream ends, so a live-tailing view would show a permanent
  spinner. Branch on `Initial` versus `Success`.
- `projects`, `sources`, and `costs` are three fields of **one** response
  (`useLiveRuns.ts:245-247`). Three separately-polled atoms would triple the
  request count.

### 3.7 What interruption actually looks like

The staged design claimed a superseded poll surfaces as an interrupt-only
`Failure` that the view model classifies as loading, and called that "the
atom-native replacement for `isCurrent()`". Both halves are wrong.

**A superseded poll produces no `Failure` at all.** The node's cancel function
removes the exit observer *before* interrupting the fiber:

```ts
// repos/effect/packages/effect/src/unstable/reactivity/Atom.ts:594-599
const remove = fiber.addObserver(onExit)
function cancel() {
  remove()
  if (!uninterruptible) { fiber.interruptUnsafe() }
}
```

so the interrupt exit is never written into the node. The real replacement for
`isCurrent()` is simpler and stronger: a superseded key is a *different atom*,
whose node nothing subscribes to. Only an explicit `Atom.Interrupt` write
produces an interrupt `Failure`.

**When one does occur, `matchWithWaiting` routes it to `onDefect`.** The `Failure`
branch calls `Cause.findError`, and an interrupt-only cause yields no error:

```ts
// repos/effect/packages/effect/src/unstable/reactivity/AsyncResult.ts:650-657
case "Failure": {
  const e = Cause.findError(self.cause)
  if (Result.isFailure(e)) { return options.onDefect(Cause.squash(e.failure), self) }
  return options.onError(e.success, self)
}
```

So the view model checks `AsyncResult.isInterrupted` (`AsyncResult.ts:288-289`)
*before* matching:

```ts
// app/utils/feed-view.ts — plain TypeScript, unit-tested without mounting
import * as AsyncResult from 'effect/unstable/reactivity/AsyncResult'
import type { Feed } from '~/atoms/feed'

export type FeedView<A> =
  | { readonly tag: 'loading' }
  | { readonly tag: 'ready', readonly value: A }
  /** Data on screen, most recent refresh failed. The offline banner state. */
  | { readonly tag: 'stale', readonly value: A, readonly message: string }
  | { readonly tag: 'error', readonly message: string }

export const toFeedView = <A, E>(
  result: AsyncResult.AsyncResult<Feed<A>, E>,
): FeedView<A> => {
  // An explicit cancellation is not a fault. Checked first because
  // `matchWithWaiting` would route an interrupt-only cause to `onDefect`.
  if (AsyncResult.isInterrupted(result)) return { tag: 'loading' }
  return AsyncResult.matchWithWaiting(result, {
    onWaiting: () => ({ tag: 'loading' as const }),
    onSuccess: (success) => {
      const feed = success.value
      if (feed.value === null) {
        return feed.error
          ? { tag: 'error' as const, message: feed.error.message }
          : { tag: 'loading' as const }
      }
      return feed.error
        ? { tag: 'stale' as const, value: feed.value, message: feed.error.message }
        : { tag: 'ready' as const, value: feed.value }
    },
    onError: (error) => ({ tag: 'error' as const, message: String(error) }),
    onDefect: (defect) => ({ tag: 'error' as const, message: String(defect) }),
  })
}
```

Never render off `AsyncResult.value` alone: it returns the retained
`previousSuccess` on a `Failure` (`AsyncResult.ts:416-423`), so a naive render
silently shows stale data with no error indication.

### 3.8 Mutations

```ts
// app/atoms/chat.ts
export const chatActionAtom = appRuntime.fn(
  Effect.fn('chatAction')(function*(input: ChatActionInput) {
    const api = yield* Api
    return yield* api.chatAction(input.action, { hours: input.hours })
  }),
  { reactivityKeys: { chat: [] } },
)
```

`reactivityKeys` invalidates on success only — a failing effect does not
invalidate (`Reactivity.ts:226-227`). Atoms subscribe to those keys with
`runtime.withReactivity`.

Without `concurrent: true`, each write cancels the previous run, which is right
for anything user-driven. `Atom.Reset` clears submit state; `Atom.Interrupt`
cancels an in-flight send. Both are plain symbols written through the same setter.

**But `Reset` cannot go through a promise-mode setter.** The promise branch
writes and then awaits `AtomRegistry.getResult(…, { suspendOnWaiting: true })`,
which resumes only once the result leaves `Initial` (`AtomRegistry.ts:268-273`) —
and `Reset` sets the fn atom's counter back to 0, whose read *is* `Initial`
(`Atom.ts:1183-1190`, `:1211-1218`). The promise never settles. Take two setters
from the same atom:

```ts
const submit = useAtomSet(() => chatActionAtom, { mode: 'promiseExit' })  // send, cancel
const control = useAtomSet(() => chatActionAtom)                          // Reset, Interrupt
```

`useAtomSet`'s value-mode writer also treats any function value as an updater
(`atom-vue index.ts:153-155`), so a function cannot be stored as atom state.
`Atom.Reset` and `Atom.Interrupt` are symbols and pass through untouched.

### 3.9 `<KeepAlive>`

Vue 3.5's `sharedContext.deactivate` moves the subtree to a storage container
and invokes the `da` hooks. It never touches `instance.scope`, so the binding's
`watchEffect` keeps running and the registry subscription stays live. With
`<KeepAlive :max="10">` at `index.vue:526` and `:687`, up to ten hidden panels
would keep polling. `ChatPanel.vue:130-137`'s existing `onActivated`/`onDeactivated`
discipline must be preserved, not deleted.

It must **not** be preserved by putting `active` in the family key. A different
key is a different atom and a different node, so the `mapAccumEffect` cursor
restarts at zero and the panel refetches the whole conversation on every
reactivation — a regression, since `pause()` today stops the interval and
deliberately leaves the cursor alone (`useChatTransport.ts:186-193`). Gate
*inside* the loop instead, so the node and its accumulated state survive:

```ts
// app/atoms/chat.ts — key on (project, key, hours) only
const chatEventsAtom = Atom.family((target: ChatTarget) =>
  appRuntime.atom((get) =>
    pollingFeed({
      interval: '2 seconds',
      initial: () => ({ since: 0, revision: 0, events: [] as ReadonlyArray<ChatEvent> }),
      fetch: (cursor) => Effect.gen(function*() {
        // Read the visibility flag per tick. Skipping the request preserves the
        // cursor; re-keying the family would discard it.
        if (!get.once(chatActiveAtom(target))) return [cursor, cursor.events] as const
        const api = yield* Api
        const page = yield* api.chatEvents({ ...target, ...cursor })
        const events = page.reset ? page.events : [...cursor.events, ...page.events]
        return [{ since: page.next, revision: page.revision, events }, events] as const
      }),
    })).pipe(Atom.setIdleTTL('10 minutes')))
```

Note `get.once` rather than `get`: a tracked read inside the loop would make the
atom a dependent of the flag and rebuild the whole stream when it flips, which
is the outcome being avoided. Whether a `get.once` from inside a running stream
body reads the current registry value is Stage 3 experiment **E7**.

### 3.10 Bundle discipline

Measured with esbuild against the installed `effect@4.0.0-beta.101`, minified and
gzipped: the `effect/unstable/reactivity` barrel costs 44.6 KB gz for the same
three modules that cost 24.6 KB gz deep-imported, because it drags in
`AtomHttpApi`, `AtomRpc`, `Hydration`, and `Reactivity`. `AtomHttpApi` alone is
60.6 KB gz. Realistic total cost is 25–37 KB gz against a 3.7 MB baseline. These
are esbuild numbers; Rollup's handling of `export * as X` namespace re-exports
differs, so the real figure comes from `pnpm build` (§6, E6).

Two lint rules, both landed in Stage 1:

```js
// eslint no-restricted-imports
{
  patterns: [
    { group: ['effect/unstable/reactivity'],
      message: 'Deep-import: effect/unstable/reactivity/Atom (the barrel costs ~20KB gz extra).' },
    { group: ['effect/unstable/reactivity/AtomHttpApi', 'effect/unstable/reactivity/AtomRpc'],
      message: '+60KB gz. This app talks to its own /api/** through app/api/api.ts.' },
  ],
  paths: [
    // The package index re-exports AtomHttpApi and AtomRpc
    // (repos/effect/packages/atom/vue/src/index.ts:37-47), so a deep-path ban
    // alone has a hole. Allowlist the composables instead.
    { name: '@effect/atom-vue',
      importNames: ['useAtom', 'useAtomValue', 'useAtomSet', 'useAtomRef',
                    'registryKey', 'injectRegistry'],
      message: 'Constructors come from the deep path: effect/unstable/reactivity/Atom.' },
  ],
}
```

---

## 4. The `AGENTS.md` edit

`CLAUDE.md` is a symlink to `AGENTS.md`; edit `AGENTS.md`. Three sections change.

### 4.1 Architecture boundaries

**Delete** the single bullet at `AGENTS.md:48-49`:

```diff
 ## Architecture boundaries

-- Keep `app/**` in plain TypeScript. Do not introduce Effect into Vue
-  components or composables.
 - Keep `electron/**` in plain JavaScript with hand-written `.d.ts` siblings, the
```

Every other bullet in that section stays exactly as written. **Insert** the
following after the `Architecture boundaries` section, before `## Composables`:

```markdown
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
  (+60 KB gz), including through `@effect/atom-vue`, which re-exports them.
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
  `nuxt typecheck` and fails `pnpm test:types`. `app/plugins/atom-registry.ts`
  is the only exception.

### Atoms

- Each atom module exports a factory `makeXAtoms(runtime)` and a module-level
  live instance `export const xAtoms = makeXAtoms(appRuntime)`. Components
  import the live instance; tests call the factory with an isolated runtime.
- Never construct an atom inside `setup()` or any function other than a factory
  or `Atom.family` — it mints a new atom, node, and state per call.
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
  `Atom.withRefresh`, `Atom.debounce`, and `Atom.swr` are BANNED: they schedule
  raw `setTimeout` and read `Date.now()` (`Atom.ts:1779`, `:1753`, `:1879`), so
  `TestClock` cannot control them.
- **A poll loop's per-tick effect must not fail.** A stream that fails has
  ENDED — `makeStream` writes the failure and returns (`Atom.ts:850-873`), and
  nothing re-arms the loop. Fold transport failures into the emitted value with
  `Effect.catch` (see `app/atoms/feed.ts`). Defects may terminate the stream;
  they are bugs.
- Imports between `app/atoms/**` follow a one-way DAG:
  `runtime → range → tree → {filters, selection} → {run-detail, events,
  session-events} → activity`. A back-edge is a review blocker. One file per
  domain noun; a file that needs a second noun in its name is two files. A file
  may fetch OR derive, never both.
- `app/atoms/**` is not auto-imported and has no `index.ts` barrel.

### Components

- Read atoms only through `useAtomValue`, `useAtom`, and `useAtomSet` from
  `@effect/atom-vue`, always with the THUNK form: `useAtomValue(() => atom)`,
  never `useAtomValue(atom)`. The thunk is reactive.
- Call every `useAtom*` composable during `setup()`. The binding resolves the
  registry with Vue `inject` and FALLS BACK TO A MODULE-LEVEL SINGLETON instead
  of erroring, so a call from `onMounted`, a watcher, a plugin body, or a bare
  util silently binds to shared global state.
- The registry comes from `app/plugins/atom-registry.ts`. Never import
  `defaultRegistry`.
- Two-way bindings use `useAtomModel` from `app/composables/atom.ts`. The
  binding returns a readonly `Ref` plus a separate setter and ships no
  writable-ref helper.
- Data that differs between two mount sites of the same component stays a PROP.
  Only app-wide preferences (feed density, errors-only, follow-output,
  follow-active) are read from global atoms.
- `<KeepAlive>` does not pause effect scopes in Vue 3.5 — `deactivate` moves the
  subtree and runs the `da` hooks; it never calls `scope.stop()`. A subscription
  survives deactivation and keeps polling. Components under `<KeepAlive>` that
  drive polling write an `active` flag the poll atom reads per tick. Do not put
  that flag in the family key — re-keying discards the accumulated cursor.

### Async state

- The async type is `AsyncResult` (v4 core), not the v3 `Result`. Three tags —
  `Initial`, `Success`, `Failure` — and `waiting` is an orthogonal boolean on
  all three. There is no `Loading` tag.
- Project `AsyncResult` into a plain discriminated view model in `app/utils/**`
  and branch on a string discriminant in the template. Never render off
  `AsyncResult.value` or `getOrElse` alone: `value()` returns the retained
  `previousSuccess` on a `Failure`, so a naive render shows stale data with no
  error indication.
- Check `AsyncResult.isInterrupted` BEFORE `matchWithWaiting`. An interrupt-only
  cause has no typed error, so `matchWithWaiting` routes it to `onDefect`.
- A superseded request does not produce an interrupt `Failure` at all: the
  node's cancel removes the exit observer before interrupting
  (`Atom.ts:594-599`). Only an explicit `Atom.Interrupt` write does.
- Do not drive a spinner off `result.waiting` for a stream-backed atom.
  `makeStream` sets `waiting: true` on every chunk and clears it only when the
  stream ends. Branch on `Initial` vs `Success`.
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
```

### 4.2 Composables

The `## Composables (app/composables/**)` section survives — `useExecutionCanvas`
and the three shims in `app/composables/atom.ts` are still composables — but two
edits are required:

```diff
 - Expose outputs via `shallowReadonly`; only intentional inputs (filters,
-  toggles, ranges) stay writable. Long-running work should expose
-  `pause`/`resume` controls.
+  toggles, ranges) stay writable. Long-running work belongs in an atom, whose
+  subscription lifetime replaces manual `pause`/`resume`.
```

and add:

```markdown
- Composables do not own data fetching or polling. A composable that would poll,
  cancel, or gate requests is an atom in `app/atoms/**`. What remains here is
  component-tree-scoped context (`provide`/`inject`), thin adapters over the
  `@effect/atom-vue` composables, and view-local state.
```

### 4.3 Composable and component tests

Replace the section body wholesale:

```diff
 ## Composable and component tests

 - Assert on the composable's returned refs directly; do not serialize state
   into DOM attributes.
-- Stub the dashboard API with `mockLiveApi()` from `test/fixtures/live-api.ts`
-  and build data with the `test/fixtures/runs.ts` builders; use `deferred()`
-  from `test/fixtures/deferred.ts` for stale-response races instead of inline
-  promise wiring.
+- Mount atom-reading components with `mountWithAtoms()` from
+  `test/fixtures/mount-atoms.ts`, which provides a fresh registry and a stub
+  `Api` layer. A forgotten registry provide does not error — it shares atom
+  values with every other test in the worker and produces order-dependent
+  flakes.
+- Stub the dashboard API with `stubApi()` from `test/fixtures/stub-api.ts`
+  (`Layer.mock` over the `Api` service) and build data with the
+  `test/fixtures/runs.ts` builders. `AtomRegistry.make({ initialValues })` seeds
+  a value but does NOT prevent the atom's effect from running, so it is a
+  supplement to the stub layer, never a replacement.
+- Stale-response races no longer exist: a superseded query is a different atom.
+  Do not port `deferred()`-driven race tests; assert atom identity instead.
 - Unmount in `afterEach` (never as the last line of a test), pair
   `vi.useFakeTimers` with cleanup, and prefer `vi.advanceTimersByTimeAsync`
   so reactivity settles.
```

And add to `## Testing`:

```markdown
- Atom tests are registry-driven and live in `test/unit/atoms/**` (node
  environment, no mounting). Use `testAtoms()` from
  `test/fixtures/atom-registry.ts` and `stubApi()` from
  `test/fixtures/stub-api.ts`; drive time with `TestClock`. No
  `vi.useFakeTimers`, no `flushPromises`.
- `@effect/atom-vue` ships a placeholder test suite, so
  `test/nuxt/atom-binding.spec.ts` owns coverage of the binding itself:
  synchronous value before first render, re-subscription on thunk dependency
  change, cleanup on unmount, `KeepAlive` survival, and registry isolation.
```

---

## 5. Staged migration

Nine stages. Every stage ends with `pnpm check` green and a working dashboard.

**Stage 2 is the point of no return**, not Stage 7. Stages 0 and 1 are app-local
and revert cleanly. Stage 2 introduces `shared/schemas/api.ts` and the wire-type
boundary, which `test/e2e` and the cassette conformance layer consume and every
later stage inherits. Stage 7 is large but it is a leaf; by then the app works
either way and the revert is one file plus one deletion.

### Stage 0 — Prune

**Goal.** Delete unreachable code and dead public API before it costs migration
effort. No user-visible change.

**Work.**
- Delete `app/components/RunNowBoard.vue` and `test/nuxt/run-now-board.spec.ts`.
  It is referenced only by its own test. First run
  `git log --diff-filter=A -- app/components/RunNowBoard.vue`; if it is staged
  for an unshipped view, skip and note it rather than blocking the stage.
- Delete `pause`/`resume` from `useLiveRuns.ts:396-397`, their returns at
  `:450-451`, their fields in `UseLiveRunsReturn`, and the single case at
  `test/nuxt/use-live-runs.spec.ts:485`. No application code calls them; under
  atoms the concept is subscription lifetime.

**Exit criteria.**
- `pnpm check` passes.
- `grep -rn 'RunNowBoard\|live\.pause\|live\.resume' app/ test/` returns nothing.
- `test/nuxt` drops from 146 cases across 27 files to 141 across 26.
  (`run-now-board.spec.ts` holds four cases, not two; the pause/resume test is
  one case with two assertions.)

**Revert.** One commit. Nothing depends on the deleted code.

### Stage 1 — Bridgehead

**Goal.** Land the infrastructure and the `AGENTS.md` rule, and settle the
experiments in §6. No production behavior converts.

**Work.**
- `pnpm add @effect/atom-vue@4.0.0-beta.101` as a runtime dependency.
- Set `ssr: false` in `nuxt.config.ts`. Keep `nitro.preset: 'node-server'`.
- Add `app/plugins/atom-registry.ts` (§3.3) with `defaultIdleTTL: 400` and **no**
  `initialValues` — the atoms it would seed do not exist yet.
- Add `app/atoms/runtime.ts` with `apiLayerAtom` and `appRuntime` (§3.3).
- Add `app/composables/atom.ts` with `useAtomRefresh`, `useAtomMount`,
  `useAtomModel` (§3.5).
- Add `app/atoms/feed.ts` with `Feed` and `pollingFeed` (§3.6).
- Add `test/fixtures/atom-registry.ts` (`testAtoms`), `test/fixtures/stub-api.ts`
  (`stubApi`), `test/fixtures/mount-atoms.ts` (`mountWithAtoms`) — §7.
- Add the two eslint rules from §3.10, plus `no-restricted-syntax` for
  `withRefresh`/`debounce`/`swr` member access under `app/atoms/**`.
- Add `test/unit/atoms/harness.spec.ts` and `test/nuxt/atom-binding.spec.ts`.
  These are permanent coverage, not throwaway probes.
- Apply the `AGENTS.md` edit (§4) **now**, before any Effect line lands in
  `app/**`.

**Exit criteria.** All seven experiments in §6 resolved and recorded in the PR.
`pnpm check`, `pnpm test:browser`, `pnpm test:desktop` pass. No file exists under
`app/atoms/tree.ts` or later.

**Revert.** One commit; `ssr: false` is a one-line revert and the fixtures are
inert without atoms. `pnpm remove @effect/atom-vue`.

### Stage 2 — Wire types, the Api service, and the costs page

**Goal.** Prove the full read path — decode, typed errors, layer, runtime, feed
loop, view model, render — on the one page with no blast radius. `app/pages/costs.vue`
is on an independent data path (`useFetch` at `:30-33`) and never touches
`useLiveRuns`.

**Work.**
- Add `shared/schemas/api.ts` with `CostOverviewResponseSchema` and its
  dependencies, plus the drift guard (§3.1). Export `CostOverviewResponseWire`.
- Add `app/api/errors.ts` (four tagged errors) and `app/api/api.ts` with `costs`
  only.
- Add `app/atoms/costs.ts` (`makeCostsAtoms` + live instance), keyed by
  `Atom.family` over an hours key constructor.
- Add `app/utils/feed-view.ts` (§3.7) and `test/unit/feed-view.spec.ts` — a table
  over Initial, waiting, Success-clean, Success-with-error, Success-with-error-
  and-no-value, typed Failure, defect Failure, interrupt Failure.
- Convert `costs.vue` off `useFetch`. Keep its `watch(hours, …)` router sync as
  plain Vue and its local `hours` ref for now (see §5, Stage 8 for the
  three-`hours` question).
- Rewrite `test/nuxt/costs-page.spec.ts` onto `mountWithAtoms` + `stubApi`.

**Exit criteria.**
- `pnpm check`, `pnpm test:e2e`, and `pnpm cassette:verify` pass — this is the
  last cheap exit before the shared-type contract is load-bearing.
- The costs page renders identically, loading and error states included.
- Stopping the dev server shows the offline state; **restarting it returns the
  data without a page reload**. This is the acceptance test for the total feed
  loop and it must be performed by hand, not only in tests.
- Bundle delta vs the Stage 1 baseline under +40 KB gz.
- `test/nuxt/costs-page.spec.ts` no longer imports `mockLiveApi`.

**Revert.** Revert. The schemas, service, runtime, and atoms are additive; only
`costs.vue` changes behavior.

### Stage 3 — Chat

**Goal.** Prove families with object keys, `Atom.fn` mutations with promise mode,
and correct polling lifecycle under `<KeepAlive>`. Delete three files and two
hand-rolled caches.

**Work.**
- Add `ChatEventsResponseSchema`, `ChatActionResponseSchema`; add `chatEvents`
  and `chatAction` to `Api`. `chatEvents` omits `hours` (§3.2). Encode the POST
  body through the existing `ChatActionSchema`.
- **Decide and record:** encoding client-side runs `isPattern(/\S/)` and
  `isMaxLength(20_000)` (`shared/schemas/chat.ts:11-16`) in the browser, so an
  empty or oversized message becomes a local `ApiRefused` instead of the server's
  400 / `InvalidChatAction`. Better UX, but a behavior change. `test/e2e/api.spec.ts`
  posts directly to the server and is unaffected.
- Add `app/atoms/chat.ts`: one exported key constructor `chatTarget(project, key)`;
  the poll family gated by `chatActiveAtom` **inside** the loop (§3.9); the action
  fn; and `chatSessionAtom` replacing the LRU.
- **Decide and record:** `Atom.family` + `setIdleTTL('10 minutes')` is GC/idle
  eviction, not the current hard capacity-10 bound (`useChatSessionState.ts:54`).
  Neither bounds the *count*. If the "long dashboards do not accumulate unbounded
  chat buffers" comment (`:45-47`) states a real requirement, restate it as a TTL
  and say so; do not drop it silently. Losing Nuxt `useState` payload
  serialization is irrelevant under `ssr: false`.
- **Decide and record:** exactly one atom owns `events`/`since`/`revision`. The
  poll family does; `chatSessionAtom` holds draft text and view state only.
- Rewrite `ChatPanel.vue:130-137` as writes to `chatActiveAtom`. Do not delete
  them.
- Delete `app/composables/useChatTransport.ts`,
  `app/composables/useChatSessionState.ts`, `app/utils/lru-list.ts`, and
  `test/nuxt/use-chat-transport.spec.ts`, `test/nuxt/use-chat-session-state.spec.ts`,
  `test/unit/lru-list.spec.ts`.
- Add `test/unit/atoms/chat.spec.ts` (cadence, cursor advance, revision reset,
  target isolation, Reset/Interrupt, recovery after a failed poll).

**Exit criteria.**
- `pnpm check` passes.
- A deactivated `<KeepAlive>`'d ChatPanel issues zero further `/api/chat`
  requests, asserted in `test/nuxt/chat-panel.spec.ts` (which already mounts
  under a KeepAlive harness at `:22-36`).
- **Deactivate then reactivate and assert the next request carries the
  pre-deactivation `since`, not 0.**
- ChatPanel's two mount sites (`index.vue:692` session root key,
  `RunInspector.vue:231` inspected agent key) still hold independent
  conversations. `project` and `sessionKey` stay props.
- `test/unit/atoms/chat.spec.ts` runs under 100 ms with no fake timers.
- Send, cancel, and reset work against a real agent.

**Revert.** Three deleted files return with their specs.

### Stage 4 — Plain state atoms

**Goal.** Convert all non-async client state, and collect the largest
prop-drilling deletion in the codebase. No schema and no network risk — this
stage touches nothing that owns a request.

**Work.**
- `app/atoms/filters.ts`: eight writable atoms replacing
  `useSessionFilters.ts:46-53`, plus derived `visibleProjectsAtom` and
  `projectOptionsAtom` calling the existing pure `filterSessionProjects`
  verbatim. `app/utils/session-filter.ts` and its unit test are untouched.
- `app/atoms/preferences.ts`: **four** atoms — `densityAtom`, `errorsOnlyAtom`,
  `followOutputAtom`, `followActiveAtom`. `followActive` is a returned member
  (`useLiveRuns.ts:106`), a v-model on `RunHero` (`index.vue:478`,
  `RunHero.vue:16`), and the driver of the follow-active auto-selection; the
  first three are the app-wide display preferences that delete three props from
  `RunInspector` (`:19-21`), their forwarding to `EventFeed` (`:136-139`), two
  `update:` emits (`:32-33`), and two handlers in `index.vue` (`:678-679`).
- Route the twelve writable `UseLiveRunsReturn` members through `useAtomModel`
  (§3.5). `RunSidebar`'s nine v-models plus `RunHero`'s `followActive` are ten
  of them.
- Have `useLiveRuns` read the filter and preference atoms, keeping its return
  shape identical. Delete `app/composables/useSessionFilters.ts`.
- Wrap multi-atom updates (clear-all-filters) in `Atom.batch`.
- **Do not** use `Atom.searchParam`. None of these filters is URL-synced today,
  and it carries module-level `searchParamState` (`Atom.ts:2266-2270`), a 500 ms
  raw-`setTimeout` debounce, and silent collapse of decode failures to
  `Option.none`. `index.vue`'s existing `route.query.view` sync stays plain Vue.
- **Do not** touch the range handshake. It moves in Stage 5, with the tree atom
  that replaces it.

**Exit criteria.**
- `pnpm check` passes; `pnpm test:types` passes without widening any declared
  member type.
- Every writable member of `UseLiveRunsReturn` is produced by `useAtomModel`.
- Filtering, sorting, density, errors-only, follow-output, and follow-active
  behave identically.
- `RunInspector.vue` lost three props and two emits.
- `grep -rn 'useSessionFilters' app/ test/` returns nothing.
- No `Atom.searchParam` anywhere in `app/**`.

**Revert.** `useSessionFilters.ts` returns; three props return to `RunInspector`.

### Stage 5 — The tree spine and the range

**Goal.** Land the hardest schema and the first polled data atom, with
`useLiveRuns` preserved as an adapter so `index.vue` does not move.

**Work.**
- Add `RunNodeSchema`, `PublicRunNodeSchema`, `TreeResponseSchema` and their
  `*Wire` types (§3.1). Migrate the `import type` lines of the components that
  read tree data to the wire types.
- **Resolve** whether `TreeResponse.costs` is genuinely optional (§3.1).
- **Benchmark before shipping** (§6, E5): decode **plus** the atom's equality
  check on a realistic captured `TreeResponse`, 100 iterations.
- Add `tree` to `Api`; add `app/atoms/tree.ts` per §3.6, with derived `projects`,
  `sources`, `costs`, and `loading`/`offline` projections of the feed.
- **Equality.** `Atom.withEquality(Equal.equals)` suppresses re-renders when a
  poll returns identical data — atoms default to `Object.is` (`Atom.ts:231-243`)
  and every rebuild mints a fresh object. But it is not free: `Equal.equals` on
  two objects computes `Hash.hash` of both first (`Equal.ts:245-247`), and the
  freshly decoded graph is uncached, so a full deep `Hash.structure` walk of
  hundreds of recursive `RunNode`s happens every 4 s. If the benchmark does not
  fit the budget, use a cheap custom equality over the response's natural version
  signals instead and reserve structural equality for the small derived atoms.
- **The range.** Delete the `rangeInitialized` handshake
  (`useLiveRuns.ts:227-244`) and replace it with an explicit one-shot, *not* with
  `runtimeConfig.public`. Publishing the default through public runtime config
  breaks `lcc --hours 24`: `bin/liveclaudecode:141` and `electron/desktop.js:165`
  set `NUXT_LCC_HOURS`, which overrides the **private** namespace only; nothing
  sets `NUXT_PUBLIC_LCC_HOURS`, and under `ssr: false` the public payload is
  baked at build time. `parseHours` lets a client-supplied value override the
  configured one outright (`shared/schemas/request.ts:148-156`), so the server
  would not correct it — the user asks for a day and silently gets a week. The
  handshake also delivers the server's *clamped* effective value
  (`clampConfiguredHours`, `:86-98`), which `nuxt.config.ts:22`'s raw
  `Number(process.env.LCC_HOURS || 168)` does not.

  ```ts
  // app/atoms/range.ts
  /** The range the user asked for. `null` until they choose one. */
  const explicitHoursAtom = Atom.make<number | null>(null)
  /** The server's effective, clamped range, learned from the first tree response. */
  export const serverHoursAtom = Atom.make<number | null>(null)

  export const hoursAtom: Atom.Writable<number | undefined, number> = Atom.writable(
    // `undefined` omits the query parameter, which is exactly the first request
    // the current handshake makes.
    (get) => get(explicitHoursAtom) ?? get(serverHoursAtom) ?? undefined,
    (ctx, value) => ctx.set(explicitHoursAtom, value),
  )
  ```

  `treeAtom`'s fetch writes `serverHoursAtom` once, when it is still `null`,
  from `response.hours`. Because the write happens inside the fetch and only on
  the null-to-value transition, there is no cycle: the second read yields the
  same value and the atom does not re-key.
- **The invalidation cascade.** `watch(hours, …)` at `useLiveRuns.ts:369-384`
  clears projects, selection, run, both streams, both gates, session events,
  truncation, and the inspection. Re-keying handles the data atoms — a different
  `hours` is a different family key. The explicit-selection reset is a real write
  that must be wired deliberately, or the dashboard keeps a `{project, key}` that
  no longer exists in the narrowed range.
- Rewire `useLiveRuns` internals onto these atoms, deleting the tree poller,
  `treeGeneration`, the `treePending`/`treeReloadQueued` coalescing, and the
  `loading`/`offline` booleans. Keep `UseLiveRunsReturn` byte-identical.
- **Decide and record:** `offline` currently latches on *any* failed request and
  clears on *any* success (`:209`, `:212`). Derived from atoms it becomes
  per-atom. Recommendation: it means "the tree poll is failing" — the tree is the
  heartbeat. The current behavior is arguably accidental.

**Exit criteria.**
- `pnpm check` passes.
- `test/nuxt/index-page.spec.ts` and `accessibility.spec.ts` pass with **no change
  to `index.vue`** — the proof that the adapter held.
- The sidebar does not blank during a refetch.
- Decode + equality benchmark recorded in the PR against the 16 ms criterion.
- `node bin/liveclaudecode --hours 24` against a production build shows 24 hours,
  and the browser's first `/api/tree` request carries no `hours` parameter.
- Manual check against recorded cassettes: the tree renders for a real Claude,
  Codex, **and** Copilot session. Schema decode is the first thing in this
  project that can reject real transcript-derived data.

**Revert.** The tree path returns to `$fetch`; `index.vue` never changed.

### Stage 6 — Selection, run detail, events, session activity

**Goal.** Convert the remaining data flow and delete the hand-rolled staleness
machinery.

**Work.**
- Add `RunResponseSchema`, `EventsResponseSchema`, `SessionEventsResponseSchema`
  and their wire types; add `run`, `events`, `sessionEvents` to `Api`.
- `app/atoms/selection.ts` — **three** inputs, not two. The bootstrap selection
  (`useLiveRuns.ts:250-253`) fires only when nothing is selected, but
  `followActive` (`:255-260`) fires on *every* tree poll and deliberately
  overrides an explicit selection. Under `explicit ?? auto` the toggle would do
  nothing once the user clicks anything.

  ```ts
  // app/atoms/selection.ts
  const explicitSelectionAtom = Atom.make<Selection | null>(null)

  /** Deepest live node of the first non-empty visible project. */
  const bootstrapSelectionAtom = Atom.make((get): Selection | null => { … })

  /** Newest live node of the selected root — the follow-active target. */
  const liveFollowSelectionAtom = Atom.make((get): Selection | null => { … })

  export const selectionAtom: Atom.Writable<Selection | null, Selection | null> =
    Atom.writable(
      (get) => get(followActiveAtom)
        ? get(liveFollowSelectionAtom) ?? get(explicitSelectionAtom) ?? get(bootstrapSelectionAtom)
        : get(explicitSelectionAtom) ?? get(bootstrapSelectionAtom),
      (ctx, value) => ctx.set(explicitSelectionAtom, value),
    )
  ```

  Keep `project` and `key` in one atom — every consumer reads them as a pair and
  they must change atomically. Selecting a new agent must also clear
  `inspectedKeyAtom`; `select()` calls `clearInspection()` at `:359` today and
  nothing couples the two under a derived selection.
- `app/atoms/run-detail.ts`, `events.ts`, `session-events.ts`, `activity.ts` —
  each a family with one exported key constructor, each using `pollingFeed`.
  `sessionEventsAtom` keys on the session **root**, not the selection
  (`useLiveRuns.ts:303`: `selectedRoot.value?.key || selectedKey.value`), so its
  key constructor derives from tree data. `sessionEventsTruncated` is a plain
  field of the response, not an `AsyncResult` state.
- `app/atoms/activity.ts` owns two things the design previously left homeless.
  First, extract the base-selection and fallback-mapping currently inline at
  `index.vue:155-165` (session events, else the selected agent's events remapped
  with `agentKey`/`agentLabel`/`agentType`/`agentDepth`) into
  `app/utils/activity-feed.ts` as a pure function with its own unit test. Second,
  decide where the per-session activity-agent selection lives —
  `index.vue:52-55` and `:110-117` hold a capacity-20 MRU `Map`
  (`ACTIVITY_AGENT_CAPACITY`), unrelated to `app/utils/lru-list.ts`. Either an
  `Atom.family` keyed by session identity, or an explicit note that it stays a
  `shallowRef` in `index.vue` and the atom takes it as a parameter.
- Delete `app/composables/useEventStream.ts`, `app/utils/latest-request-gate.ts`,
  `app/utils/event-poller.ts`, the AbortController pool and `disposed` flag in
  `useLiveRuns.ts`, and `test/unit/latest-request-gate.spec.ts`,
  `test/unit/event-poller.spec.ts`. **All of this is contingent on E3** — if E3
  failed, the guards are ported instead.
- **`structuralComputed` survives.** It has three consumers and two of them
  compute over *props*, where `Atom.withEquality` cannot substitute:
  `ActiveAgentsOverview.vue:32` over `props.projects` and
  `RunCanvas.client.vue:88` over props. Replace only the third — the atom-backed
  `activityEvents` at `index.vue:154-171` — with `Atom.withEquality(structurallyEqual)`
  on `activityEventsAtom`, and remove that import in Stage 7 where `index.vue` is
  allowed to change. Do not rename `app/utils/structural-computed.ts`.
- Delete `test/nuxt/use-live-runs.spec.ts`; add `test/unit/atoms/{selection,
  run-detail,events,session-events,activity}.spec.ts`.

**Exit criteria.**
- `pnpm check` passes.
- Rapid clicking between agents produces no stale data and no error banner.
- With follow-active on, an explicitly selected agent is superseded when a newer
  live agent appears in the same session; with it off, it is not. There is no
  test asserting this today — write one.
- `grep -rn 'AbortController\|latestRequestGate\|createEventPoller' app/` returns
  nothing. `structuralComputed` still has two consumers.
- `index.vue` still unchanged; `index-page`, `run-inspector`, `session-canvas`
  specs pass.
- `pnpm test:browser` and `pnpm test:desktop` pass.

**Revert.** Restores five app files and two unit specs; `index.vue` untouched.

### Stage 7 — `index.vue`

**Goal.** Remove the adapter. Deliberately last, so every atom it needs exists
and is tested.

**Work.**
- Enumerate all 31 distinct `live.*` reads against the atom modules **before
  starting**. A member with no handle means `index.vue` grows a local computed to
  compensate and the god-module reassembles inside the page.
- Replace `const live = useLiveRuns()` with direct atom reads. Every `useAtom*`
  call in `setup()` — no exceptions, and the failure is silent.
- Migrate the eight watchers on live state (`:328-400`); most become derived
  atoms. Route synchronisation, focus management, and status announcements stay
  plain Vue.
- Move the `WorkspaceState` `shallowRef` (`:42-45`) to an atom.
  `app/utils/workspace-state.ts` is already thirteen pure reducers; its unit test
  is untouched. `route.query.view` seeding stays plain Vue.
- Remove the `structuralComputed` import for `activityEvents` only.
- Delete `app/composables/useLiveRuns.ts`.
- **Do not touch** `app/composables/useExecutionCanvas.ts`. It carries
  component-tree position — `RunCanvas.client.vue:187` provides,
  `ExecutionAgentNode.vue:15` injects through VueFlow's node-type registry where
  props cannot reach. Atoms are global and cannot express "the canvas I am
  inside". It is the file that keeps the provide/inject rule alive.
- **Do not touch** `RunCanvas.client.vue`'s lifecycle hooks (`:482-485`) —
  viewport fitting and replay playback, not transport. `previousPositions`
  (`execution-graph.ts:373`) is per-canvas-instance state and stays in the
  component.
- Confirm `app/utils/session-state.ts` gained no Atom or Vue dependency; it is
  imported by `server/utils/transcript.ts` and `server/utils/services.ts`.

**Exit criteria.**
- `pnpm check` passes; `grep -rn 'useLiveRuns' app/ test/` returns nothing.
- No `Effect.gen`, `Effect.fn`, `Effect.run*`, `Layer`, or `HttpClientRequest`
  in any `.vue` file, enforced by eslint.
- `pnpm test:browser` and `pnpm test:desktop` pass. These intercept at the
  network layer (`test/browser/api-mocks.ts:34`) and are the only tests that
  prove the migrated client still speaks the same HTTP.
- Manual smoke against a live agent session.

**Revert.** The largest single revert. Land it as its own commit with nothing
else in it. Backed out, Stages 1–6 remain shipped and useful.

### Stage 8 — Debug page, fixture removal, documentation

**Goal.** Retire the last non-atom data path and finish the paperwork.

**Work.**
- Add `ParseHealthResponseSchema` and `parseHealth` to `Api`; convert
  `app/pages/debug.vue` off `useFetch` (`:60`). Convert
  `test/nuxt/debug-page.spec.ts` off `registerEndpoint` (`:10`).
- Delete `test/fixtures/live-api.ts`; delete `test/fixtures/deferred.ts` if
  nothing else uses it.
- **Decide and record** the `hours` question. Three independent hours states
  exist today: `useLiveRuns.ts:158` (dashboard, not URL-synced),
  `costs.vue:17` (URL-synced, own `normalizeHours` at `:88`), and `debug.vue:16`
  (same, `:94`). Either the pages keep independent local ranges — then say so and
  `hoursAtom` is dashboard-only — or they unify onto `hoursAtom`, which forces a
  decision about URL sync against the explicit no-`Atom.searchParam` choice.
  Either way, fold the duplicated `normalizeHours` into one shared util.
- **Decide and record** `app/composables/useCodeHighlight.ts` and
  `app/utils/highlighter.ts`. Neither appears in any earlier stage.
  `useCodeHighlight` carries a generation counter (`:62`, `:76`, `:94`, `:99`,
  `:104`) and a scope-dispose guard (`:110-112`) — exactly the staleness
  machinery Stage 6 deletes everywhere else — and `highlighter.ts:37` holds
  `const pendingLanguages = new Map<…>()` at module scope, the one rule violation
  the migration was supposed to remove. "Leave both as-is" is an acceptable
  answer, but it must be written down, because the new `app/utils/**` rule reads
  as permitting the module-level map while the global "no module-level mutable
  state" bullet reads as forbidding it.
- **Consider and record** adding `data: { _tag }` to `createError` in
  `server/utils/runtime.ts:104-127`. The client cannot distinguish
  `UnknownProject` from `NoTranscriptsFound` (both 404) or `ChatBusy` from
  `ChatCapacity` by anything but the status. Small and low-risk; do it only if a
  consumer needs the granularity.
- **Documentation.** Five files under `docs/` teach machinery this migration
  deletes:
  - `docs/testing-tutorial.md:117-127`, `:307` — prescribes `mockLiveApi()` and
    `deferred()`; rewrite the fixture table onto `testAtoms`/`stubApi`/
    `mountWithAtoms`.
  - `docs/writing-tests-opencode-style.md:462-472` — states "zero Effect — a hard
    boundary identical to the `app/**` rule in CLAUDE.md" and tabulates
    `mockLiveApi`/`deferred`; same rewrite.
  - `docs/vue-flow-lessons-from-n8n.md:133-163`, `:490` — presents
    `structuralComputed` as "the workhorse". It survives (Stage 6); add a note
    that only the atom-backed use moved.
  - `docs/transcript-cassettes-spec.md:684`, `:802-808` — cites `mockLiveApi` and
    `deferred`.
  - `docs/progressive-disclosure-workspace-spec.md:1073` — names
    `app/composables/useLiveRuns.ts` as the state owner; add a dated
    "superseded by the atom migration" note.
  - `README.md:227-235` and `AGENTS.md`'s repository map — add `app/api/**` and
    `app/atoms/**`; `composables/` is no longer "polling, selection, and combined
    filtering state".
- Re-run the bundle measurement; record the final delta.

**Exit criteria.**
- `pnpm check` passes, including `pnpm cassette:verify`.
- `grep -rn 'mockLiveApi' app/ test/` returns nothing; `$fetch` appears only in
  server-side code.
- All three pages read from atoms.
- Final bundle delta within +40 KB gz.
- Every deferred decision in this document is either resolved in a stage or
  recorded as a deliberate non-decision in the PR.
- If any blessed `expected/*.json` changed during the migration, the PR explains
  why — that means the client changed the query parameters it sends, which is the
  cassette system working as designed.

---

## 6. Stage-gate experiments

These are **unverified**. Each has a defined pass/fail and must be settled in
Stage 1 (E7 in Stage 3) before the stage that depends on it. Record the outcome
of each in the Stage 1 PR, including the ones that pass.

### E1 — The registry provide reaches the binding · BLOCKING

`@effect/atom-vue` is not installed; nobody has verified that
`mountSuspended`'s `global.provide` with a `Symbol.for` key reaches
`injectRegistry()` through Nuxt's app-level provide chain.

**Test.** `test/nuxt/atom-binding.spec.ts`: two consecutive cases in one file,
each mounting through `mountWithAtoms` a component that writes a different value
to the same module-scope writable atom.

**Pass.** Each case observes only its own value.
**Fail.** Every mounted test from Stage 2 onward is order-dependent and the
failures look like race conditions. Fallbacks, in order: a `RegistryProvider`
wrapper component that calls `provide` in its own setup and wraps every mount;
`app.runWithContext`. Do not proceed to Stage 2 unresolved.

### E2 — The layer-atom seam isolates a stub · BLOCKING

`Atom.runtime((get) => get(apiLayerAtom))` is supported by the source
(`Atom.ts:702-710`, `:740-746`) but has not been exercised.
`AtomRegistry.make({ initialValues })` is **not** an alternative: seeding does
not prevent the atom's read (`AtomRegistry.ts:619-634`).

**Test.** Two `it.effect` cases, each building its own stub layer and its own
registry, each writing that layer into `apiLayerAtom` before mounting an atom
built from `appRuntime`. Assert each sees only its own stub's data, and that no
real `fetch` occurs (stub `globalThis.fetch` with a throwing function for the
duration).

**Pass.** Both isolated, no `fetch`.
**Fail.** The only remaining seam is stubbing `FetchHttpClient.Fetch` in the
Nuxt test setup — URL-string stubbing under a different name. Record it and
adjust §7 accordingly.

### E3 — Interrupt aborts the in-flight request · BLOCKING for Stage 6

Deleting `latest-request-gate.ts`, `event-poller.ts`'s generation counter, and
the AbortController pools rests entirely on this. The wiring is clear in source
(`Atom.ts:568-570` registers `cancel`; `:594-599` interrupts;
`HttpClient.ts:664-666` aborts) but the end-to-end path has not been run.

**Test.** An `it.effect` case starts a slow atom (`Effect.sleep('10 seconds')`
inside `runtime.atom`) with a registered finalizer, calls `registry.refresh`, and
asserts the first fiber's finalizer ran. Then the HTTP half: a stub `fetch` that
records `signal.aborted`, an atom that starts a request, a refresh, and an
assertion that the signal aborted.

**Pass.** Finalizer observed and signal aborted.
**Fail.** Stage 6 ports the guard machinery instead of deleting it. The
migration still succeeds; it keeps roughly 70 lines it hoped to lose.

### E4 — The poll loop recovers from a failure · BLOCKING

The whole `pollingFeed` shape (§3.6) exists because a stream that fails is a
stream that has ended. Prove the fold works.

**Test.** `stubApi` whose `tree` fails three times then succeeds. Mount the atom,
`TestClock.adjust` past four intervals, and assert four API calls and a final
`Feed` with `error: null` and a value. Separately assert that on the second call
the `Feed` carried `error !== null` **and** the previous `value`.

**Pass.** Four calls; recovery observed; stale value preserved through the
failures.
**Fail.** Redesign the poll loop before Stage 2 — the fallback is
`Stream.retry(Schedule.spaced(interval))`, which is acceptable for snapshot polls
(tree, run) but wrong for cursor polls (events, chat) because a retry restarts
the stream and resets `mapAccumEffect` state to `since = 0`.

### E5 — `TestClock` drives atom-internal timers · BLOCKING for the test strategy

The mechanism is verified in source — `makeEffect` and `makeStream` fork with
`Effect.runForkWith(services)` where `services` derives from the layer context
(`Atom.ts:548-551`, `:876-881`), and `Clock` is a `Context.Reference` a layer can
override. The single load-bearing line is
`Layer.succeed(Clock.Clock, yield* Clock.clockWith(Effect.succeed))` inside
`testAtoms`; without it the atom silently gets the live clock.

**Test.** A `pollingFeed` atom over a stub Api. Assert one call at t=0, two after
`TestClock.adjust('2 seconds')`, four after a further four seconds — **and** a
test wall time under 50 ms. The wall-clock bound is what catches a silent
fallback to the live clock.

**Pass.** Exact counts and under 50 ms.
**Fail.** Atom timing tests fall back to `vi.useFakeTimers`. The migration
proceeds; the test-side benefit is lost and `AGENTS.md`'s TestClock rule needs a
carve-out.

### E6 — `ssr: false` does not break the app, and the bundle fits · BLOCKING

**Test.** `pnpm test:browser` and `pnpm test:desktop` unchanged
(`test/browser/api-mocks.ts:34` intercepts at `page.route('**/api/**')` and is
blind to rendering mode). Manually load the Electron shell
(`electron/main.js:97`). Record `du -sb .output/public/_nuxt` (currently ~3.7 MB)
and per-chunk gzip sizes with the already-installed `rollup-plugin-visualizer`.

**Pass.** All pages render and poll; baseline recorded. Note any first-paint
regression on `costs.vue` and `debug.vue`, the only two pages fetching during SSR
today. Add `spaLoadingTemplate` if the blank paint is objectionable.

### E7 — Reading an atom from inside a running stream body · BLOCKING for Stage 3

§3.9 gates the chat poll on `get.once(chatActiveAtom(target))` inside the
`mapAccumEffect` body, rather than re-keying the family. `AtomContext.once` reads
through the registry without linking (`AtomRegistry.ts:932-934`), but whether a
call from inside a long-running stream body — after the atom's `read` has already
returned — observes the current registry value has not been tested.

**Test.** An atom whose stream reads a flag per tick. Flip the flag between
ticks with `registry.set`. Assert the loop observes the flip and that flipping it
does **not** rebuild the stream (count stream constructions).

**Pass.** Flip observed, one construction.
**Fail.** Fall back to a `SubscriptionRef` the component writes and the stream
reads, or accept polling-while-hidden and drop the requirement explicitly in
Stage 3.

### Not experiments, but recorded

Two claims are settled by reading the source and need no test; they are here so
nobody "fixes" them back.

- **`Atom.withRefresh`, `Atom.debounce`, and `Atom.swr` escape `TestClock`.**
  `Atom.ts:1779`, `:1753`, `:1879`. Enforced by eslint.
- **A superseded poll produces no `Failure`, and `matchWithWaiting` sends
  interrupts to `onDefect`.** `Atom.ts:594-599`, `AsyncResult.ts:650-657`. See
  §3.7.

One thing this document does **not** specify and deliberately leaves out:
`Atom.pull` as the mechanism for incremental transcript loading. Its happy path
is well covered by the vendored tests
(`repos/effect/packages/effect/test/reactivity/Atom.test.ts:681-815`) but the
error-then-retry path is not: after a mid-stream failure the scope stays open and
the `pullSignal` subscription stays registered (`Atom.ts:1309-1325`), and whether
a subsequent `set()` re-pulls a dead channel, hangs, or re-fails is untested.
The cursor protocol these endpoints already speak (`since`/`revision`/`reset`)
is a better fit for `mapAccumEffect` anyway. If `Atom.pull` is wanted later, the
prerequisite experiment is: fail the stream mid-pull, `set()` again, and assert
the atom either re-fails or recovers — the safe fallback being
`registry.refresh()` to rebuild from the top of the stream rather than `set()` to
continue.

---

## 7. Behavior parity checklist

The acceptance test. Each item is a behavior of the current dashboard that must
still work, with the stage that owns it.

**Data and freshness**

- [ ] The tree, run detail, transcript events, and session activity all refresh
      on their current cadences (4 s / 6 s / 2 s / 4 s). — 5, 6
- [ ] **A failed poll does not stop the loop.** Stop the server, see the offline
      state, restart it, and the data returns without a page reload. — 2
- [ ] The sidebar and transcript do not blank during a refetch; stale data stays
      on screen behind the offline indicator. — 5
- [ ] `offline` clears on the next success. — 5
- [ ] Transcript event buffers accumulate across polls and are replaced wholesale
      when the server sets `reset`. — 6
- [ ] `sessionEventsTruncated` still reaches `EventFeed`. — 6

**Range**

- [ ] The first `/api/tree` request carries no `hours` parameter; the client
      adopts the server's effective, clamped value. — 5
- [ ] `liveclaudecode --hours 24` and the Electron shell's equivalent both show
      24 hours. — 5
- [ ] Changing the range clears the selection, the run, both event streams, the
      session activity feed, and the inspection. — 5

**Selection**

- [ ] On first load, the deepest live node of the first non-empty visible project
      is selected. — 6
- [ ] With follow-active **on**, an explicit selection is superseded when a newer
      live agent appears in the same session. — 6
- [ ] With follow-active **off**, an explicit selection is never overridden. — 6
- [ ] Selecting a new agent closes the inspector overlay. — 6
- [ ] Rapid clicking between agents shows no stale data and no error banner. — 6

**Chat**

- [ ] Send, cancel, and reset each work and each report their pending state. — 3
- [ ] A `<KeepAlive>`'d ChatPanel stops polling on deactivate. — 3
- [ ] **Reactivating resumes from the existing cursor, not from zero.** — 3
- [ ] ChatPanel's two mount sites hold independent conversations. — 3
- [ ] Chat session state (draft, view state) survives switching away and back
      within the TTL. — 3

**Filters and preferences**

- [ ] All eight session filters, plus sort, still filter and sort identically. — 4
- [ ] Feed density, errors-only, follow-output, and follow-active all persist
      across panel switches and drive both toolbars. — 4
- [ ] All twelve two-way bindings still write. — 4

**Structure**

- [ ] `EventFeed`'s two mount sites still receive different event sets. — 4, 6
- [ ] The execution canvas still receives per-canvas context through
      `useExecutionCanvas`, and `previousPositions` stays per instance. — 7
- [ ] The costs page and the debug page still render, including their range
      selectors and CSV export. — 2, 8
- [ ] The run tree renders correctly for real Claude, Codex, and Copilot
      sessions replayed from cassettes. — 5

**Non-regression**

- [ ] `pnpm test:browser` and `pnpm test:desktop` pass unchanged at every stage.
- [ ] `pnpm cassette:verify` passes; any blessed-file diff is explained.
- [ ] The server remains read-only with respect to transcript data.

---

## 8. Testing

### 8.1 Where tests live

| Subject | Location | Environment |
| --- | --- | --- |
| Pure functions (`app/utils/**`) | `test/unit/*.spec.ts` | node — unchanged |
| Atom wiring, cadence, cursors | `test/unit/atoms/*.spec.ts` | node, no mounting |
| The Vue binding itself | `test/nuxt/atom-binding.spec.ts` | nuxt |
| Component rendering | `test/nuxt/*.spec.ts` | nuxt |
| Real HTTP | `test/browser/`, `test/e2e/` | unchanged |

Atom tests are registry-driven and need no DOM: nothing in `AtomRegistry.ts` or
`Atom.ts` imports Vue. They run roughly thirty times faster than a mounted test.

### 8.2 `test/fixtures/atom-registry.ts`

```ts
/**
 * An isolated atom runtime and registry for one `it.effect` case.
 *
 * The runtime gets its own `Layer.MemoMap`, so nothing memoizes across tests,
 * and it is handed the *ambient* `Clock` — under `it.effect` that is the
 * `TestClock`, which is what makes `TestClock.adjust` drive `Effect.sleep`
 * inside an atom. Without the `Layer.succeed(Clock.Clock, …)` line the atom
 * silently gets the live clock and every timing assertion becomes a real-time
 * race. The registry is disposed with the test scope.
 */
export const testAtoms = Effect.fn('testAtoms')(function* <R>(layer: Layer.Layer<R>) {
  const clock = yield* Clock.clockWith(Effect.succeed)
  const runtime: Atom.AtomRuntime<R> = Atom.context({ memoMap: Layer.makeMemoMapUnsafe() })(
    Layer.provideMerge(layer, Layer.succeed(Clock.Clock, clock)),
  )
  const registry = AtomRegistry.make()
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()))

  return {
    registry,
    runtime,
    get: <A>(atom: Atom.Atom<A>) => Effect.sync(() => registry.get(atom)),
    set: <R2, W>(atom: Atom.Writable<R2, W>, value: W) => Effect.sync(() => registry.set(atom, value)),
    refresh: <A>(atom: Atom.Atom<A>) => Effect.sync(() => registry.refresh(atom)),
    /** Suspends until the atom leaves `Initial`/`waiting`. */
    settled: <A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) =>
      AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }),
    /** Keeps an atom alive for the test scope, the way a mounted component would. */
    mount: <A>(atom: Atom.Atom<A>) => AtomRegistry.mount(registry, atom),
    /** Records every value the atom publishes; returns a reader. */
    recorded: <A>(atom: Atom.Atom<A>) => …,
  }
})
```

Note `registry.mount(atom)` is exactly `subscribe(atom, constVoid, { immediate: true })`
(`AtomRegistry.ts:416-417`), so `recorded()` doubles as a mount.

### 8.3 `test/fixtures/stub-api.ts`

`Layer.mock` is already the house stub idiom
(`test/unit/session-browser.spec.ts:52`, and the recent commits "Stub only what
the tests use, with `Layer.mock`" and "Observe stub calls through a Ref-backed
call log"). It turns an unstubbed endpoint into a **named defect** rather than a
plausible default — the same loud-failure property `mockLiveApi` gets from
`throw new Error('Unexpected URL')` (`test/fixtures/live-api.ts:104`), but at the
service boundary. `makeCallLog` from `test/fixtures/call-log.ts:22` supplies
observation through a per-construction `Ref`, so `it.only` behaves like a full
run. The `test/fixtures/runs.ts` builders supply payloads unchanged.

Grow the handler set as endpoints migrate. Do not port all eight up front.

### 8.4 `test/fixtures/mount-atoms.ts`

Contingent on E1 and E2. It builds a fresh registry **and** a fresh stub layer,
writes the layer into `apiLayerAtom`, and provides the registry under
`registryKey`. It is the only sanctioned way to mount an atom-reading component.

```ts
export async function mountWithAtoms<T>(component: T, options: {
  readonly api?: StubApiHandlers
  readonly initialValues?: Iterable<readonly [Atom.Atom<any>, any]>
  readonly global?: Record<string, unknown>
} = {}) {
  const registry = AtomRegistry.make({ initialValues: options.initialValues })
  // Substitute the Api layer before anything reads an atom. Seeding alone is
  // NOT enough: a seeded node still runs its read (AtomRegistry.ts:619-634).
  registry.set(apiLayerAtom, stubApiLayer(options.api))
  const wrapper = await mountSuspended(component, {
    ...options,
    global: { ...options.global, provide: { [registryKey]: registry } },
  })
  return { wrapper, registry }
}
```

### 8.5 Disposition of the existing suite

- `test/nuxt/use-live-runs.spec.ts` (15 cases) and
  `test/nuxt/use-chat-transport.spec.ts` (9) are deleted and rewritten as
  `test/unit/atoms/*.spec.ts`. Their harness components, seven `useFakeTimers`
  blocks, and `deferred()`-driven A–B–A race at `:142-180` exist to work around
  not having a registry and a clock.
- `test/nuxt/use-execution-canvas.spec.ts` stays mounted — it tests a
  provide/inject contract with nothing to migrate.
- `test/nuxt/use-chat-session-state.spec.ts` is deleted with its subject in
  Stage 3.
- The eight specs using `mockLiveApi` (accessibility, chat-panel, costs-page,
  index-page, run-inspector, session-canvas, and the two above) convert to
  `mountWithAtoms` as their data source migrates.
- The nineteen prop-only component specs are untouched and stay
  zero-dependency — which is only true as long as their components stay
  prop-driven. That is why only four app-wide preferences become global atoms.
- `test/unit/*.spec.ts` over `app/utils/**` is entirely unaffected, except that
  `latest-request-gate.spec.ts`, `event-poller.spec.ts`, and `lru-list.spec.ts`
  are deleted with their subjects.
- The cassette system is untouched at all three levels. L1 decodes with
  `shared/schemas` parsers, L2 scans committed bytes, L3 hits a real Nitro server
  through `@nuxt/test-utils/e2e`'s HTTP `$fetch`. None of them renders client
  code.

---

## 9. Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| A failed poll latches the atom into `Failure` forever, freezing the dashboard behind a banner that never clears | high | §3.6's total feed loop; E4 gates it; Stage 2's exit criterion requires a manual stop-restart-recover check |
| Mounted tests cannot stub the Api, so every component spec makes real network calls with a late state flip | high | §3.3's layer-atom seam; E2 gates it; `mountWithAtoms` is the only sanctioned mount |
| Wire types collide with the server's mutation of `RunNode.children` | high | §3.1's `*Wire` boundary; the drift guard is a one-line compile error; spike `RunNodeSchema` against `server/utils/runs.ts` in Stage 1 |
| Schema decode plus structural equality is too expensive at poll cadence — 800 events every 2 s, hundreds of recursive nodes every 4 s, against zero validation today | high | Stage 5 benchmarks decode **and** `Equal.equals` together against a 16 ms budget; escape hatches are a cheap version-signal equality and `Schema.Unknown` for the hottest arrays, both recorded as a forfeit |
| The atom modules re-collapse into a god-module | high | the declared DAG, one-noun-per-file, fetch-or-derive-never-both, no auto-import, no barrel — all in `AGENTS.md` and enforced in review |
| `--hours` silently stops working | high | the range stays server-declared (§5, Stage 5); the exit criterion runs the real CLI against a production build |
| `follow-active` silently stops working | medium | three-input `selectionAtom` (§5, Stage 6); there is no test asserting this today, so write one |
| A duplicate `effect` copy from peer resolution doubles the bundle and breaks atom identity across the copies | medium | `pnpm why effect` in Stage 1; fix with a pnpm `overrides` entry; also diff the published dist against the vendored source every claim here cites |
| `Atom.family` identity is not GC-stable, so accumulated cursors or drafts can vanish | medium | `defaultIdleTTL: 400` plus explicit `setIdleTTL` on the chat families; treat family as a memo, not a store; nobody could construct a deterministic test because GC timing is not controllable |
| Nuxt/Vite HMR: after `registry.dispose()` any node creation throws (`AtomRegistry.ts:443-446`), and HMR replacing an atom module mints new identities while the registry holds the old ones | low | development-only; under `ssr: false` the registry is created once per browser session and not disposed. Try it in Stage 2; if ghost state appears, `import.meta.hot?.accept(() => location.reload())` in the atom modules. Do not build the workaround speculatively |
| `ssr: false` produces a blank first paint | low | E6 measures it; `spaLoadingTemplate` if objectionable. `costs.vue` and `debug.vue` keep working — `useFetch` runs client-side in SPA mode — and both migrate anyway |
| Replacing the chat LRU's capacity-10 bound with a TTL changes eviction semantics | low | Stage 3 requires an explicit recorded decision, not a silent drop |
| `<KeepAlive :max="10">` eviction races a newly-activated component's subscribe | low | `scheduleNodeRemoval` re-checks `canBeRemoved` and the 400 ms TTL gives a grace window. If a refetch flash appears, cycle eleven panels over one shared atom and count recomputations |

---

## 10. Out of scope

- **Server-side `HttpApi`.** Replacing Nitro's routing for `/api/**` and the
  163-line h3 bridge in `server/utils/runtime.ts` is a separate project. The
  response schemas this migration writes become the `success:` fields of endpoint
  definitions verbatim if it ever happens, and the Api service's shape — one
  method per endpoint returning `Effect<Response, ApiError>` — is deliberately
  what `HttpApiClient.Client` produces.
- **SSR data transfer.** `Atom.serializable` + `Hydration.dehydrate`/`hydrate`
  exist and are framework-agnostic (`Hydration.ts:59-155`), but they need a
  schema and a stable key per hydrated atom, and the payoff is small for a
  localhost-only dashboard. Not adopted; a later decision.
- **`Atom.searchParam`.** URL-syncing the filters is a feature addition, not a
  migration step. Revisit as "shareable dashboard links".
- **`AtomRef`.** Redundant with Vue's `shallowRef`; adopting it means two
  reactivity systems in the same components for no gain.
- **`Atom.pull`.** See the end of §6.
- **`AtomHttpApi` / `AtomRpc`.** Banned by lint (§3.10).
- **Transcript parsing, the server, schemas under `shared/schemas/` that decode
  transcripts, the cassette system, and `electron/**`.** Untouched.
- **`app/composables/useExecutionCanvas.ts` and `RunCanvas.client.vue`'s
  lifecycle.** Component-tree-scoped context and view state; atoms cannot express
  them and buy nothing.

---

## 11. Corrections to widely-repeated claims

Collected here because each of these appeared in research, is plausible, and is
wrong. Each is cited so it can be re-checked rather than re-argued.

| Claim | Reality |
| --- | --- |
| "`Atom.withRefresh` is the drop-in for the polling loops" | It re-arms via raw `setTimeout` (`Atom.ts:1779`) and `TestClock` cannot reach it. But it *does* recover from a failure, which a `Stream` atom does not — see §3.6 |
| "Losing `withRefresh` costs nothing behaviourally" | It costs failure recovery. That is why §3.6 exists |
| "`Schema` has no `Omit`" | `Schema.Struct(…).mapFields(Struct.omit([...]))` (`SCHEMA.md:1073`). Field records are needed only for the recursive node, because `Schema.Codec` has no `mapFields` |
| "`initialValues` lets a component test skip the fetch" | The read runs first (`AtomRegistry.ts:619-634`) |
| "A superseded poll is an interrupt-only `Failure`" | No `Failure` is produced at all (`Atom.ts:594-599`) |
| "`matchWithWaiting` routes interrupts to `onError`" | To `onDefect` (`AsyncResult.ts:650-657`) |
| "`Atom.family(…).pipe(Atom.setIdleTTL(…))`" | `family` returns a plain function (`Atom.ts:1345-1379`) |
| "`Equal.equals` is a free perf win on polled payloads" | It deep-hashes both operands (`Equal.ts:245-247`); the fresh decode is uncached |
| "Deriving `shared/types` from `Schema` is zero import churn" | It breaks five server files that mutate `RunNode` |
| "`useAtomSet(…, { mode: 'promiseExit' })` handles `Reset`" | It hangs; `Reset` returns the atom to `Initial` |
| "Family keys must be primitive strings" | Structural `Equal`/`Hash` — object literals memoise correctly, with the two caveats in §3.4 |
