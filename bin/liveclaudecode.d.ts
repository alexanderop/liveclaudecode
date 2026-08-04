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
  /** Launch the Electron desktop shell instead of a server plus browser tab. */
  desktop: boolean
  /** Whether `port` came from the command line rather than the default. */
  portExplicit: boolean
  version?: boolean
  help?: boolean
}

export function parseArguments(argv: ReadonlyArray<string>): CliOptions

export function main(argv?: ReadonlyArray<string>): void
