/**
 * Pseudonym allocation for the cassette recorder.
 *
 * Not hashing. A keyed hash with a committed salt is reversible by dictionary
 * attack for exactly the values that matter — a username or a hostname carries
 * a handful of bits of entropy. Instead, pseudonyms are allocated by a counter
 * in order of first appearance: deterministic for a given input, stable across
 * a re-record of the same session, and irreversible.
 *
 * The table is global to a cassette (spec §8.4). The same real value must
 * produce the same pseudonym in the transcript body, in `cwd`, in the file
 * layout, and in a subagent's `.meta.json` — a cassette that gets this wrong
 * still parses, but its file-change aggregation is nonsense.
 */
import { projectSlug } from './sources.ts'

export type IdentityKind = 'user' | 'host' | 'email' | 'directory' | 'session' | 'config'

/**
 * The kinds {@link IdentityTable.observe} mints a pseudonym for. Directories
 * and configuration files have their own entry points, because their
 * pseudonyms are paths that carry aliases — a project slug, a bare filename —
 * that a plain counter cannot produce.
 */
type MintableKind = 'user' | 'host' | 'email' | 'session'

export interface IdentityEntry {
  readonly kind: IdentityKind
  readonly real: string
  readonly pseudonym: string
}

/**
 * A small deterministic generator, seeded from the cassette id.
 *
 * Session ids are regenerated as *valid values of the same shape* rather than
 * replaced with `session-1`: several code paths parse them, and
 * `basename(path, '.jsonl')` is a fallback run key in `copilot-runs.ts`.
 * Seeding from the cassette id rather than a constant keeps two cassettes from
 * minting the same session id, which matters because the browser tier
 * materializes every cassette into one shared root.
 */
function seededRandom(seed: string): () => number {
  let state = 2_166_136_261 >>> 0
  for (const character of seed) {
    state ^= character.charCodeAt(0)
    state = Math.imul(state, 16_777_619) >>> 0
  }
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 4_294_967_296
  }
}

const HEX = '0123456789abcdef'
/** Crockford base32, as ULIDs use. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/

/**
 * Whether a transcript filename's stem is the session's own identifier.
 *
 * The uuid half is deliberately a prefix rather than {@link UUID}: a tool that
 * suffixes the stem still names the session, and the cost of observing one
 * value too many is a pseudonym nobody uses. It lives here so the shapes the
 * recorder *detects* and the shapes {@link sameShapedId} can *regenerate* are
 * read together — a stem matched by one and not the other is a session id the
 * table cannot replace in kind.
 */
export function looksLikeSessionId(stem: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(stem) || ULID.test(stem)
}

function pick(random: () => number, alphabet: string): string {
  return alphabet[Math.floor(random() * alphabet.length)]!
}

function sameShapedId(value: string, random: () => number): string {
  if (UUID.test(value)) {
    const hex = (count: number) => Array.from({ length: count }, () => pick(random, HEX)).join('')
    // Version 4, variant 10xx — the shape `codex-runs.ts` matches on.
    return `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[Math.floor(random() * 4)]}${hex(3)}-${hex(12)}`
  }
  if (ULID.test(value)) {
    return Array.from({ length: 26 }, () => pick(random, CROCKFORD)).join('')
  }
  // Anything else keeps its length and character classes, so a consumer that
  // slices or pads it behaves the same.
  return [...value].map((character) => {
    if (/[0-9]/.test(character)) return pick(random, '0123456789')
    if (/[a-z]/.test(character)) return pick(random, 'abcdefghijklmnopqrstuvwxyz')
    if (/[A-Z]/.test(character)) return pick(random, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')
    return character
  }).join('')
}

/**
 * Below this length a whitespace-tolerant pattern matches ordinary prose —
 * `a b c d` would stand in for `abcd`. Long values are safe; short ones are
 * covered by the literal pass and by the path and email detectors.
 */
const WRAP_TOLERANT_MINIMUM_LENGTH = 8

/**
 * Below this, a configuration file's bare name is too generic to substitute
 * out of free text — `rules`, `main.ts`, `test.md` all occur in prose that has
 * nothing to do with the operator's setup.
 */
const CONFIG_NAME_MINIMUM_LENGTH = 8

/** `abc` → /a\s*b\s*c/g, with every character escaped. */
function wrapTolerantPattern(value: string): RegExp {
  return new RegExp(
    [...value].map(character => character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'),
    'g',
  )
}

export class IdentityTable {
  /** Real value → pseudonym, in allocation order. */
  private readonly byReal = new Map<string, IdentityEntry>()
  /** Pseudonym → the one real value it stands for, for the injectivity check. */
  private readonly byPseudonym = new Map<string, string>()
  private readonly counters = new Map<IdentityKind, number>()
  private readonly random: () => number
  /** Rebuilt on first `apply` after any `assign`; `undefined` means stale. */
  private substitutions: Array<{
    readonly real: string
    readonly pseudonym: string
    /** Absent for values too short to match tolerantly without hitting prose. */
    readonly wrapped?: RegExp
  }> | undefined

  /**
   * The pseudonym every canonical directory path is rooted under. The recorder
   * registers the capture machine's login before anything else, so this is
   * `user-1` in practice; the fallback keeps `observeDirectory` total for a
   * table used without that step.
   */
  private primaryUserPseudonym = ''

  private readonly cassetteId: string

  constructor(cassetteId: string) {
    this.cassetteId = cassetteId
    this.random = seededRandom(cassetteId)
  }

  /** The pseudonym directory paths are rooted under. */
  get primaryUser(): string {
    return this.primaryUserPseudonym || 'user-1'
  }

  private next(kind: IdentityKind): number {
    // Emails share the user namespace, so a person's login and address do not
    // read as two different people in the review summary.
    const namespace = kind === 'email' ? 'user' : kind
    const count = (this.counters.get(namespace) ?? 0) + 1
    this.counters.set(namespace, count)
    return count
  }

  /** The pseudonym for `real`, allocating one on first sight. */
  observe(kind: MintableKind, real: string): string {
    const existing = this.byReal.get(real)
    if (existing) return existing.pseudonym
    return this.assign(kind, real, this.mint(kind, real))
  }

  /**
   * Record `real` as another name for an already-known value — a git display
   * name and an email address for the same person, the home directory and its
   * project-slug spelling for the same path.
   */
  alias(real: string, pseudonym: string, kind: IdentityKind): string {
    const existing = this.byReal.get(real)
    if (existing) return existing.pseudonym
    return this.assign(kind, real, pseudonym, { shared: true })
  }

  /**
   * Map a directory to a canonical pseudonym path, and register the Claude
   * project-slug spelling of both alongside it.
   *
   * The slug is derived from `cwd` by a character substitution, so it survives
   * neither path replacement nor concatenation — it has to be registered as
   * its own literal, and then the recorder asserts the written slug equals
   * `projectSlug(redacted cwd)` rather than trusting this.
   */
  observeDirectory(real: string, options: { readonly keepName?: boolean } = {}): string {
    const known = this.byReal.get(real)
    if (known) return known.pseudonym

    const segments = real.split('/').filter(Boolean)
    const name = segments.at(-1) ?? 'repo'
    const label = options.keepName ? name : `repo-${this.next('directory')}`
    const pseudonym = `/Users/${this.primaryUser}/Projects/${label}`
    this.assign('directory', real, pseudonym)
    this.alias(projectSlug(real), projectSlug(pseudonym), 'directory')

    // Ancestors, too. A capture directory sits somewhere — a temp tree, a
    // clients folder — and tool output quotes those ancestors constantly: an
    // npm log path, a stack frame, a `cd` in a shell command. Mapping only the
    // capture directory itself leaves every one of them intact, which is how a
    // recording ends up publishing the operator's directory layout.
    //
    // Anything shallower than three segments is a system root (`/private/tmp`,
    // `/var/folders`) that identifies nobody and would be misleading to rewrite.
    for (let depth = segments.length - 1; depth >= 3; depth -= 1) {
      const ancestor = `/${segments.slice(0, depth).join('/')}`
      const target = depth === segments.length - 1
        ? `/Users/${this.primaryUser}/Projects`
        : `/Users/${this.primaryUser}`
      this.alias(ancestor, target, 'directory')
      this.alias(projectSlug(ancestor), projectSlug(target), 'directory')
    }

    return pseudonym
  }

  /**
   * Map a file in the operator's own configuration — `~/.claude/rules/x.md`,
   * `~/.codex/skills/y.md` — to an anonymous stand-in under a single directory.
   *
   * These reach a transcript without ever being opened by the session: VS Code
   * attaches every applicable instruction file to a chat request as a content
   * reference, so a capture against the sandbox still names the operator's
   * private rules. Pseudonymizing to `/Users/user-1/Projects/repo-N` — the
   * directory treatment — would file operator configuration under the project
   * the cassette is about, and the file-change aggregation would believe it.
   *
   * The extension is kept, so a consumer that branches on `.md` still does.
   */
  observeConfigPath(real: string): string {
    const known = this.byReal.get(real)
    if (known) return known.pseudonym

    const extension = /\.[A-Za-z0-9]{1,8}$/.exec(real)?.[0] ?? ''
    const label = `file-${this.next('config')}`
    const pseudonym = `/Users/${this.primaryUser}/.agent-config/${label}${extension}`
    this.assign('config', real, pseudonym)

    // The bare name and the stem, too. VS Code labels an attached instruction
    // file `prompt:agent-browser.md` — no path — and the model then discusses
    // it by name in its own prose, so replacing only the path leaves the
    // inventory intact in the two places a reader would actually notice it.
    //
    // Short names are skipped: a rule file called `test.md` cannot be
    // substituted out of a transcript without wrecking unrelated text.
    const name = real.split('/').at(-1) ?? ''
    const stem = name.slice(0, name.length - extension.length)
    if (name.length >= CONFIG_NAME_MINIMUM_LENGTH) {
      this.alias(name, `${label}${extension}`, 'config')
    }
    if (stem.length >= CONFIG_NAME_MINIMUM_LENGTH) this.alias(stem, label, 'config')

    return pseudonym
  }

  private mint(kind: MintableKind, real: string): string {
    switch (kind) {
      case 'user': return `user-${this.next('user')}`
      case 'host': return `host-${this.next('host')}`
      case 'email': return `user-${this.next('email')}@example.invalid`
      case 'session': return sameShapedId(real, this.random)
    }
  }

  /**
   * `shared` marks a deliberate many-to-one mapping: a login, a display name,
   * and an email address are three spellings of one person, and collapsing
   * them onto `user-1` is the intent rather than a bug. Anything else that
   * lands on a taken pseudonym is a counter mistake, and aborts.
   */
  private assign(
    kind: IdentityKind,
    real: string,
    pseudonym: string,
    options: { readonly shared?: boolean } = {},
  ): string {
    const claimed = this.byPseudonym.get(pseudonym)
    if (!options.shared && claimed !== undefined && claimed !== real) {
      throw new Error(
        `Pseudonym collision in ${this.cassetteId}: ${pseudonym} would stand for both `
        + `${JSON.stringify(claimed)} and ${JSON.stringify(real)}`,
      )
    }
    this.byReal.set(real, { kind, real, pseudonym })
    if (claimed === undefined) this.byPseudonym.set(pseudonym, real)
    if (kind === 'user' && !this.primaryUserPseudonym) this.primaryUserPseudonym = pseudonym
    this.substitutions = undefined
    return pseudonym
  }

  entries(): readonly IdentityEntry[] {
    return [...this.byReal.values()]
  }

  get size(): number {
    return this.byReal.size
  }

  /**
   * Rewrite every known real value in `text`.
   *
   * Longest first, so a home directory is replaced before the username inside
   * it and a repository path before its bare name. Applied to *every* string
   * regardless of key class: the classification decides what gets clipped and
   * what the entropy detector skips, but identity substitution is global by
   * design — a real path is no less real for appearing inside free text.
   */
  apply(text: string): string {
    this.substitutions ??= [...this.byReal.values()]
      .filter(entry => entry.real.length > 0)
      .sort((left, right) => right.real.length - left.real.length)
      .map(entry => ({
        real: entry.real,
        pseudonym: entry.pseudonym,
        // The whitespace-tolerant twin travels with its literal, so both
        // forms of one value are tried before any shorter value (see below).
        wrapped: entry.real.length >= WRAP_TOLERANT_MINIMUM_LENGTH
          ? wrapTolerantPattern(entry.real)
          : undefined,
      }))

    // Literal and whitespace-tolerant matching interleaved, longest value
    // first — not two passes.
    //
    // Terminal output wraps, and a path split as `…/scratchpad/\ncap-vscode/…`
    // is invisible to literal substitution *and* to the residue scanner. Two
    // separate passes look equivalent and are not: the literal pass would first
    // replace a *shorter* known prefix of that path, leaving nothing for the
    // wrapped pattern of the longer value to match, and the tail below the
    // break survives. Trying both forms of one value before moving to a shorter
    // one is what makes the longest match actually win.
    //
    // Only values long enough not to collide with ordinary prose get the
    // tolerant form; `a b c d` must not stand in for `abcd`.
    let result = text
    for (const { real, pseudonym, wrapped } of this.substitutions) {
      if (result.includes(real)) {
        result = result.replaceAll(real, pseudonym)
        continue
      }
      if (!wrapped) continue
      wrapped.lastIndex = 0
      if (wrapped.test(result)) {
        wrapped.lastIndex = 0
        result = result.replace(wrapped, pseudonym)
      }
    }

    return result
  }

  /**
   * Assert that substitution is order-independent.
   *
   * One real value maps to one pseudonym by construction — `byReal` is keyed
   * by the real value — and the reverse direction is intentionally many-to-one
   * (see `assign`). What is *not* structural is that no pseudonym is itself a
   * substitutable value: that would make `apply` depend on the order the rules
   * happen to run in, and rewrite the same path one way in the transcript body
   * and another in the file layout.
   */
  assertInjective(): void {
    for (const entry of this.byReal.values()) {
      if (this.byReal.has(entry.pseudonym)) {
        throw new Error(
          `Pseudonym ${entry.pseudonym} is itself a real value in the table, so substitution `
          + 'would depend on the order the rules are applied in',
        )
      }
    }
  }

  /** The review summary the recorder prints, and the gitignored decode file. */
  toReviewTable(): string {
    const width = Math.max(...this.entries().map(entry => entry.pseudonym.length), 10)
    return this.entries()
      .map(entry => `  ${entry.pseudonym.padEnd(width)}  ←  ${entry.real}  (${entry.kind})`)
      .join('\n')
  }
}
