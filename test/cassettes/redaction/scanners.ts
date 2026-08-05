/**
 * Residue detectors — the fail-closed half of the cassette safety model.
 *
 * The recorder runs these over its fully redacted output *before* writing
 * anything, so a leak aborts the recording. `test/unit/cassette-hygiene.spec.ts`
 * runs the same detectors over every committed cassette byte, which is the
 * actual guarantee: a hand-edited or hand-constructed cassette cannot bypass
 * them by never going through the recorder.
 *
 * Every detector fails closed. A false positive costs an operator one minute;
 * a false negative is a credential in a public git history.
 */
import { execFileSync } from 'node:child_process'
import { homedir, hostname, userInfo } from 'node:os'
import { type CassetteSource, classifyKey, type KeyClass } from './rules.ts'

export interface ScanChunk {
  /** Where this text came from, e.g. `projects/…/01J8X.jsonl:118 message.content[0].text`. */
  readonly label: string
  readonly text: string
  /**
   * The classification of the key this text sat under. `preserve` exempts the
   * chunk from the entropy detector only — a preserved value is one the
   * scanners read, and message ids and request ids look like secrets to a
   * statistical test while being neither.
   */
  readonly keyClass: KeyClass
  /**
   * Whether this text is a value or an object key. Keys are still checked for
   * paths, credentials, and environment residue — a map keyed by absolute path
   * hides identity in the key — but not for entropy, where a long camelCase
   * identifier is indistinguishable from a token and never a secret.
   *
   * @default 'value'
   */
  readonly kind?: 'value' | 'key'
}

export interface ResidueHit {
  /** Which detector fired, for the abort message. */
  readonly scanner: string
  readonly label: string
  readonly detail: string
  /** The offending text with the sensitive span masked. */
  readonly excerpt: string
}

/** A literal string that must not appear in a cassette, and why. */
export interface NamedSecret {
  readonly name: string
  readonly value: string
}

/**
 * Values short enough to collide with ordinary prose are not usable as
 * literal detectors — a three-character username would fire on every
 * transcript. Those are still covered by the path and email detectors.
 */
const MINIMUM_LITERAL_LENGTH = 4

const CREDENTIAL_SHAPES: ReadonlyArray<readonly [string, RegExp]> = [
  ['openai-key', /sk-[A-Za-z0-9]{20,}/],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/],
  ['github-pat', /\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./],
  ['bearer-token', /\bBearer\s+[A-Za-z0-9._-]{20,}/],
  ['pem-block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9-]{20,}/],
]

/** Emails the pseudonymizer produces, which are expected rather than residue. */
const PSEUDONYM_EMAIL = /@example\.invalid$/
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

/** The username segment the pseudonymizer allocates: `user-1`, `user-2`, … */
export const PSEUDONYM_USER = /^user-\d+$/

/** Home-rooted absolute paths, POSIX and Windows, capturing the user segment. */
const HOME_ROOTED_PATH = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)([A-Za-z0-9._-]+)/g

/**
 * Deep temp-rooted paths.
 *
 * A capture usually runs in a temporary directory, and a deep one encodes the
 * operator's machine as surely as a home path does — the recording that
 * prompted this rule carried
 * `/private/tmp/<runner>/<repo-slug>/<session-uuid>/scratchpad/...` in npm log
 * paths and stack frames, none of which the home-rooted detector could see.
 *
 * The threshold is depth, not presence: a session that writes `/tmp/probe.mjs`
 * is doing ordinary work and says nothing about the machine, while three or
 * more segments below a temp root is a directory layout.
 */
const TEMP_ROOTS = [
  /\/private\/var\/folders\/[^/\s]+\/[^/\s]+\/[A-Z]\//,
  /\/var\/folders\/[^/\s]+\/[^/\s]+\/[A-Z]\//,
  /\/private\/tmp\//,
  /\/tmp\//,
]
const TEMP_PATH_SEGMENT_LIMIT = 2
const PATH_TAIL = /^[A-Za-z0-9._@%+-]+(?:\/[A-Za-z0-9._@%+-]+)*/

/**
 * Files inside the operator's own agent configuration.
 *
 * A pseudonymized home is not enough here: `/Users/user-1/.claude/rules/x.md`
 * names nobody and still publishes what the operator has installed, and it
 * arrives without the session ever opening it — VS Code attaches every
 * applicable instruction file to each chat request. `.agent-config` is the
 * directory the recorder's own pseudonyms live in, and is therefore the one
 * dot-directory that is expected rather than residue.
 */
const HOME_CONFIG_PATH
  = /(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+\/(\.[A-Za-z0-9._-]+)\/[A-Za-z0-9._-]+/g
const PSEUDONYM_CONFIG_DIRECTORY = '.agent-config'

/**
 * Candidate opaque tokens for the entropy detector.
 *
 * `/` is deliberately absent. With it, every absolute path is a candidate, and
 * a pseudonymized path scores about 4.6 bits per character — high enough to
 * drown the detector in false positives from the very values redaction just
 * produced. A base64 blob containing `/` still trips this: it is split into
 * runs, and any run of 32 or more characters is scored on its own.
 */
const TOKEN_CANDIDATE = /[A-Za-z0-9_\-+=]{32,}/g

/**
 * Structured identifiers, which are not secrets however random they look.
 *
 * A UUID scores 3.4 to 3.9 bits per character and a git SHA about 3.6 — both
 * comfortably below the threshold, but they are excluded explicitly so the
 * threshold can be set from what real secrets score rather than from what
 * identifiers happen not to.
 */
const STRUCTURED_ID = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[0-9A-HJKMNP-TV-Z]{26}$/,
  /^[0-9a-fA-F-]+$/,
]

/**
 * Calibrated against a real capture rather than guessed.
 *
 * Measured over a recorded Copilot CLI session: opaque model state scored 4.98
 * to 5.89 bits per character, while every identifier, path, and camelCase key
 * in the same file scored 4.03 or below. 4.5 sits in that gap with margin on
 * both sides.
 */
const ENTROPY_BITS_PER_CHARACTER = 4.5

/** Exported so the hygiene test asserts against the threshold rather than a copy of it. */
export const ENTROPY_THRESHOLD_BITS = ENTROPY_BITS_PER_CHARACTER

const SECRET_ENVIRONMENT_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL|COOKIE/i

/** Shannon entropy of `text`, in bits per character. */
export function shannonEntropy(text: string): number {
  if (!text) return 0
  const frequencies = new Map<string, number>()
  for (const character of text) {
    frequencies.set(character, (frequencies.get(character) ?? 0) + 1)
  }
  let bits = 0
  for (const count of frequencies.values()) {
    const probability = count / text.length
    bits -= probability * Math.log2(probability)
  }
  return bits
}

function gitConfig(key: string, cwd: string): string {
  try {
    return execFileSync('git', ['config', '--get', key], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    // No git, no repository, or no such key — all routine.
    return ''
  }
}

/**
 * Everything about *this machine* that must not appear in a cassette.
 *
 * Collected at scan time rather than baked into the repository, so the same
 * detector protects whoever runs it. On CI it finds the runner's identity and
 * therefore proves nothing about the recording machine — which is why the
 * pattern-based detectors below carry the real weight there.
 */
export function collectEnvironmentSecrets(cwd = process.cwd()): NamedSecret[] {
  const secrets: NamedSecret[] = [
    { name: 'homedir', value: homedir() },
    { name: 'username', value: userInfo().username },
    { name: 'hostname', value: hostname() },
    { name: 'hostname.short', value: hostname().split('.')[0] ?? '' },
    { name: 'git user.name', value: gitConfig('user.name', cwd) },
    { name: 'git user.email', value: gitConfig('user.email', cwd) },
  ]

  for (const [name, value] of Object.entries(process.env)) {
    if (!value) continue
    if (name.startsWith('LCC_') || SECRET_ENVIRONMENT_NAME.test(name)) {
      secrets.push({ name: `env ${name}`, value })
    }
  }

  return secrets.filter(secret => secret.value.length >= MINIMUM_LITERAL_LENGTH)
}

function mask(value: string): string {
  if (value.length <= 6) return '*'.repeat(value.length)
  return `${value.slice(0, 2)}${'*'.repeat(value.length - 4)}${value.slice(-2)}`
}

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 24)
  const end = Math.min(text.length, index + length + 24)
  const before = text.slice(start, index)
  const after = text.slice(index + length, end)
  return `${start > 0 ? '…' : ''}${before}${mask(text.slice(index, index + length))}${after}${end < text.length ? '…' : ''}`
    .replace(/\s+/g, ' ')
}

/**
 * A secret with its two search forms precomputed.
 *
 * The forms depend only on the secret, and `scanChunk` runs against tens of
 * thousands of chunks per pass — deriving them per chunk was measurably the
 * larger half of the environment detector's cost.
 */
interface PreparedSecret {
  readonly name: string
  readonly value: string
  readonly lowered: string
  /** Whitespace removed, or `''` when the result is too short to search for. */
  readonly collapsed: string
}

function prepareSecrets(secrets: readonly NamedSecret[]): readonly PreparedSecret[] {
  return secrets.map((secret) => {
    const collapsed = secret.value.toLowerCase().replace(/\s+/g, '')
    return {
      name: secret.name,
      value: secret.value,
      lowered: secret.value.toLowerCase(),
      collapsed: collapsed.length >= MINIMUM_LITERAL_LENGTH ? collapsed : '',
    }
  })
}

/** Run every detector over one chunk. */
export function scanChunk(chunk: ScanChunk, secrets: readonly NamedSecret[]): ResidueHit[] {
  return scanPrepared(chunk, prepareSecrets(secrets))
}

function scanPrepared(chunk: ScanChunk, secrets: readonly PreparedSecret[]): ResidueHit[] {
  const hits: ResidueHit[] = []
  const { text, label } = chunk

  // 1. Environment residue, literal and line-wrapped.
  //
  // Terminal output wraps, and a username split across a line break is
  // invisible to a literal search — the one case where a leak survives every
  // check. The collapsed copy costs one pass and closes it, and is built only
  // once a literal search has actually missed.
  if (secrets.length) {
    const lowered = text.toLowerCase()
    let collapsed: string | undefined
    for (const secret of secrets) {
      const index = lowered.indexOf(secret.lowered)
      if (index !== -1) {
        hits.push({
          scanner: 'environment',
          label,
          detail: `contains this machine's ${secret.name}`,
          excerpt: excerptAround(text, index, secret.value.length),
        })
        continue
      }
      if (!secret.collapsed) continue
      collapsed ??= lowered.replace(/\s+/g, '')
      if (collapsed.includes(secret.collapsed)) {
        hits.push({
          scanner: 'environment',
          label,
          detail: `contains this machine's ${secret.name}, split across a line break`,
          excerpt: `…${mask(secret.value)}…`,
        })
      }
    }
  }

  // 2. Known credential shapes.
  for (const [name, pattern] of CREDENTIAL_SHAPES) {
    const match = pattern.exec(text)
    if (!match) continue
    hits.push({
      scanner: 'credential',
      label,
      detail: `matches a ${name} shape`,
      excerpt: excerptAround(text, match.index, match[0].length),
    })
  }

  // 3. Email addresses other than the pseudonyms.
  for (const match of text.matchAll(EMAIL)) {
    if (PSEUDONYM_EMAIL.test(match[0])) continue
    hits.push({
      scanner: 'email',
      label,
      detail: `email address ${mask(match[0])}`,
      excerpt: excerptAround(text, match.index, match[0].length),
    })
  }

  // 4. High-entropy tokens. Preserved values are exempt: message ids, request
  //    ids, and thinking signatures are opaque by nature and are read by the
  //    scanners under test.
  if (chunk.keyClass !== 'preserve' && chunk.kind !== 'key') {
    for (const match of text.matchAll(TOKEN_CANDIDATE)) {
      if (STRUCTURED_ID.some(pattern => pattern.test(match[0]))) continue
      if (shannonEntropy(match[0]) <= ENTROPY_BITS_PER_CHARACTER) continue
      hits.push({
        scanner: 'entropy',
        label,
        detail: `${match[0].length}-character token at `
          + `${shannonEntropy(match[0]).toFixed(2)} bits/char`,
        excerpt: excerptAround(text, match.index, match[0].length),
      })
    }
  }

  // 5. Absolute paths outside the pseudonym space.
  for (const match of text.matchAll(HOME_ROOTED_PATH)) {
    const user = match[1] ?? ''
    if (PSEUDONYM_USER.test(user)) continue
    hits.push({
      scanner: 'path',
      label,
      detail: `home-rooted path whose user segment is ${JSON.stringify(user)}, not user-N`,
      excerpt: excerptAround(text, match.index, match[0].length),
    })
  }

  // 6. Files inside the operator's agent configuration, pseudonymized home or not.
  for (const match of text.matchAll(HOME_CONFIG_PATH)) {
    if (match[1] === PSEUDONYM_CONFIG_DIRECTORY) continue
    hits.push({
      scanner: 'home-config',
      label,
      detail: `names a file under the operator's ${match[1]} configuration, `
        + 'which inventories what they have installed',
      excerpt: excerptAround(text, match.index, match[0].length),
    })
  }

  // 7. Deep temp-rooted paths, which encode a directory layout.
  for (const root of TEMP_ROOTS) {
    const rooted = root.exec(text)
    if (!rooted) continue
    const tail = PATH_TAIL.exec(text.slice(rooted.index + rooted[0].length))?.[0] ?? ''
    const depth = tail.split('/').filter(Boolean).length
    if (depth <= TEMP_PATH_SEGMENT_LIMIT) continue
    hits.push({
      scanner: 'temp-path',
      label,
      detail: `${depth}-segment path below a temporary root, which encodes the capture machine`,
      excerpt: excerptAround(text, rooted.index, rooted[0].length + tail.length),
    })
    break
  }

  return hits
}

/**
 * Run every detector over every chunk.
 *
 * Results are memoized on the text and its classification, which is what makes
 * scanning a whole corpus affordable: most chunks are object keys, and a
 * cassette carries thousands of `"type"` and `"timestamp"` for a few hundred
 * distinct spellings. The detectors are pure functions of those three fields,
 * so a repeat is the same answer with a different `label` stamped on it.
 */
export function scanChunks(
  chunks: Iterable<ScanChunk>,
  secrets: readonly NamedSecret[],
): ResidueHit[] {
  const prepared = prepareSecrets(secrets)
  const seen = new Map<string, readonly ResidueHit[]>()
  const hits: ResidueHit[] = []

  for (const chunk of chunks) {
    const key = `${chunk.kind ?? 'value'} ${chunk.keyClass} ${chunk.text}`
    const cached = seen.get(key)
    if (cached) {
      hits.push(...cached.map(hit => ({ ...hit, label: chunk.label })))
      continue
    }
    const found = scanPrepared(chunk, prepared)
    seen.set(key, found)
    hits.push(...found)
  }

  return hits
}

/**
 * Break one recorded file into scannable chunks: every string leaf carries the
 * classification of the key it sat under, so the entropy detector can be
 * exempted exactly where the rules say and nowhere else.
 *
 * A line that is not valid JSON is scanned whole under `scrub` — a cassette
 * may legitimately carry a truncated write, and it must still be clean.
 */
export function* chunksForFile(
  source: CassetteSource,
  path: string,
  content: string,
): Generator<ScanChunk> {
  yield { label: `${path} (name)`, text: path, keyClass: 'pseudonymize' }

  const lines = content.split('\n')
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue
    const where = `${path}:${index}`
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      yield { label: where, text: line, keyClass: 'scrub' }
      continue
    }
    yield* chunksForValue(source, where, value, [])
  }
}

function* chunksForValue(
  source: CassetteSource,
  where: string,
  value: unknown,
  keyPath: readonly string[],
): Generator<ScanChunk> {
  if (typeof value === 'string') {
    yield {
      label: keyPath.length ? `${where} ${keyPath.join('.')}` : where,
      text: value,
      keyClass: classifyKey(source, keyPath).keyClass,
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) yield* chunksForValue(source, where, item, keyPath)
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      const childPath = [...keyPath, key]
      // Keys are scanned too: an object keyed by an absolute path (Codex's
      // `changes` map is exactly that) hides identity in the key, not the value.
      yield {
        label: `${where} ${childPath.join('.')} (key)`,
        text: key,
        keyClass: 'pseudonymize',
        kind: 'key',
      }
      yield* chunksForValue(source, where, nested, childPath)
    }
  }
}

/** Format hits for a terminal or a test failure message. */
export function formatResidueHits(hits: readonly ResidueHit[], limit = 20): string {
  const shown = hits.slice(0, limit)
  const lines = shown.map(hit =>
    `  [${hit.scanner}] ${hit.label}\n      ${hit.detail}\n      ${hit.excerpt}`,
  )
  if (hits.length > shown.length) {
    lines.push(`  … and ${hits.length - shown.length} more`)
  }
  return lines.join('\n')
}
