/**
 * Redaction — steps 3 to 6 of the recorder pipeline.
 *
 * Two passes over the selected files. The first *learns*: it walks every
 * record and allocates a pseudonym for every identity-bearing value it finds,
 * in order of first appearance. The second *applies*: it rewrites strings,
 * clips oversized ones, drops opaque payloads, and shifts every timestamp by
 * one constant offset.
 *
 * The passes are separate because the identity table has to be global before
 * any substitution happens (spec §8.4). A table built lazily during rewriting
 * would give the same real path two pseudonyms depending on which file reached
 * it first, producing a cassette that parses cleanly and whose file-change
 * aggregation is quietly wrong.
 */
import { basename } from 'node:path'
import {
  type CassetteSource,
  classifyKey,
  isEnvironmentInventory,
} from '../../test/cassettes/redaction/rules.ts'
import { type IdentityTable, looksLikeSessionId } from './identity.ts'
import { projectSlug } from './sources.ts'
import type { SelectedFile } from './select.ts'

/** Keys whose string value names a directory the capture machine owns. */
const DIRECTORY_KEYS = new Set([
  'cwd', 'workingDirectory', 'working_directory', 'folder', 'workspace', 'projectRoot',
])

/**
 * The filesystem path a directory-shaped value denotes, or `''`.
 *
 * VS Code writes `folder` as a `file://` URI, not a path. Requiring a leading
 * slash — the obvious guard — silently skipped every VS Code capture
 * directory, so the workspace path and its whole ancestry survived redaction
 * into a chat log that keys maps *by URI*. Decode first, then decide.
 */
function directoryPathOf(value: string): string {
  if (value.startsWith('/')) return value
  if (!value.startsWith('file://')) return ''
  try {
    return decodeURIComponent(new URL(value).pathname)
  } catch {
    return ''
  }
}

/** Keys whose string value is the session's own identifier. */
const SESSION_KEYS = new Set(['sessionId', 'session_id'])

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const HOME_SEGMENT = /(?:\/Users\/|\/home\/)([A-Za-z0-9._-]+)/g

/**
 * A file inside the operator's own agent configuration: a dot-directory
 * directly below the home directory, and at least one path segment under it.
 *
 * These are not session content. They arrive because the tool attaches them —
 * VS Code lists every applicable instruction file on each chat request — and
 * they name what the operator has installed, which is exactly the inventory a
 * cassette must not publish. The home directory itself is left alone; only
 * paths that go *into* a dot-directory match.
 */
const HOME_CONFIG_FILE = /(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+\/\.[A-Za-z0-9._-]+\/[^\s"'`,;:)\]}]+/g
const LOCAL_HOSTNAME = /\b([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.local)\b/g
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

/** Epoch milliseconds, wide enough to cover any plausible capture. */
const EPOCH_MS_FLOOR = 1_000_000_000_000
const EPOCH_MS_CEILING = 4_000_000_000_000

export interface RedactionStats {
  clippedValues: number
  droppedValues: number
  keptRecords: number
  droppedRecords: number
  /** Keys no table named, with how often each occurred. */
  readonly unclassified: Map<string, number>
  /** The longest free-text values, for the operator's review summary. */
  readonly longestTexts: Array<{ label: string, length: number, preview: string }>
}

export interface RedactedFile extends SelectedFile {
  /** Lines kept, for the manifest's `entries[].records`. */
  readonly records: number
}

export interface RedactionResult {
  readonly files: readonly RedactedFile[]
  readonly stats: RedactionStats
  /** The capture machine's directories, keyed by their pseudonyms. */
  readonly directories: ReadonlyMap<string, string>
}

const LONGEST_TEXT_SAMPLES = 10

function emptyStats(): RedactionStats {
  return {
    clippedValues: 0,
    droppedValues: 0,
    keptRecords: 0,
    droppedRecords: 0,
    unclassified: new Map(),
    longestTexts: [],
  }
}

function splitRecords(content: string): string[] {
  return content.split('\n')
}

/**
 * Walk a decoded JSON value, calling `visit` for every string.
 *
 * Object keys are visited too, with `isKey` set. They have to be: Codex's
 * `changes` map is keyed by absolute path, so identity hides in the key as
 * often as in the value. But a key is *not* a value, and conflating the two is
 * how the recorder once rewrote the key `sessionId` into a same-shaped
 * pseudonym and produced a cassette that no longer decoded.
 */
function walkStrings(
  value: unknown,
  keyPath: readonly string[],
  visit: (text: string, keyPath: readonly string[], isKey: boolean) => void,
): void {
  if (typeof value === 'string') {
    visit(value, keyPath, false)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) walkStrings(item, keyPath, visit)
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      const childPath = [...keyPath, key]
      visit(key, childPath, true)
      walkStrings(nested, childPath, visit)
    }
  }
}

/**
 * Pass one: allocate a pseudonym for every identity-bearing value.
 *
 * Directories are learned from the keys that name them and from any
 * home-rooted path found anywhere — including inside free text, where a `Bash`
 * result quoting an absolute path is exactly as identifying as a `cwd` field.
 */
export function learnIdentities(
  files: readonly SelectedFile[],
  table: IdentityTable,
  options: { readonly keepRepoName: boolean },
): void {
  const observeText = (text: string) => {
    for (const match of text.matchAll(EMAIL)) {
      if (!match[0].endsWith('@example.invalid')) table.observe('email', match[0])
    }
    for (const match of text.matchAll(HOME_SEGMENT)) {
      const user = match[1]
      if (user) table.observe('user', user)
    }
    for (const match of text.matchAll(HOME_CONFIG_FILE)) {
      // Trailing punctuation a prose sentence put there is not part of the path.
      table.observeConfigPath(match[0].replace(/[.,;:]+$/, ''))
    }
    for (const match of text.matchAll(LOCAL_HOSTNAME)) {
      const host = match[1]
      if (host) {
        const pseudonym = table.observe('host', host)
        const short = host.slice(0, -'.local'.length)
        if (short) table.alias(short, pseudonym, 'host')
      }
    }
  }

  const observeRecord = (value: unknown) => {
    walkStrings(value, [], (text, keyPath, isKey) => {
      const leaf = keyPath.at(-1)
      // Key-classified lookups apply to values only. A key named `sessionId`
      // is a field name, not a session id.
      if (!isKey && leaf !== undefined) {
        if (DIRECTORY_KEYS.has(leaf)) {
          const directory = directoryPathOf(text)
          if (directory) table.observeDirectory(directory, { keepName: options.keepRepoName })
        }
        if (SESSION_KEYS.has(leaf) && text.length >= 8) {
          table.observe('session', text)
        }
      }
      observeText(text)
    })
  }

  for (const file of files) {
    // The session id appears in the file layout before it appears in a record,
    // and the two must agree — `copilot-runs.ts` falls back to the basename.
    const stem = basename(file.cassettePath).replace(/\.jsonl$|\.meta\.json$|\.json$/, '')
    if (looksLikeSessionId(stem)) table.observe('session', stem)

    // A sidecar is one pretty-printed document, so line-splitting it yields
    // fragments that parse as nothing. Learning has to read it the same way
    // `redact` writes it, or the only field VS Code states its workspace in —
    // `folder`, sitting alone on line two — is never seen as a directory, and
    // the capture machine's whole temp-tree ancestry survives into a chat log
    // that keys its file map *by absolute URI*.
    if (file.kind === 'sidecar') {
      try {
        observeRecord(JSON.parse(file.content))
      } catch {
        observeText(file.content)
      }
      continue
    }

    for (const line of splitRecords(file.content)) {
      if (!line.trim()) continue
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        observeText(line)
        continue
      }
      observeRecord(value)
    }
  }
}

interface ApplyContext {
  readonly source: CassetteSource
  readonly table: IdentityTable
  readonly clipLimit: number
  readonly timeOffsetMs: number
  readonly stats: RedactionStats
  readonly label: string
}

function shiftIso(text: string, offsetMs: number): string {
  const shifted = new Date(Date.parse(text) + offsetMs)
  // Preserve the sub-second precision the tool wrote: a scanner that groups by
  // second behaves differently against a coarser stamp.
  return text.includes('.')
    ? shifted.toISOString()
    : shifted.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function noteLongText(stats: RedactionStats, label: string, text: string): void {
  // Called for every scrubbed string in the capture, and all but ten are
  // discarded — so nothing is built until the value has cleared the bar.
  const samples = stats.longestTexts
  if (samples.length >= LONGEST_TEXT_SAMPLES && text.length <= samples.at(-1)!.length) return

  samples.push({ label, length: text.length, preview: text.slice(0, 120).replace(/\s+/g, ' ') })
  samples.sort((left, right) => right.length - left.length)
  samples.length = Math.min(samples.length, LONGEST_TEXT_SAMPLES)
}

function applyToValue(
  value: unknown,
  keyPath: readonly string[],
  context: ApplyContext,
): unknown {
  if (typeof value === 'string') {
    const { keyClass, unclassified } = classifyKey(context.source, keyPath)
    if (unclassified && keyPath.length) {
      const key = keyPath.join('.')
      context.stats.unclassified.set(key, (context.stats.unclassified.get(key) ?? 0) + 1)
    }

    if (keyClass === 'drop') {
      context.stats.droppedValues += 1
      return `[dropped ${Buffer.byteLength(value)} bytes]`
    }

    const substituted = context.table.apply(value)
    if (keyClass === 'preserve') {
      return ISO_TIMESTAMP.test(substituted)
        ? shiftIso(substituted, context.timeOffsetMs)
        : substituted
    }

    if (ISO_TIMESTAMP.test(substituted)) return shiftIso(substituted, context.timeOffsetMs)

    if (keyClass === 'scrub') {
      // Machine inventory hiding in a free-text block. Dropped rather than
      // clipped: four kilobytes of someone's installed skill list is still
      // someone's installed skill list.
      if (isEnvironmentInventory(substituted)) {
        context.stats.droppedValues += 1
        return `[dropped ${Buffer.byteLength(substituted)} bytes of environment inventory]`
      }
      noteLongText(context.stats, `${context.label} ${keyPath.join('.')}`, substituted)
      if (Buffer.byteLength(substituted) > context.clipLimit) {
        context.stats.clippedValues += 1
        const kept = Buffer.from(substituted).subarray(0, context.clipLimit).toString('utf8')
        const dropped = Buffer.byteLength(substituted) - Buffer.byteLength(kept)
        return `${kept}…[clipped ${dropped} bytes]`
      }
    }

    return substituted
  }

  if (typeof value === 'number') {
    // One offset for the whole cassette preserves every interval, so turn
    // durations, LIVE_WINDOW membership, and context-sample spacing stay
    // meaningful. Only millisecond-epoch values are shifted; a duration or a
    // token count never lands in this range.
    return Number.isInteger(value) && value >= EPOCH_MS_FLOOR && value <= EPOCH_MS_CEILING
      ? value + context.timeOffsetMs
      : value
  }

  if (Array.isArray(value)) {
    return value.map(item => applyToValue(item, keyPath, context))
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
      // Codex's `changes` map is keyed by absolute path, so keys carry
      // identity as often as values do.
      context.table.apply(key),
      applyToValue(nested, [...keyPath, key], context),
    ]))
  }

  return value
}

/** The newest timestamp anywhere in the selection, in epoch milliseconds. */
export function newestTimestamp(files: readonly SelectedFile[]): number {
  let newest = 0
  const note = (value: unknown) =>
    walkStrings(value, [], (text) => {
      if (ISO_TIMESTAMP.test(text)) newest = Math.max(newest, Date.parse(text))
    })

  for (const file of files) {
    newest = Math.max(newest, file.mtime * 1_000)
    // Sidecars are whole documents, not one record per line (see
    // `learnIdentities`); a `.meta.json` whose stamps went unread would let the
    // offset land a subagent after the run that spawned it.
    const records = file.kind === 'sidecar'
      ? [file.content]
      : splitRecords(file.content).filter(line => line.trim())
    for (const record of records) {
      try {
        note(JSON.parse(record))
      } catch {
        continue
      }
    }
  }
  return newest
}

/** `sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl`, as Codex writes it. */
const CODEX_ROLLOUT_PATH
  = /^(sessions)\/\d{4}\/\d{2}\/\d{2}\/rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-(.+)$/

/**
 * Shift the capture date Codex encodes in a rollout's *path*.
 *
 * Nothing reads it — `codex-runs.ts` keys on the uuid and sorts by mtime — but
 * a day directory saying 08/04 beside a filename saying 01-01 beside records
 * saying 01-01 reads as a broken recording to whoever reviews the cassette
 * next, and the day directory is exactly the layout the cassette exists to
 * exercise. Both halves are rebuilt from the one shifted instant so they
 * cannot disagree.
 */
function shiftPathTimestamp(path: string, offsetMs: number): string {
  const match = CODEX_ROLLOUT_PATH.exec(path)
  if (!match) return path

  const [, subtree, stamp, rest] = match as unknown as [string, string, string, string]
  const shifted = new Date(Date.parse(`${stamp.slice(0, 10)}T${stamp.slice(11).replace(/-/g, ':')}Z`) + offsetMs)
  const iso = shifted.toISOString()
  const day = iso.slice(0, 10).replace(/-/g, '/')
  return `${subtree}/${day}/rollout-${iso.slice(0, 19).replace(/:/g, '-')}-${rest}`
}

export function redact(
  files: readonly SelectedFile[],
  options: {
    readonly source: CassetteSource
    readonly table: IdentityTable
    readonly limit: number
    readonly clipLimit: number
    readonly timeOffsetMs: number
  },
): RedactionResult {
  const stats = emptyStats()
  const { clipLimit } = options
  const directories = new Map<string, string>()
  const output: RedactedFile[] = []

  for (const file of files) {
    const cassettePath = shiftPathTimestamp(
      options.table.apply(file.cassettePath),
      options.timeOffsetMs,
    )
    const context: ApplyContext = {
      source: options.source,
      table: options.table,
      clipLimit,
      timeOffsetMs: options.timeOffsetMs,
      stats,
      label: cassettePath,
    }

    let content: string
    let records: number

    if (file.kind === 'sidecar') {
      // One JSON document, copied whole: a `.meta.json` that lost fields to a
      // record limit would break the subagent labels it exists to supply.
      const parsed: unknown = JSON.parse(file.content)
      content = `${JSON.stringify(applyToValue(parsed, [], context), null, 2)}\n`
      records = 1
    } else {
      const lines = splitRecords(file.content).filter(line => line.trim().length > 0)
      const kept = lines.slice(0, options.limit)
      stats.keptRecords += kept.length
      stats.droppedRecords += lines.length - kept.length
      records = kept.length
      content = `${kept.map((line) => {
        let value: unknown
        try {
          value = JSON.parse(line)
        } catch {
          // A truncated write is a real state the scanners must handle; it is
          // kept, substituted as raw text, and enumerated in the manifest.
          return options.table.apply(line)
        }
        return JSON.stringify(applyToValue(value, [], context))
      }).join('\n')}\n`
    }

    output.push({ ...file, cassettePath, content, records })
  }

  for (const entry of options.table.entries()) {
    if (entry.kind === 'directory' && entry.real.startsWith('/')) {
      directories.set(entry.pseudonym, entry.real)
    }
  }

  return { files: output, stats, directories }
}

/**
 * Referential integrity for Claude Code's project-directory slug.
 *
 * The slug is `cwd` with every non-alphanumeric character replaced, so it
 * survives no path rewrite — it is registered as its own literal. This asserts
 * the registration produced exactly what the slug rule would, rather than
 * trusting that the two happened to agree.
 */
export function assertSlugsConsistent(
  files: readonly RedactedFile[],
  directories: ReadonlyMap<string, string>,
): void {
  const expected = new Set([...directories.keys()].map(projectSlug))
  for (const file of files) {
    const match = /^projects\/([^/]+)\//.exec(file.cassettePath)
    if (!match) continue
    const slug = match[1]!
    if (!expected.has(slug)) {
      throw new Error(
        `Redacted project slug ${slug} is not projectSlug() of any pseudonymized directory `
        + `(${[...expected].join(', ') || 'none'}). The identity table and the file layout disagree.`,
      )
    }
  }
}
