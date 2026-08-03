/**
 * Language identifiers for the dashboard's fine-grained Shiki bundle.
 *
 * The highlighter loads grammars one by one rather than pulling in a bundle
 * preset, so anything not listed here has no grammar at runtime and must
 * degrade to plain text instead of throwing.
 */
export const BUNDLED_LANGUAGES = [
  'css',
  'diff',
  'go',
  'html',
  'javascript',
  'json',
  'jsx',
  'markdown',
  'python',
  'rust',
  'shellscript',
  'sql',
  'toml',
  'tsx',
  'typescript',
  'vue',
  'yaml',
] as const

/**
 * Languages Shiki resolves without a grammar: `text` renders unstyled and
 * `ansi` decodes terminal escape codes.
 */
export const SPECIAL_LANGUAGES = ['ansi', 'text'] as const

/** Fallback used whenever a language cannot be resolved to a loaded grammar. */
export const PLAIN_LANGUAGE = 'text'

const SUPPORTED = new Set<string>([...BUNDLED_LANGUAGES, ...SPECIAL_LANGUAGES])

/**
 * Names that reach a loaded grammar under a different id. Shiki registers its
 * own aliases (`ts`, `yml`, `bash`, …), but resolution has to happen before the
 * highlighter is awaited, so the mapping is duplicated here.
 */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  bash: 'shellscript',
  cjs: 'javascript',
  console: 'shellscript',
  cts: 'typescript',
  golang: 'go',
  htm: 'html',
  js: 'javascript',
  json5: 'json',
  jsonc: 'json',
  jsonl: 'json',
  md: 'markdown',
  mdc: 'markdown',
  mjs: 'javascript',
  mts: 'typescript',
  patch: 'diff',
  plaintext: 'text',
  py: 'python',
  rs: 'rust',
  sh: 'shellscript',
  'shell-session': 'shellscript',
  shell: 'shellscript',
  ts: 'typescript',
  txt: 'text',
  yml: 'yaml',
  zsh: 'shellscript',
}

/** Extensionless filenames that still have a useful grammar. */
const FILENAME_LANGUAGES: Readonly<Record<string, string>> = {
  '.bashrc': 'shellscript',
  '.zshrc': 'shellscript',
  dockerfile: 'text',
  gemfile: 'text',
  makefile: 'text',
}

/**
 * Resolve a fence info string or extension to a language with a loaded grammar,
 * falling back to {@link PLAIN_LANGUAGE}.
 */
export function resolveLanguage(raw: string | undefined | null): string {
  const name = (raw || '').trim().toLowerCase()
  if (!name) return PLAIN_LANGUAGE

  const resolved = LANGUAGE_ALIASES[name] || name
  return SUPPORTED.has(resolved) ? resolved : PLAIN_LANGUAGE
}

/**
 * Resolve the language of a file path by extension. Paths may be absolute,
 * repo-relative, or Windows-style; only the final segment is inspected.
 */
export function languageForPath(path: string | undefined | null): string {
  const segments = (path || '').split(/[/\\]/)
  const name = (segments[segments.length - 1] || '').trim().toLowerCase()
  if (!name) return PLAIN_LANGUAGE

  const known = FILENAME_LANGUAGES[name]
  if (known) return known

  const dot = name.lastIndexOf('.')
  // A leading dot marks a dotfile (`.gitignore`), not an extension.
  if (dot <= 0) return PLAIN_LANGUAGE

  return resolveLanguage(name.slice(dot + 1))
}
