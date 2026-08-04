import { Predicate } from 'effect'

export const MAX_CHARS = 8_000

const TOOL_SUMMARY_KEYS = [
  'command',
  'file_path',
  'pattern',
  'path',
  'description',
  'prompt',
  'query',
  'url',
  'skill',
  'notebook_path',
  'old_string',
]

const PHASE_PATTERNS = [
  /^\s{0,3}(?:[-*]\s*)?(?:#{1,4}\s*)?(?:\*\*)?\s*((?:Wave|Phase|Slice|Step|Round|Stage)\s+[\w\d.]+[^\n*]{0,70})/gim,
  /^\s{0,3}\*\*([^\n*]{4,70})\*\*:?\s*$/gm,
  /^\s{0,3}#{1,4}\s+([^\n]{4,70})$/gm,
]

const FAIL_RE = /\b([1-9]\d* failed|FAIL\b(?!\s+0\b)|failing|error TS\d+|Error:|✗|✘|command not found|exit code [1-9]|Test Files\s+[1-9]\d* failed)/i
const PASS_RE = /\b(passed|✓|PASS\b|0 problems|no issues|success)/i

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * `JSON.stringify` for display purposes. Transcript payloads occasionally
 * contain values `JSON.stringify` throws on — a circular structure
 * (`TypeError`), a `BigInt` (`TypeError`), or a throwing `toJSON` — and a
 * preview string is never worth failing a scan over, so those degrade to
 * `fallback`. Every serialization try/catch in the scanners routes through
 * here.
 */
export function safeStringify(value: unknown, fallback = '', space?: string | number): string {
  try {
    return JSON.stringify(value, null, space) ?? fallback
  } catch {
    return fallback
  }
}

export function plainText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .flatMap((block) => {
      if (typeof block === 'string') return [block]
      if (Predicate.isObject(block) && block.type === 'text') return [asString(block.text)]
      return []
    })
    .join('\n')
}

export function toolSummary(input: unknown): string {
  if (!Predicate.isObject(input)) return ''

  for (const key of TOOL_SUMMARY_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim().replace(/\s+/g, ' ')
    }
  }

  return safeStringify(input).slice(0, 200)
}

export function resultText(result: unknown): string {
  if (typeof result === 'string') return result
  if (Array.isArray(result)) {
    return result
      .flatMap((block) => {
        if (typeof block === 'string') return [block]
        if (!Predicate.isObject(block)) return []
        if (block.type === 'text') return [asString(block.text)]
        if (block.type === 'image') return ['[image]']
        return []
      })
      .join('\n')
  }
  if (Predicate.isObject(result)) {
    return safeStringify(result, String(result), 2)
  }
  return ''
}

export function clip(value: string): [body: string, originalLength: number] {
  const text = value || ''
  return [text.slice(0, MAX_CHARS), text.length]
}

export function findMilestones(text: string): Array<[title: string, strong: boolean]> {
  for (const [index, pattern] of PHASE_PATTERNS.entries()) {
    pattern.lastIndex = 0
    const matches = Array.from(text.matchAll(pattern))
      .map(match => ({
        index: match.index,
        title: (match[1] || '').replace(/\s+/g, ' ').replace(/^[ *:#-]+|[ *:#-]+$/g, ''),
      }))
      .sort((a, b) => a.index - b.index)

    if (matches.length) return matches.map(match => [match.title, index === 0])
  }
  return []
}

export function commandOk(output: string, isError: boolean): boolean {
  if (isError) return false
  const head = (output || '').slice(0, 2_500)
  return !(FAIL_RE.test(head) && !PASS_RE.test(head.slice(0, 200)))
}

/** What a Bash tool result reports about how its command ended. */
export interface CommandOutcome {
  ok: boolean
  /** An explicit explanation from the transcript; '' when it gave none. */
  note: string
}

/** The subset of `toolUseResult` a Bash record carries about its command. */
export interface CommandResultFields {
  stdout?: string
  stderr?: string
  interrupted?: boolean
  returnCodeInterpretation?: string
}

/**
 * Decide a command's outcome, preferring what the record states over what its
 * output looks like.
 *
 * `returnCodeInterpretation` deserves care: it is present only when the
 * command exited non-zero *and* Claude Code has a benign explanation for it —
 * every observed value is "No matches found", "Files differ", or "Some
 * directories were inaccessible", always alongside `is_error: false`. Treating
 * its presence as a failure would flag every fruitless grep, so it becomes a
 * note and leaves `ok` alone.
 *
 * That leaves `commandOk`'s heuristic as the only signal for a genuine
 * failure, since `is_error` is not set on Bash results. It at least runs
 * against the real streams here instead of the re-rendered result text.
 */
export function commandOutcome(
  result: CommandResultFields | null,
  text: string,
  isError: boolean,
): CommandOutcome {
  if (result?.interrupted === true) return { ok: false, note: 'Interrupted' }
  if (isError) return { ok: false, note: '' }
  if (result?.returnCodeInterpretation) {
    return { ok: true, note: result.returnCodeInterpretation }
  }
  const streams = [result?.stdout, result?.stderr].filter(Boolean).join('\n')
  return { ok: commandOk(streams || text, false), note: '' }
}

export function shortPath(path: string, root = ''): string {
  if (!path) return ''
  const prefix = `${root.replace(/\/$/, '')}/`
  if (root && path.startsWith(prefix)) return path.slice(prefix.length)
  const parts = path.split('/')
  return parts.length > 3 ? parts.slice(-3).join('/') : path
}
