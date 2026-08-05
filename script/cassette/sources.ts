/**
 * What each supported tool *is*, as one table.
 *
 * Four tools, and every layer of the cassette system needs a different fact
 * about them: the recorder needs the live root and the producer name, the
 * layout needs the `files/` subtree, the loader and the e2e tier need the
 * override variable. Stated once here, those facts cannot disagree — and
 * adding a fifth tool is one entry that fails to compile until every field is
 * filled in, rather than a search for the places that switch on the union.
 *
 * Only facts that are cheap to state belong here. A source's key
 * classification lives in `test/cassettes/redaction/rules.ts`, its selector in
 * `select.ts`, and its parser and scanner in `test/fixtures/cassette-projection.ts`,
 * because each of those pulls in dependencies this module must not have: it is
 * read by a bare Node process with type stripping and by the Vitest fixtures
 * alike.
 *
 * The roots are a deliberate copy of the ones in `server/utils/services.ts`.
 * The recorder cannot resolve `#server` — that specifier is a Vite alias with
 * no `imports` entry in `package.json` — so the values are mirrored here, and
 * `test/unit/cassette-roots.spec.ts` asserts the two agree so they cannot
 * drift apart silently.
 */
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { CASSETTE_SOURCES, type CassetteSource } from '../../test/cassettes/redaction/rules.ts'

export interface SourceDescriptor {
  /**
   * Where this source's files sit inside a cassette, below `files/`.
   *
   * The subtree names are part of the cassette format: the loader points the
   * matching `Context.Reference` at `<cassette>/files/<subtree>` so that replay
   * exercises discovery — the day-directory walk, the `subagents/` convention,
   * the `workspaceStorage` layout — and not only parsing.
   */
  readonly subtree: string
  /** The `LCC_*` variable that overrides this source's root. */
  readonly envVar: string
  /**
   * Whether the override holds a `delimiter`-separated list.
   *
   * Only VS Code is configured with several roots — stable and Insiders. For
   * the rest a path containing the platform delimiter is a path and not a
   * list, and the server does not split them either.
   */
  readonly listValued: boolean
  /** The platform default roots, mirrored from `server/utils/services.ts`. */
  readonly defaultRoots: () => ReadonlyArray<string>
  /** The tool this source's `producer.tool` names. */
  readonly producerTool: string
}

export const SOURCES: Readonly<Record<CassetteSource, SourceDescriptor>> = {
  'claude': {
    subtree: 'projects',
    envVar: 'LCC_CLAUDE_PROJECTS',
    listValued: false,
    defaultRoots: () => [join(homedir(), '.claude', 'projects')],
    producerTool: 'claude-code',
  },
  'codex': {
    subtree: 'sessions',
    envVar: 'LCC_CODEX_SESSIONS',
    listValued: false,
    defaultRoots: () => [join(homedir(), '.codex', 'sessions')],
    producerTool: 'codex-cli',
  },
  'copilot': {
    subtree: 'vscode-user',
    envVar: 'LCC_VSCODE_USER_DATA',
    listValued: true,
    defaultRoots: () => [
      join(homedir(), 'Library', 'Application Support', 'Code', 'User'),
      join(homedir(), 'Library', 'Application Support', 'Code - Insiders', 'User'),
    ],
    producerTool: 'vscode-copilot-chat',
  },
  'copilot-cli': {
    subtree: 'session-state',
    envVar: 'LCC_COPILOT_SESSIONS',
    listValued: false,
    defaultRoots: () => [join(homedir(), '.copilot', 'session-state')],
    producerTool: 'copilot-cli',
  },
}

/** Every source's live roots, in the order discovery would read them. */
export type ResolvedRoots = Readonly<Record<CassetteSource, ReadonlyArray<string>>>

/**
 * Resolve one source's roots from the environment.
 *
 * Precedence matches `layerTranscriptDirectories`: an `LCC_*` variable that is
 * set *and* non-empty wins; anything else falls back to the platform default.
 */
function rootsOf(descriptor: SourceDescriptor): ReadonlyArray<string> {
  const raw = process.env[descriptor.envVar]
  if (!raw || raw.length === 0) return descriptor.defaultRoots()
  const configured = descriptor.listValued ? raw.split(delimiter).filter(Boolean) : [raw]
  return configured.length ? configured : descriptor.defaultRoots()
}

export function resolveRoots(): ResolvedRoots {
  return Object.fromEntries(
    CASSETTE_SOURCES.map(source => [source, rootsOf(SOURCES[source])]),
  ) as ResolvedRoots
}

/** Claude Code's project-directory slug rule, mirrored from `project.ts`. */
export function projectSlug(cwd: string): string {
  return cwd.replaceAll(/[^a-zA-Z0-9_-]/g, '-')
}
