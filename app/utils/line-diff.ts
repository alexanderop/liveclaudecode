/** How a line changed between the two sides of a diff. */
export type DiffLineKind = 'add' | 'context' | 'remove'

export interface DiffLine {
  /** Line content, without a trailing newline. */
  text: string
  kind: DiffLineKind
}

export interface DiffLinesOptions {
  /**
   * Largest number of lines per side that still gets a real longest-common-
   * subsequence pass. Beyond this the diff degrades to "everything removed,
   * everything added" rather than running an O(n·m) table.
   *
   * @default 600
   */
  maxLines?: number
}

function splitLines(value: string): string[] {
  if (!value) return []
  const lines = value.split('\n')
  // A trailing newline terminates the last line rather than starting a new one.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function wholesale(before: string[], after: string[]): DiffLine[] {
  return [
    ...before.map((text): DiffLine => ({ text, kind: 'remove' })),
    ...after.map((text): DiffLine => ({ text, kind: 'add' })),
  ]
}

/**
 * Line-level diff of two strings, as a flat sequence of removed, added, and
 * unchanged lines in display order.
 *
 * Removed lines are emitted before added lines at each divergence so the result
 * reads like a unified diff.
 */
export function diffLines(before: string, after: string, options: DiffLinesOptions = {}): DiffLine[] {
  const { maxLines = 600 } = options

  const left = splitLines(before)
  const right = splitLines(after)

  if (!left.length && !right.length) return []
  if (!left.length || !right.length) return wholesale(left, right)
  if (left.length > maxLines || right.length > maxLines) return wholesale(left, right)

  // Classic LCS table; `lengths[i][j]` is the LCS length of left[i..] / right[j..].
  const lengths: number[][] = Array.from(
    { length: left.length + 1 },
    () => new Array<number>(right.length + 1).fill(0),
  )
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      lengths[i]![j] = left[i] === right[j]
        ? lengths[i + 1]![j + 1]! + 1
        : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!)
    }
  }

  const result: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      result.push({ text: left[i]!, kind: 'context' })
      i++
      j++
      continue
    }
    if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      result.push({ text: left[i]!, kind: 'remove' })
      i++
      continue
    }
    result.push({ text: right[j]!, kind: 'add' })
    j++
  }
  for (; i < left.length; i++) result.push({ text: left[i]!, kind: 'remove' })
  for (; j < right.length; j++) result.push({ text: right[j]!, kind: 'add' })

  return result
}
