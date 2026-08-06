import * as Atom from 'effect/unstable/reactivity/Atom'

/** How much of each transcript event the feed renders. */
export type FeedDensity = 'compact' | 'normal' | 'raw'

/**
 * The four display preferences that belong to the dashboard rather than to any
 * one panel.
 *
 * They are global because two toolbars drive the same setting: the activity
 * workspace's density segments and errors toggle, and the inspector's own copies
 * of both. Passing them down meant three props on `RunInspector`, two
 * `update:` emits, and two handlers in `index.vue` to put the value back where
 * it came from. An atom is the same state with one owner.
 *
 * This is the whole list. Anything that differs between two mount sites of the
 * same component stays a prop — `EventFeed` still takes all four as props, which
 * is what keeps its spec, and every other prop-only component spec, free of a
 * registry.
 *
 * `keepAlive` on each: nothing subscribes to a preference except the panel
 * currently showing its control, so under the registry's 400 ms idle sweep
 * switching from Activity to Overview and back would silently restore the
 * default. A preference the user set is state, not a cache.
 */
export const makePreferencesAtoms = () => ({
  /** Rendering density of the event feed. */
  density: Atom.make<FeedDensity>('normal').pipe(Atom.keepAlive),
  /** Show only error events in the feed. */
  errorsOnly: Atom.make(false).pipe(Atom.keepAlive),
  /** Keep the event feed scrolled to the newest output. */
  followOutput: Atom.make(true).pipe(Atom.keepAlive),
  /** Automatically follow the most recently active live agent. */
  followActive: Atom.make(false).pipe(Atom.keepAlive),
})

/** The live instance every component reads. Tests call the factory instead. */
export const preferencesAtoms = makePreferencesAtoms()
