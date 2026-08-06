import * as Atom from 'effect/unstable/reactivity/Atom'
import type { RunNodeWire } from '#shared/schemas/api'
import { deepestLiveNode, flattenRunTree } from '~/utils/execution-analysis'
import { filtersAtoms, type FiltersAtoms } from './filters'
import { preferencesAtoms, type PreferencesAtoms } from './preferences'
import { treeAtoms, type TreeAtoms } from './tree'

/** Which agent, in which project. The two always change together. */
export interface Selection {
  readonly project: string
  readonly key: string
}

/** A node and the key of its parent, as the index records it. */
interface IndexedNode {
  readonly node: RunNodeWire
  readonly parent: string | null
}

const identify = (project: string, key: string): string => `${project}\0${key}`

/**
 * What the dashboard is looking at.
 *
 * Three inputs, not two, because `followActive` is not a tiebreak on an empty
 * selection — it deliberately *overrides* an explicit one. Under a plain
 * `explicit ?? auto` the toggle would do nothing the moment the user clicked
 * anything, which is the opposite of what it is for.
 *
 * The follow target is derived from the explicit-or-bootstrap selection rather
 * than from the resolved one. That is what keeps the composition acyclic: the
 * resolved selection reads the follow target, so the follow target must not read
 * the resolved selection.
 *
 * This module imports `filters` — the bootstrap picks the first non-empty
 * *visible* project, so an agent hidden by a filter is not what the dashboard
 * opens on. The edge is one-way; nothing in `filters` knows about a selection.
 */
export const makeSelectionAtoms = (
  tree: TreeAtoms = treeAtoms,
  filters: FiltersAtoms = filtersAtoms,
  preferences: PreferencesAtoms = preferencesAtoms,
) => {
  /**
   * Every node of every project, by `project\0key`, with its parent.
   *
   * Rebuilt per tree poll, which is the same work the page did in a `computed`.
   */
  const index = Atom.make((get): ReadonlyMap<string, IndexedNode> => {
    const map = new Map<string, IndexedNode>()
    const visit = (
      project: string,
      nodes: ReadonlyArray<RunNodeWire>,
      parent: string | null,
    ): void => {
      for (const node of nodes) {
        map.set(identify(project, node.key), { node, parent })
        visit(project, node.children, node.key)
      }
    }
    for (const project of get(tree.projects)) visit(project.id, project.roots, null)
    return map
  })

  /**
   * What the user chose. `keepAlive` — losing it to the idle sweep would drop
   * the dashboard back to whatever the bootstrap picks.
   */
  const explicit = Atom.make<Selection | null>(null).pipe(Atom.keepAlive)

  /** Deepest live node of the first non-empty visible project. */
  const bootstrap = Atom.make((get): Selection | null => {
    const project = get(filters.visibleProjects).find(entry => entry.roots.length)
    const root = project?.roots[0]
    return project && root ? { project: project.id, key: deepestLiveNode(root).key } : null
  })

  /** The explicit choice, or what the dashboard opened on. */
  const base = Atom.make((get): Selection | null => get(explicit) ?? get(bootstrap))

  const rootOf = (
    index: ReadonlyMap<string, IndexedNode>,
    selection: Selection | null,
  ): RunNodeWire | null => {
    if (!selection) return null
    let current = index.get(identify(selection.project, selection.key))
    while (current?.parent) current = index.get(identify(selection.project, current.parent))
    return current?.node ?? null
  }

  /** Newest live agent of the session the base selection belongs to. */
  const liveFollow = Atom.make((get): Selection | null => {
    const selection = get(base)
    const root = rootOf(get(index), selection)
    if (!selection || !root) return null
    const live = flattenRunTree(root)
      .filter(node => node.live)
      .sort((left, right) => right.mtime - left.mtime)[0]
    return live ? { project: selection.project, key: live.key } : null
  })

  /** The agent open in the inspector overlay, if any. */
  const inspected = Atom.make<string | null>(null).pipe(Atom.keepAlive)

  const selection: Atom.Writable<Selection | null, Selection | null> = Atom.writable(
    get => get(preferences.followActive) ? get(liveFollow) ?? get(base) : get(base),
    (ctx, value) => {
      ctx.set(explicit, value)
      // Selecting another agent closes the inspector: it is showing something
      // from the session being left. The page used to couple these by calling
      // `clearInspection()` from `select()`.
      ctx.set(inspected, null)
    },
  )

  return {
    index,
    explicit,
    bootstrap,
    liveFollow,
    selection,
    inspected,
    project: Atom.map(selection, value => value?.project ?? null),
    key: Atom.map(selection, value => value?.key ?? null),
    /** The selected node, when the current tree still contains it. */
    node: Atom.make((get): RunNodeWire | null => {
      const value = get(selection)
      return value ? get(index).get(identify(value.project, value.key))?.node ?? null : null
    }),
    /** The session root the selection belongs to. */
    root: Atom.make((get): RunNodeWire | null => rootOf(get(index), get(selection))),
  }
}

/** The selection atoms, as one bundle. */
export type SelectionAtoms = ReturnType<typeof makeSelectionAtoms>

/** The live instance every component reads. Tests call the factory instead. */
export const selectionAtoms: SelectionAtoms = makeSelectionAtoms()
