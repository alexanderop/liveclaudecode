/**
 * Hand-written declarations for the extensionless `bin/liveclaudecode` Node
 * launcher so test code can import `parseArguments` with types. Keep in sync
 * with the implementation next to this file.
 */

export interface CliOptions {
  project: string
  port: number
  host: string
  hours: number
  open: boolean
  version?: boolean
  help?: boolean
}

export function parseArguments(argv: ReadonlyArray<string>): CliOptions

export function main(argv?: ReadonlyArray<string>): void
