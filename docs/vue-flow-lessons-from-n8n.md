# Vue Flow, learned from n8n

Lessons from auditing how n8n builds its workflow editor on `@vue-flow/core`,
compared against our own `RunCanvas`. n8n runs the same library at the same
versions we do (core 1.48.x, background 1.3.2, controls 1.1.3, minimap 1.5.4),
with **zero patches** — every difference between their canvas and ours is
technique, not tooling. That makes it a perfect study object.

Audited source: `packages/frontend/editor-ui/src/features/workflows/canvas/`
in [n8n](https://github.com/n8n-io/n8n). Our side: `app/components/RunCanvas.client.vue`
and `app/utils/execution-graph.ts`.

---

## Part 1 — The mental model you need for Vue Flow

### Lesson 1: Vue Flow keeps its own copy of your graph

The single most important thing to internalize: when you pass `:nodes`, Vue
Flow does **not** render your array. It parses each plain node into an internal
`GraphNode` (adding `dimensions`, `handleBounds`, `computedPosition`,
`selected`, …) and keeps that in an id-scoped store. Your array is just input.

When you pass a *new* array, Vue Flow reconciles **by `id`**:

```
parseNode: Object.assign(existingGraphNode ?? initialState, yourPlainNode)
```

Two consequences that explain almost every Vue Flow bug you'll ever have:

1. **Keys you omit survive.** If your plain node has no `selected` field, the
   internal selection state is preserved across re-maps.
2. **Keys you include clobber.** If you always pass `position`, you overwrite
   whatever position the user dragged the node to, on every re-map.

n8n's mapped nodes deliberately contain no `selected`, no `dimensions`, no
hover flag — those live in Vue Flow's store, and n8n reads them via
`useVueFlow()` when needed. Our `RunCanvas` currently does the opposite: it
carries a `selected` boolean inside `data` and rebuilds every node object to
flip it. That forces Vue Flow to re-parse every node for a one-bit change.

> **Takeaway:** treat the plain-node array as *input you own* and the
> `GraphNode` store as *runtime state Vue Flow owns*. Never mirror runtime
> state back into your input objects.

### Lesson 2: One-way binding beats `v-model`

`v-model:nodes` installs a writeback watcher: every internal change (drag,
dimension measurement, fitView side effects, selection) reassigns *your* ref.
That means Vue Flow is writing into your state, which can re-trigger your own
watchers and creates two sources of truth that drift.

n8n binds strictly one-way everywhere:

```vue
<VueFlow :nodes="mappedNodes" :edges="mappedConnections" ... />
```

and handles the write path explicitly: during drag, Vue Flow moves the
internal node; only on `@node-drag-stop` does n8n commit the final position to
its own store, which flows back down through the mapping on the next compute.
This is the classic **controlled component** pattern, and it's also where undo
history gets recorded — one commit point instead of a stream of mutations.

Careful with folklore, though: n8n's `Canvas.vue` sets `:apply-changes="false"`,
but that prop **does not exist** in `@vue-flow/core` 1.48 (verified against the
`.d.ts` — the real prop is `applyDefault`). The one-way discipline comes from
the binding style, not from that attribute. Even good codebases cargo-cult;
verify props against the installed types.

### Lesson 3: Custom nodes via slots — and keep the slot body to one line

Vue Flow resolves custom node types by slot naming convention: a node with
`type: 'canvas-node'` renders through `#node-canvas-node`. n8n has exactly two
node types and one edge type — visual variety is handled *inside* the node
component, not by multiplying Vue Flow types.

The pattern worth copying is the shape of the slot:

```vue
<template #node-canvas-node="nodeProps">
  <slot name="node" v-bind="{ nodeProps }">
    <CanvasNode v-bind="nodeProps" :data="nodeDataById[nodeProps.id]" />
  </slot>
</template>
```

Three ideas packed in three lines:

- **The slot body is a one-line delegation to a real SFC.** Never inline a
  45-line template into the slot (which is what our `#node-agent` currently
  is). A real component gets its own tests, its own styles, and injection.
- **The slot forwards a slot.** Embedders can replace node rendering without
  forking the canvas component. n8n's diff view reuses the whole canvas this
  way.
- **`:data="nodeDataById[nodeProps.id]"` instead of `nodeProps.data`.** This is
  a documented workaround (their `#AI-716`): Vue Flow doesn't reliably
  propagate `data` updates into slot props for freshly added nodes. A computed
  `Record<id, data>` keyed off your source array sidesteps the stale-data bug
  entirely. Our nodes churn on every poll tick, so we are directly exposed.

### Lesson 4: `provide`/`inject` is how node components get context

A custom node rendered through a slot is deep inside Vue Flow's tree. Prop
drilling from your canvas component through Vue Flow to the node is painful,
so n8n provides context at two levels:

- `CanvasKey` — canvas-wide: viewport, `isExecuting`, `isPaneMoving`.
- `CanvasNodeKey` — per node (provided by the node wrapper): `id`, `data`,
  `selected`, `readOnly`, all as `toRef(props, …)`.

Leaf components then take **zero props** and call `useCanvasNode()`, which
exposes ~25 flat computeds with full defaults. That's what makes their status
icons, tooltips, and toolbars independently testable — the test just provides
a fake `{ [String(CanvasNodeKey)]: {...} }` map.

For us: `layoutDirection` currently drives `Handle :position` through the slot
scope, so flipping the layout rebinds every node subtree from the parent
template. Injected context fixes that.

---

## Part 2 — Reactivity: the difference between "works" and "smooth"

### Lesson 5: The cheapest render is the one whose inputs didn't change

n8n's perf strategy is not virtualization, not `markRaw`, not
`requestAnimationFrame` — the canvas feature contains **none** of those. It's
one idea applied ruthlessly: *make unchanged data referentially unchanged, so
Vue's reactivity stops propagation at the source.*

The workhorse is a 30-line primitive, `structuralComputed`. It survived the
atom migration with all three of its consumers: two compute over *props*, where
an atom's equality could not substitute, and the third guards the activity feed
— `Atom.withEquality` would have carried that one, but it exists in the vendored
Effect source and not in the published `4.0.0-beta.101` dist.

```ts
export function structuralComputed<T>(
  derive: () => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): ComputedRef<T> {
  let cached: T
  let primed = false
  return computed<T>(() => {
    const next = derive()
    if (primed && isEqual(cached, next)) return cached // same ref ⇒ no notify
    cached = next
    primed = true
    return cached
  })
}
```

Vue's `computed` notifies dependents based on `Object.is` of the returned
value. Returning the **previous reference** when the content is deep-equal
means downstream computeds never even re-run. A poll tick that changed nothing
becomes a literal no-op.

Our `RunCanvas` is the anti-pattern: `watch(() => props.run, refreshGraph,
{ deep: true })` walks the entire run object every tick and rebuilds all
nodes/edges regardless of whether anything the canvas renders actually
changed. The fix is mechanical:

```ts
const graph = structuralComputed(
  () => buildExecutionGraph(props.run?.lanes ?? [], direction.value, mode.value),
  isEqual, // lodash-style deep equal
)
```

Two things fall out for free: the deep watch disappears (a computed tracks
only what `buildExecutionGraph` reads), and unchanged polls produce zero DOM
work.

> **Rule of thumb from n8n:** rebuilding the array is cheap — Vue Flow diffs
> by id. *Recomputing* the array when nothing changed is the waste. Gate the
> computation, not the render.

### Lesson 6: Throttle the live stream, not the editor

While a workflow executes, n8n's run data churns far faster than a human can
read. Their answer is surgical:

```ts
const mappedNodesThrottled = throttledRef(mappedNodes, 200)
```

```vue
<Canvas :nodes="executing ? mappedNodesThrottled : mappedNodes" ... />
```

Editing stays instant; only the push-driven execution stream is capped at
5 fps. That's the entire throttling story in their canvas — plus one throttled
`mousemove` hit-test. No debounce forests, no rAF loops. For our live-session
polling this maps one-to-one: throttled ref while `run.live`, raw otherwise.

### Lesson 7: For big graphs, per-entity computeds (know it exists, don't copy it)

For thousands of nodes, one big `computed` over the whole workflow re-runs on
any change. n8n splits projections into
`shallowReactive(Map<nodeId, ComputedRef<T>>)` where each node's entries live
in their **own `effectScope`**, created/destroyed on node add/remove events.
Reading `map.get(id)?.value` tracks the map (add/remove) and the entry
(that node's value) independently — so one node's change invalidates one entry.

This is genuinely elegant and genuinely expensive: it needs lifecycle
management, teardown discipline (leaked scopes keep the whole graph alive),
and two long comments in their code explaining the contract. At our <30 nodes,
a single structurally-gated computed is strictly better. File this lesson
under "know what the next order of magnitude looks like."

### Lesson 8: Route pure-visual changes through CSS custom properties

When zoom changes, n8n doesn't re-render edges — a composable computes
zoom-adjusted lightness/opacity and writes them as CSS vars on a stable
element:

```vue
<g :style="{ '--canvas-edge--color--lightness--light': lightness }">
```

The component tree never re-mounts; the browser repaints. Same trick for the
selection box geometry and for a global `--canvas-zoom-compensation-factor`
that keeps labels/toolbars a constant on-screen size across zoom. Whenever a
per-tick change is *purely visual* (color, progress, opacity), a CSS var on a
stable element beats a new node object every time.

---

## Part 3 — Styling Vue Flow without fighting it

### Lesson 9: Import the default theme, override in one tokenized file

n8n does exactly what we do — `style.css` + `theme-default.css` — then confines
every `.vue-flow__*` override to a single 161-line file, sectioned by
subsystem (Nodes / Handles / Edges / Minimap / Controls / Pane) and written
entirely in design tokens. Only 5 files in their whole editor mention
`vue-flow__` classes. The discipline, not the approach, is the lesson: our
overrides are already in `main.css`, they just want organizing and
tokenizing.

A neat modern trick from their global sheet — z-index hoisting via `:has()`,
no reactive class plumbing:

```scss
.vue-flow__nodes:has(.bring-to-front) { z-index: 2 !important; }
.vue-flow__node:has(.canvas-handle-plus):hover { z-index: 2 !important; }
```

### Lesson 10: States flip variables; one declaration consumes them

n8n's node states don't each write their own border rules. There is **one**
border declaration:

```scss
border: var(--canvas-node--border-width) solid
        var(--canvas-node--border-color, light-dark(...));
```

and each state class only reassigns the variables:

```scss
/**
 * State classes
 * The reverse order defines the priority in case multiple states are active
 */
&.selected { @include canvas-node-selected-ring; }  // box-shadow ring — no layout shift
&.success  { --canvas-node--border-width: 2px; --canvas-node--border-color: var(--color--success); }
&.error    { --canvas-node--border-color: var(--color--danger); }
&.running  { @include status-running-border; }
&.waiting  { @include status-waiting-border; }
```

Source order *is* the priority system, and there's a comment saying so. A node
that is both `success` and `waiting` shows waiting — resolved by the cascade,
not by an `if` chain in JS. Note also that **selection is a `box-shadow`
ring**, never a border change, so selecting a node never shifts layout by a
pixel.

The default fallback lives in `var(--x, fallback)`, not on the element —
their comment explains why: defining it on the element would mask a value set
by an ancestor, and that ancestor-override hook is exactly how their diff view
re-skins every node without touching node components.

### Lesson 11: The animated "running" border — pure CSS, zero JS

The best visual in n8n's canvas is a rotating conic-gradient glow behind
running nodes, and it costs no JavaScript per frame:

```scss
@property --node--gradient-angle { syntax: '<angle>'; initial-value: 0deg; inherits: false; }

@keyframes border-rotate {
  from { --node--gradient-angle: 0deg; }
  to   { --node--gradient-angle: 360deg; }
}

.node::after {
  content: ''; position: absolute; inset: -3px; z-index: -1; border-radius: 10px;
  background: conic-gradient(from var(--node--gradient-angle),
    rgb(255 109 90) 0 20%, rgb(255 109 90 / .2) 35% 65%, rgb(255 109 90) 90%);
}
.running::after { animation: border-rotate 1.5s linear infinite; }
.waiting::after { animation: border-rotate 4.5s linear infinite; }
```

Three lessons in one:

- `@property` registers the custom property as an `<angle>` so it's
  **interpolatable** — without it, the keyframe would snap instead of spin.
- `z-index: -1` + `inset: -3px` makes it read as a *glow*, not a ring.
- **Animation speed encodes semantics**: same visual at 1.5s means "running",
  at 4.5s means "waiting". A second information axis for free — perfect for
  our `active` vs `blocked` distinction.

Caveat they documented: `@keyframes` names are scoped per CSS module, so the
definitions mixin must be included once per module that uses it. And add what
n8n forgot: a `prefers-reduced-motion` fallback to a static tinted border.

---

## Part 4 — Viewport craft (where "feels stable" lives)

### Lesson 12: `fitView` has sharp edges

Three failure modes, all handled in n8n, all relevant to us:

1. **Single-node zoom blowout.** Fitting one node without a cap zooms to
   absurd levels. Always pass `maxZoom`:
   ```ts
   await fitView({ maxZoom: 1, padding: 0.2 })
   ```
2. **The hidden-tab bug.** With `document.hidden`, the container measures
   0×0 and Vue Flow silently falls back to 500×500 — producing a garbage
   transform. n8n guards every fit:
   ```ts
   if (document.hidden) { fitViewWhileHidden = true; return }
   ```
   and re-runs on `visibilitychange`. A monitoring dashboard living in a
   background tab **will** hit this.
3. **Fitting before nodes are measured.** Handles/dimensions don't exist until
   nodes initialize. n8n fits inside `onNodesInitialized` with a
   run-exactly-once latch (their workaround for vue-flow#1636) — the robust
   version of our `pendingFit` ref.

### Lesson 13: Minimal-delta pan, not re-fit

The single biggest "feel" difference between a calm canvas and a jumpy one.
When something is selected from outside the canvas (a log row, a list), n8n
does **not** re-fit. It computes the smallest viewport shift that brings the
target into view *at unchanged zoom*:

- already visible → move nothing;
- partially out → shift by the minimal dx/dy;
- can't fit either way → deliberately give up rather than jar the user.

(`updateViewportToContainNodes`, ~40 self-contained lines, then
`setViewport(vp, { duration: 200 })`.) A stronger variant for "must be
visible": `fitBounds` on the **union** of the current viewport and the target
rect — context is kept, never yanked away.

Our `refit()` re-fits on every selection and session change. Re-fitting on
every graph change is the #1 thing that makes live canvases feel unstable.

Related habits worth copying:

- **Resize keeps the center**: a `ResizeObserver` on the pane shifts the
  viewport by half the size delta when a side panel opens, so the visual
  center holds.
- **View toggles are reversible**: entering their zoom mode stashes
  `previousViewport`; leaving restores it exactly (fitView only as fallback).
  Our overview⇄all-agents and LR⇄TB toggles should do the same.
- **Hide the initial jump**: the canvas is `opacity: 0` until `paneReady`
  (post-fit), then fades in over 300ms. First paint is already positioned.

### Lesson 14: The minimap can be event-driven

Instead of our "show if >3 nodes" rule, n8n shows the minimap **while the pane
is moving**, keeps it while hovered, and fades it out 1s after motion stops —
it exists exactly when you're lost. Plus `:node-class-name` to color minimap
nodes by kind/state, which we already half-do with `:node-color`.

---

## Part 5 — Interaction & UX patterns

### Lesson 15: Keyboard navigation should follow the graph, not the screen

n8n's arrow-key nav is *topological*, built on two Vue Flow utilities we get
for free — `getIncomers` / `getOutgoers`:

| Key | Meaning |
| --- | --- |
| `←` / `→` | walk to predecessor / successor |
| `↑` / `↓` | cycle siblings (wrapping: `siblings[i+1] ?? siblings[0]`) |
| `Shift+→` | select the entire downstream subgraph |
| `1` / `0` / `+` / `-` | fit view / reset zoom / zoom |

For a spawn tree this maps perfectly: `←/→` walk the spawn chain, `↑/↓` cycle
sibling subagents, `Shift+→` selects a subtree. The whole traversal composable
is 68 lines.

Implementation details that make it production-grade:

- Handlers are `{ disabled: () => boolean, run: fn }` — enablement lives with
  the binding, so menus and shortcuts can't diverge.
- A global guard skips shortcuts when focus is in
  `INPUT`/`TEXTAREA`/`[contenteditable]`/`[role="dialog"]`.
- They maintain a **separate read-only keymap** and spread it into the full
  editor keymap — the read-only one is exactly our use case.
- Context-menu items carry a `shortcut` descriptor rendered inline, so the
  menu doubles as the shortcut cheat-sheet. No separate help modal to rot.

### Lesson 16: Put the metric on the edge

n8n's "5 items" label lives on the **connection**, not the node. The rules
encoded in their label builder are worth stealing wholesale:

- no data yet → empty string, never `"0 items"` — silent edges until they
  carry something;
- pluralized via i18n, with a "total" variant for multi-iteration runs;
- edge status has a declared priority: `running > pinned > error > success`.

For us: spawn edges labeled `"12 tools"` / `"3 files"`, nodes reduced to
identity + state. Bonus gap to exploit: n8n *computes* a `running` status for
edges and then never renders it visually — our animated active edges are
already ahead; adding "in flight, nothing yet" vs "carried N results" would
beat them.

Edge ergonomics worth noting: `:interaction-width="40"` puts a fat invisible
hit area on a 2px line; hover-off is delayed 600ms so the pointer can travel
from edge to toolbar; backwards edges (target left of source) are routed as
two smoothstep segments *below* the source so an edge never overlaps its own
node.

### Lesson 17: Hover UI stays mounted, revealed by opacity

Node toolbars are always in the DOM, positioned above the node, and revealed
by `opacity` on `:hover`, **`:focus-within`** (keyboard users get them too),
and while that node's own context menu is open (so the toolbar doesn't vanish
under its own menu). `pointer-events: none` on the invisible wrapper keeps it
from eating canvas clicks. `v-if`-based hover UI causes layout thrash and is
unreachable by keyboard — this pattern fixes both.

### Lesson 18: Ambient signals beat chrome

Three small n8n moves that communicate without adding UI:

- **Read-only = striped background.** The dot grid swaps for faint diagonal
  stripes. The whole canvas says "view, not editor" with zero chrome.
- **Floating status pill** centered over the canvas ("AI is thinking…",
  "X is editing — Take over") — the right shape for our "session live /
  disconnected / replaying" states.
- **Spotlight dimming**: edges to `opacity: .2`, nodes to `.4`,
  `:has(.highlighted)` restores to 1 — "focus this path" in four CSS lines.

### Lesson 19: Where a read-only canvas can beat n8n — accessibility

n8n sets `:disable-keyboard-a11y="true"` and their nodes are not focusable at
all — no `role`, no `tabindex`, no focus ring. Editing complexity pushed them
to opt out. Our nodes already have `role="button"`, `tabindex`, and rich
`aria-label`s. To go further than they did:

- `:focus-visible` rings and `aria-selected`/`aria-current` on nodes;
- an `aria-live="polite"` region announcing state transitions ("Explore agent
  completed") — for a live monitor, arguably the primary accessible interface;
- `prefers-reduced-motion` gates on every animation (n8n has zero in the
  canvas despite having the mixins).

---

## Part 6 — Testing patterns

- **Fixture factories** (`createCanvasNodeData`, `createCanvasGraphNode`)
  centralize the 20-key mock literals so tests stay one-liners.
- **Provide-maps for injection**: `createCanvasNodeProvide()` returns
  `{ [String(CanvasNodeKey)]: {...} }` to drop into a renderer's
  `global.provide` — this is what makes zero-prop leaf components testable in
  isolation.
- **Layout tests assert invariants, not pixels**: grid alignment
  (`matchesGrid`), no overlaps — plus one snapshot for regressions. Positions
  drift; invariants don't.
- Canvas component tests render the *real* `<VueFlow>` in jsdom and import
  `useVueFlow` inside the test to drive and assert store state.

---

## Cheat sheet — applying this to `RunCanvas`

| # | Change | Lesson | Effort |
| --- | --- | --- | --- |
| 1 | Deep watch → `structuralComputed`-gated computed | 5 | S |
| 2 | Remove `selected` from node data; inject or use VF selection | 1, 4 | S |
| 3 | `v-model:nodes` → one-way `:nodes`, positions via `@node-drag-stop` | 2 | S |
| 4 | `throttledRef(nodes, 200)` while `run.live` | 6 | S |
| 5 | Extract `AgentNode.vue` + mapping composable; `nodeDataById` workaround | 3 | M |
| 6 | `document.hidden` guard + `visibilitychange` refit | 12 | S |
| 7 | Minimal-delta pan on selection instead of `refit()` | 13 | M |
| 8 | Conic-gradient running border (+ reduced-motion fallback) | 11 | S |
| 9 | Tool/file counts as edge labels, `""` never `"0"` | 16 | M |
| 10 | Arrow-key graph traversal via `getIncomers`/`getOutgoers` | 15 | M |
| 11 | CSS state-variable model with ordered priority | 10 | M |
| 12 | Fade in canvas after pane-ready; reversible view toggles | 12, 13 | S |
| 13 | `aria-live` announcer + focus-visible rings | 19 | S |

And the things n8n has that we should consciously **skip** at our scale:
per-node `effectScope` registries (Lesson 7), the groups/collapse subsystem,
virtualization (n8n doesn't use it either), `markRaw`/rAF, and a canvas store
(theirs holds one constants file).
