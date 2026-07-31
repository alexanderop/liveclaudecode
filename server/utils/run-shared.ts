import { Option, Order } from 'effect'
import type { RunNode } from '#shared/types/run'

/**
 * Plain, effect-free helpers shared by the Claude, Codex, and Copilot run
 * builders and the unified session catalog. These operate on the assembled
 * `RunNode` tree and discovery bookkeeping; `transcript-scan-core.ts` covers
 * the lower-level raw-record helpers instead.
 */

/** Preorder traversal of a run tree, visiting every node with its depth. */
export function visitNodes(
  root: RunNode,
  use: (node: RunNode, depth: number) => void,
  depth = 0,
): void {
  use(root, depth)
  for (const child of root.children) visitNodes(child, use, depth + 1)
}

/** Orders items ascending by an optional ISO timestamp; a missing timestamp sorts first. */
export const byTimestamp: Order.Order<{ ts: string | null }> = Order.mapInput(
  Order.String,
  item => item.ts ?? '',
)

/** Orders run roots descending by `subLast`; a missing timestamp sorts last. */
export const bySubLastDesc: Order.Order<{ subLast: string | null }> = Order.flip(
  Order.mapInput(Order.String, item => item.subLast ?? ''),
)

/** The oldest mtime, in epoch milliseconds, still considered "fresh" as of `now`. */
export function freshnessCutoff(maxAgeHours: number, now: number): number {
  return maxAgeHours <= 0 ? Number.NEGATIVE_INFINITY : now - maxAgeHours * 3_600_000
}

/** A file with no mtime is treated as fresh; otherwise it must be at or after `cutoff`. */
export function isFreshMtime(mtime: Option.Option<Date>, cutoff: number): boolean {
  return Option.match(mtime, {
    onNone: () => true,
    onSome: value => value.getTime() >= cutoff,
  })
}

/**
 * Keep the newest item per id, counting every later duplicate. Items whose id
 * is empty are skipped entirely (they never entered `selected` in the
 * original per-builder loops either).
 */
export function selectLatestById<T>(
  items: Iterable<T>,
  idOf: (item: T) => string,
  mtimeOf: (item: T) => number,
): { selected: Map<string, T>, duplicates: number } {
  const selected = new Map<string, T>()
  let duplicates = 0
  for (const item of items) {
    const id = idOf(item)
    if (!id) continue
    const existing = selected.get(id)
    if (existing) {
      duplicates += 1
      if (mtimeOf(item) > mtimeOf(existing)) selected.set(id, item)
    } else {
      selected.set(id, item)
    }
  }
  return { selected, duplicates }
}

/**
 * Add every field of `source` into the matching field of `target`, in place.
 *
 * `T` is constrained to `object` rather than `Record<string, number>`: the
 * callers pass interfaces like `Usage` and `CausalSummary`, which (having no
 * index signature of their own) are not assignable to a `Record` parameter
 * type even though every one of their fields is a number.
 */
export function addFields<T extends object>(target: T, source: T): void {
  const targetFields = target as Record<string, number>
  const sourceFields = source as Record<string, number>
  for (const key of Object.keys(targetFields)) {
    targetFields[key] = targetFields[key]! + (sourceFields[key] ?? 0)
  }
}
