/**
 * Recording replacements for `$fetch` and `fetch` from `@nuxt/test-utils/e2e`.
 *
 * They behave exactly like the originals and additionally note which
 * `server/api` route each call hit, which is what the route-coverage gate in
 * `test/fixtures/route-coverage.ts` reads. E2e specs should import from here
 * rather than from `@nuxt/test-utils/e2e` so the bookkeeping stays automatic.
 */
import { $fetch as nuxtJsonFetch, fetch as nuxtFetch } from '@nuxt/test-utils/e2e'
import { recordRoute } from './route-coverage'

type JsonFetchOptions = Parameters<typeof nuxtJsonFetch>[1]

/** `$fetch`, with the requested route recorded for the coverage gate. */
export function $fetch<T>(request: string, options?: JsonFetchOptions): Promise<T> {
  recordRoute(options?.method ?? 'GET', request)
  return nuxtJsonFetch<T>(request, options)
}

/** `fetch`, with the requested route recorded for the coverage gate. */
export function fetch(path: string, options?: RequestInit): Promise<Response> {
  recordRoute(options?.method ?? 'GET', path)
  return nuxtFetch(path, options)
}
