import type { DiffLine } from './line-diff'
import { languageForPath } from './code-language'
import { diffLines } from './line-diff'

export interface ToolCodePreview {
  /** Shiki language id with a loaded grammar. */
  language: string
  /** Newline-joined code to highlight. */
  code: string
  /** 1-based line numbers the tool call adds. Empty unless {@link diff}. */
  added: number[]
  /** 1-based line numbers the tool call removes. Empty unless {@link diff}. */
  removed: number[]
  /**
   * True when the payload was reconstructed into an edit view. False means the
   * raw JSON is shown, either because the tool does not edit files or because
   * its payload could not be read.
   */
  diff: boolean
  /** Edited file, when the payload names one. */
  path?: string
}

/** Payload keys carrying the pre-edit text, in the order they are tried. */
const BEFORE_KEYS = ['old_string', 'old_str', 'oldString']
/** Payload keys carrying the post-edit text, in the order they are tried. */
const AFTER_KEYS = ['new_string', 'new_str', 'newString']
/** Payload keys carrying whole-file content for create/overwrite tools. */
const CONTENT_KEYS = ['content', 'file_text', 'contents']
/** Payload keys naming the edited file. */
const PATH_KEYS = ['file_path', 'notebook_path', 'path']

function readString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Tool payloads arrive as pretty-printed JSON clipped to a fixed budget, so a
 * large edit can be cut mid-string. A parse failure is expected rather than
 * exceptional and falls back to showing the raw text.
 */
function parsePayload(input: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(input)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function rawPreview(input: string): ToolCodePreview {
  return { language: 'json', code: input, added: [], removed: [], diff: false }
}

function fromDiffLines(lines: readonly DiffLine[], language: string, path?: string): ToolCodePreview {
  const added: number[] = []
  const removed: number[] = []
  lines.forEach((line, index) => {
    if (line.kind === 'add') added.push(index + 1)
    else if (line.kind === 'remove') removed.push(index + 1)
  })
  return {
    language,
    code: lines.map(line => line.text).join('\n'),
    added,
    removed,
    diff: true,
    ...(path ? { path } : {}),
  }
}

/**
 * Turns a `tool_use` payload into something worth syntax highlighting.
 *
 * Edit-shaped tools become a reconstructed unified diff in the edited file's
 * language; whole-file writes become the file's own content; everything else
 * stays as the JSON payload.
 */
export function toolCodePreview(tool: string | undefined, input: string): ToolCodePreview {
  const text = input || ''
  if (!text.trim()) return rawPreview(text)

  const payload = parsePayload(text)
  if (!payload) return rawPreview(text)

  const path = readString(payload, PATH_KEYS)
  const language = languageForPath(path)

  const edits = payload.edits
  if (Array.isArray(edits) && edits.length) {
    // MultiEdit applies its edits in order against one file; concatenating the
    // per-edit diffs keeps that reading order without faking line numbers.
    const lines: DiffLine[] = []
    for (const edit of edits) {
      if (!isRecord(edit)) continue
      const before = readString(edit, BEFORE_KEYS)
      const after = readString(edit, AFTER_KEYS)
      if (before === undefined && after === undefined) continue
      if (lines.length) lines.push({ text: '', kind: 'context' })
      lines.push(...diffLines(before || '', after || ''))
    }
    if (lines.length) return fromDiffLines(lines, language, path)
  }

  const before = readString(payload, BEFORE_KEYS)
  const after = readString(payload, AFTER_KEYS)
  if (before !== undefined || after !== undefined) {
    const lines = diffLines(before || '', after || '')
    if (lines.length) return fromDiffLines(lines, language, path)
  }

  const content = readString(payload, CONTENT_KEYS)
  if (content !== undefined && path) {
    const lines = content.split('\n')
    return {
      language,
      code: content,
      added: lines.map((_, index) => index + 1),
      removed: [],
      diff: true,
      path,
    }
  }

  return rawPreview(text)
}
