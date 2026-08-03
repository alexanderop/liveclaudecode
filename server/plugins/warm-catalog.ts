import { defaultBrowserOptions } from '../utils/request-context'
import { runBackground } from '../utils/runtime'
import { loadSessionCatalog } from '../utils/session-catalog'

/**
 * Build the default catalog once at startup, before anyone asks for it.
 *
 * A cold catalog build reads and parses every transcript in range, and it is
 * the whole of a first page load's wait — the browser is still fetching its
 * bundle while the server sits idle with the work it is about to be asked for.
 * Starting here overlaps the two: the CLI spawns this process and prints (or
 * opens) the URL immediately, so by the time the dashboard's first request
 * lands it either joins this build in flight or finds the transcript scans
 * already parsed and only has to stat them for changes.
 *
 * Deliberately fire-and-forget. Nothing waits on it, a failure cannot fail a
 * request that has not happened yet, and the next real request rebuilds from
 * scratch anyway.
 */
export default defineNitroPlugin(() => {
  const { project, hours } = defaultBrowserOptions()
  runBackground('catalog warm-up', loadSessionCatalog(project, hours))
})
