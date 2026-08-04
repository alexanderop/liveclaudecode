/**
 * Route-coverage ledger for the e2e tier.
 *
 * `test/fixtures/api-client.ts` records every `/api/**` request an e2e spec
 * makes into a JSONL ledger. The Vitest global setup exported here clears that
 * ledger before the e2e tier runs, and `test/gate/route-coverage.spec.ts` —
 * which runs in a later `sequence.groupOrder` group, so after every e2e spec
 * has finished — asserts that no file under `server/api/` was left
 * unexercised. A new endpoint therefore cannot land without an e2e assertion.
 *
 * The ledger lives on disk rather than in a module-level `Set` because Vitest
 * isolates test files: a second e2e spec would otherwise get its own copy and
 * the gate would only ever see the last file to run.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ledgerPath = fileURLToPath(
  new URL('../../node_modules/.cache/liveclaudecode/route-coverage.jsonl', import.meta.url),
)
const apiDirectory = fileURLToPath(new URL('../../server/api', import.meta.url))

/** Nitro's method suffix on a route file, e.g. the `.get` of `tree.get.ts`. */
const METHOD_SUFFIX = /\.(get|post|put|patch|delete)\.ts$/

/**
 * The key both halves of the gate agree on, e.g. `GET /api/tree`. Query
 * strings are dropped; the method is part of the key so `chat.get.ts` and
 * `chat.post.ts` are counted separately.
 */
export function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path.split('?')[0]}`
}

/** Every route Nitro mounts from `server/api/**`, as route keys, sorted. */
export function declaredRoutes(): ReadonlyArray<string> {
  return readdirSync(apiDirectory, { recursive: true })
    .map(entry => String(entry).replaceAll('\\', '/'))
    .filter(name => name.endsWith('.ts'))
    .map(name => routeKey(
      METHOD_SUFFIX.exec(name)?.[1] ?? 'get',
      `/api/${name.replace(METHOD_SUFFIX, '').replace(/\.ts$/, '')}`,
    ))
    .sort()
}

/** Append one exercised route. Non-`/api` requests are not part of the gate. */
export function recordRoute(method: string, path: string): void {
  if (!path.startsWith('/api/')) return
  mkdirSync(dirname(ledgerPath), { recursive: true })
  appendFileSync(ledgerPath, `${routeKey(method, path)}\n`)
}

/**
 * Every route key the e2e tier has exercised, or `undefined` when the tier has
 * not run at all — which the gate reports differently from a genuine hole.
 */
export function exercisedRoutes(): ReadonlySet<string> | undefined {
  if (!existsSync(ledgerPath)) return undefined
  return new Set(readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean))
}

/**
 * Vitest `globalSetup` for the e2e project: start each run from an empty
 * ledger. The file is created rather than deleted so that its absence means
 * "the e2e tier never ran", not "the e2e tier hit nothing".
 */
export function setup(): void {
  mkdirSync(dirname(ledgerPath), { recursive: true })
  writeFileSync(ledgerPath, '')
}
