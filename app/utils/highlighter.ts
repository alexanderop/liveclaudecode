import type { HighlighterCore, LanguageInput, ShikiTransformer } from '@shikijs/core'
import { PLAIN_LANGUAGE, resolveLanguage } from './code-language'

/**
 * Grammar loaders for the fine-grained bundle. Each entry is its own async
 * chunk, so a session that only ever shows TypeScript never downloads the Rust
 * or SQL grammars. Keep the keys in sync with `BUNDLED_LANGUAGES`.
 */
const LANGUAGE_LOADERS: Readonly<Record<string, LanguageInput>> = {
  css: () => import('@shikijs/langs/css'),
  diff: () => import('@shikijs/langs/diff'),
  go: () => import('@shikijs/langs/go'),
  html: () => import('@shikijs/langs/html'),
  javascript: () => import('@shikijs/langs/javascript'),
  json: () => import('@shikijs/langs/json'),
  jsx: () => import('@shikijs/langs/jsx'),
  markdown: () => import('@shikijs/langs/markdown'),
  python: () => import('@shikijs/langs/python'),
  rust: () => import('@shikijs/langs/rust'),
  shellscript: () => import('@shikijs/langs/shell'),
  sql: () => import('@shikijs/langs/sql'),
  toml: () => import('@shikijs/langs/toml'),
  tsx: () => import('@shikijs/langs/tsx'),
  typescript: () => import('@shikijs/langs/typescript'),
  vue: () => import('@shikijs/langs/vue'),
  yaml: () => import('@shikijs/langs/yaml'),
}

/**
 * Both themes are emitted into every token and selected by CSS `light-dark()`,
 * which the dashboard palette already drives through `color-scheme`. Toggling
 * the color mode therefore costs no re-highlighting.
 */
const THEMES = { light: 'github-light', dark: 'github-dark-default' } as const

/** In-flight grammar loads, so concurrent blocks in one language load once. */
const pendingLanguages = new Map<string, Promise<HighlighterCore>>()

/**
 * Shiki and its regex engine are imported dynamically so views without code —
 * the session list, the overview — never download them.
 *
 * The JavaScript regex engine keeps the dashboard free of the Oniguruma
 * WebAssembly payload; every built-in grammar is supported by it.
 */
async function baseHighlighter(): Promise<HighlighterCore> {
  const [{ getSingletonHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
    import('@shikijs/core'),
    import('@shikijs/engine-javascript'),
  ])

  return getSingletonHighlighterCore({
    engine: createJavaScriptRegexEngine(),
    themes: [import('@shikijs/themes/github-light'), import('@shikijs/themes/github-dark-default')],
    langs: [],
  })
}

/** Resolves a highlighter that has `language` loaded, or plain text if it has no grammar. */
async function highlighterFor(language: string): Promise<HighlighterCore> {
  const loader = LANGUAGE_LOADERS[language]
  if (!loader) return baseHighlighter()

  const pending = pendingLanguages.get(language)
  if (pending) return pending

  const load = baseHighlighter()
    .then(async (highlighter) => {
      await highlighter.loadLanguage(loader)
      return highlighter
    })
    .catch((error: unknown) => {
      // A grammar that fails to load must not take the surrounding view down;
      // the block falls back to plain text on the next render.
      pendingLanguages.delete(language)
      throw error
    })

  pendingLanguages.set(language, load)
  return load
}

export interface HighlightOptions {
  /** Fence language, extension, or Shiki id. Unknown values render as plain text. */
  language?: string
  /** 1-based line numbers to mark as added. */
  added?: readonly number[]
  /** 1-based line numbers to mark as removed. */
  removed?: readonly number[]
  /** 1-based line numbers to mark as highlighted, from a fence's `{1,3-5}` meta. */
  highlights?: readonly number[]
}

/**
 * Shiki writes the theme background onto the `<pre>` as an inline style, which
 * an external stylesheet cannot override. Dropping it lets the dashboard's own
 * code surface show through while keeping the theme's token colors.
 */
const dropBackground: ShikiTransformer = {
  name: 'liveclaudecode:drop-background',
  pre(node) {
    const style = node.properties.style
    if (typeof style === 'string') {
      node.properties.style = style.replace(/background-color:[^;]*;?/g, '')
    }
  },
}

function lineClassTransformer(options: HighlightOptions): ShikiTransformer | undefined {
  const lines = new Map<number, string[]>()
  const mark = (numbers: readonly number[] | undefined, className: string): void => {
    for (const line of numbers || []) {
      const classes = lines.get(line) || []
      classes.push(className)
      lines.set(line, classes)
    }
  }
  mark(options.added, 'line-add')
  mark(options.removed, 'line-remove')
  mark(options.highlights, 'line-highlight')

  if (!lines.size) return undefined
  return {
    name: 'liveclaudecode:line-classes',
    line(node, line) {
      const classes = lines.get(line)
      if (classes) this.addClassToHast(node, classes)
    },
  }
}

/**
 * Highlights `code` to HTML, resolving the grammar lazily.
 *
 * Rejects only if Shiki itself fails to initialize; an unknown or unloadable
 * language degrades to plain text rather than failing.
 */
export async function highlightCode(code: string, options: HighlightOptions = {}): Promise<string> {
  const language = resolveLanguage(options.language)
  const transformer = lineClassTransformer(options)

  let highlighter: HighlighterCore
  let resolved = language
  try {
    highlighter = await highlighterFor(language)
  } catch {
    highlighter = await baseHighlighter()
    resolved = PLAIN_LANGUAGE
  }

  return highlighter.codeToHtml(code, {
    lang: resolved,
    themes: THEMES,
    defaultColor: 'light-dark()',
    transformers: transformer ? [dropBackground, transformer] : [dropBackground],
  })
}
