export interface AgentFileChange {
  path: string
  ops: number
  added: number
  removed: number
}

/**
 * Folds an agent's touched files and the diagnostics' structured patch
 * changes into one per-file summary, sorted by most operations first and
 * path as tiebreaker.
 */
export function mergeAgentFileChanges(
  files: readonly { path: string, ops: number }[],
  changes: readonly { path: string, linesAdded: number, linesRemoved: number }[],
): AgentFileChange[] {
  const merged = new Map<string, AgentFileChange>()
  for (const file of files) {
    merged.set(file.path, { path: file.path, ops: file.ops, added: 0, removed: 0 })
  }
  for (const change of changes) {
    const file = merged.get(change.path) || { path: change.path, ops: 0, added: 0, removed: 0 }
    file.ops += 1
    file.added += change.linesAdded
    file.removed += change.linesRemoved
    merged.set(change.path, file)
  }
  return [...merged.values()].sort((a, b) => b.ops - a.ops || a.path.localeCompare(b.path))
}

export interface SplitPath {
  /** File name, the last path segment. */
  name: string
  /** Containing directory, or `'Repository root'` for top-level files. */
  directory: string
}

/** Splits a repository path into its file name and directory label. */
export function splitPath(path: string): SplitPath {
  const separator = path.lastIndexOf('/')
  return {
    name: separator < 0 ? path : path.slice(separator + 1),
    directory: separator < 0 ? 'Repository root' : path.slice(0, separator),
  }
}
