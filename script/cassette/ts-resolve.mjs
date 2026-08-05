/**
 * Module resolution for the cassette scripts.
 *
 * `bless.ts` and `verify.ts` have to run the *real* scanners — a blessed
 * expectation computed by a reimplementation would assert nothing. That means
 * importing `server/utils/**` and `shared/schemas/**`, which are written for
 * Vite: extensionless relative specifiers, and the `#server` / `#shared`
 * aliases that `nuxt.config.ts` defines and `package.json` does not.
 *
 * Node resolves neither. Rather than add a TypeScript runner dependency, this
 * registers two synchronous resolution hooks that teach the bare runtime the
 * same two rules:
 *
 *   1. `#server/x` and `#shared/x` resolve against the repository root.
 *   2. A relative specifier with no extension resolves to `<specifier>.ts`,
 *      then `<specifier>/index.ts`.
 *
 * Type stripping itself is Node's; once a specifier ends in `.ts` the built-in
 * loader handles it. Nothing here affects how the application or the test
 * runner resolves anything — it is loaded only by the cassette scripts.
 */
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repositoryRoot = new URL('../../', import.meta.url)

const ALIASES = {
  '#server/': new URL('server/', repositoryRoot),
  '#shared/': new URL('shared/', repositoryRoot),
  '~~/': repositoryRoot,
}

const EXTENSION_CANDIDATES = ['.ts', '.mts', '/index.ts']

function firstExisting(base) {
  for (const suffix of EXTENSION_CANDIDATES) {
    const candidate = new URL(`${base.href}${suffix}`)
    if (existsSync(fileURLToPath(candidate))) return candidate
  }
  return undefined
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    for (const [prefix, base] of Object.entries(ALIASES)) {
      if (!specifier.startsWith(prefix)) continue
      const target = new URL(specifier.slice(prefix.length), base)
      const resolved = existsSync(fileURLToPath(target)) ? target : firstExisting(target)
      if (resolved) return { url: resolved.href, shortCircuit: true }
    }

    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const parent = context.parentURL ? new URL(context.parentURL) : pathToFileURL(`${process.cwd()}/`)
      const target = new URL(specifier, parent)
      if (!existsSync(fileURLToPath(target))) {
        const resolved = firstExisting(target)
        if (resolved) return { url: resolved.href, shortCircuit: true }
      }
    }

    return nextResolve(specifier, context)
  },
})
