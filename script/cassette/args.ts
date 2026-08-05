/**
 * Argument parsing for the cassette scripts.
 *
 * A thin shape over `node:util`'s `parseArgs` that returns plainly-typed
 * options instead of `parseArgs`'s index signature, and fails with a usage
 * message rather than a stack trace — these are operator tools, and the
 * operator is usually mid-capture when they get an argument wrong.
 */
import { parseArgs } from 'node:util'

export interface ArgumentSpec {
  /** Options that take a value, e.g. `--source claude`. */
  readonly string?: readonly string[]
  /** Flags, e.g. `--keep-repo-name`. */
  readonly boolean?: readonly string[]
}

export interface ParsedArguments {
  readonly options: Readonly<Record<string, string | boolean | undefined>>
  readonly positionals: readonly string[]
}

export class UsageError extends Error {}

export function parseArguments(argv: readonly string[], spec: ArgumentSpec): ParsedArguments {
  const config = Object.fromEntries([
    ...(spec.string ?? []).map(name => [name, { type: 'string' as const }]),
    ...(spec.boolean ?? []).map(name => [name, { type: 'boolean' as const }]),
  ])

  let parsed
  try {
    parsed = parseArgs({ args: [...argv], options: config, allowPositionals: true, strict: true })
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }

  // `parseArgs` types its result from a *literal* option config; ours is built
  // at runtime, so the inferred type is a union with no index signature.
  // Rebuilding the record narrows it without a cast, and drops the repeatable
  // array form this tool never declares.
  const options: Record<string, string | boolean | undefined> = {}
  for (const [key, value] of Object.entries(parsed.values)) {
    if (typeof value === 'string' || typeof value === 'boolean') options[key] = value
  }

  return { options, positionals: parsed.positionals }
}

/**
 * Run a script body, reporting a `UsageError` as a one-line message and
 * anything else as itself. Exits non-zero on failure so `pnpm check` and a
 * capture shell both see it.
 */
export async function runScript(usage: string, body: () => Promise<void> | void): Promise<void> {
  try {
    await body()
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${usage}\n`)
      process.exitCode = 2
      return
    }
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    process.exitCode = 1
  }
}

/**
 * A required string option, narrowed.
 *
 * Requiredness is enforced at the point of use rather than declared in the
 * spec: one mechanism, and the check that fails is the one that also produces
 * the `string` the caller goes on to use.
 */
export function requiredString(
  options: ParsedArguments['options'],
  name: string,
): string {
  const value = options[name]
  if (typeof value !== 'string' || value === '') {
    throw new UsageError(`Missing required option --${name}`)
  }
  return value
}

/** An optional positive integer option with a default. */
export function integerOption(
  options: ParsedArguments['options'],
  name: string,
  fallback: number,
): number {
  const value = options[name]
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new UsageError(`--${name} must be a positive integer, got ${String(value)}`)
  }
  return parsed
}
