/**
 * Materialize the cassette capture sandbox.
 *
 * `docs/cassette-scenarios.md` requires every committed cassette to be recorded
 * from a session run against *this* tree, so that the free text a cassette
 * carries is disposable by construction rather than by scrubbing. Generating it
 * from a script — rather than committing it, or hosting it — keeps the sandbox
 * reproducible byte for byte without adding a repository to maintain.
 *
 *   pnpm cassette:sandbox [--into <directory>]
 *
 * Prints the sandbox path on stdout and nothing else, so a capture session can
 * do `SANDBOX=$(pnpm --silent cassette:sandbox)`.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArguments, runScript } from './args.ts'

const USAGE = `Usage:
  pnpm cassette:sandbox [--into <directory>] [--force]

--into writes into a named directory instead of a fresh temp one; --force
empties it first. Prints the sandbox path on stdout and nothing else.`

/**
 * The sandbox is a five-file package with one real defect: `invoiceTotal`
 * rounds a float that binary floating point has already nudged below the
 * halfway point, so a 1.005 line total renders as 1.00. It is small enough to
 * read in a minute and deep enough that an agent has to read, run, edit, and
 * re-run — which is what makes the resulting transcript worth recording.
 */
const FILES: Readonly<Record<string, string>> = {
  'package.json': `{
  "name": "invoice-sandbox",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "Capture sandbox for liveclaudecode transcript cassettes",
  "scripts": {
    "test": "node --test test/invoice.test.ts"
  }
}
`,

  'README.md': `# invoice-sandbox

A deliberately tiny package used to capture transcript cassettes for
liveclaudecode. See \`docs/cassette-scenarios.md\` in that repository.

## What it does

\`invoiceTotal\` sums line items and returns a US-dollar amount rounded to
cents.

\`\`\`ts
import { invoiceTotal } from './src/invoice.ts'

invoiceTotal([{ description: 'Consulting', unitPriceUsd: 120, quantity: 2 }])
// => 240
\`\`\`

## Running the tests

\`\`\`sh
npm test
\`\`\`

One test currently fails. That is intentional — it is the work a capture
session is asked to do.
`,

  'src/format.ts': `/** Render a US-dollar amount with exactly two decimal places. */
export function formatUsd(amount: number): string {
  return \`$\${amount.toFixed(2)}\`
}

/** Render a line item as one aligned row of an invoice. */
export function formatLine(description: string, amount: number): string {
  return \`\${description.padEnd(24, ' ')}\${formatUsd(amount).padStart(12, ' ')}\`
}
`,

  'src/invoice.ts': `import { formatLine, formatUsd } from './format.ts'

export interface LineItem {
  description: string
  unitPriceUsd: number
  quantity: number
}

/** The undiscounted amount for one line. */
export function lineTotal(item: LineItem): number {
  return item.unitPriceUsd * item.quantity
}

/**
 * The invoice total, in dollars, rounded to cents.
 *
 * BUG: multiplying by 100 before rounding inherits the binary floating-point
 * representation error, so a total of 1.005 becomes 100.49999999999999 and
 * rounds down to 1.00 instead of 1.01.
 */
export function invoiceTotal(items: readonly LineItem[]): number {
  const raw = items.reduce((sum, item) => sum + lineTotal(item), 0)
  return Math.round(raw * 100) / 100
}

/** The whole invoice as plain text, one line per item plus a total row. */
export function renderInvoice(items: readonly LineItem[]): string {
  const rows = items.map(item => formatLine(item.description, lineTotal(item)))
  return [...rows, formatLine('Total', invoiceTotal(items))].join('\\n')
}

export { formatUsd }
`,

  'test/invoice.test.ts': `import assert from 'node:assert/strict'
import { test } from 'node:test'
import { invoiceTotal, lineTotal, renderInvoice } from '../src/invoice.ts'

test('lineTotal multiplies unit price by quantity', () => {
  assert.equal(lineTotal({ description: 'Consulting', unitPriceUsd: 120, quantity: 2 }), 240)
})

test('invoiceTotal sums whole-dollar line items', () => {
  assert.equal(invoiceTotal([
    { description: 'Consulting', unitPriceUsd: 120, quantity: 2 },
    { description: 'Support', unitPriceUsd: 40, quantity: 1 },
  ]), 280)
})

test('invoiceTotal rounds a half cent up', () => {
  assert.equal(invoiceTotal([
    { description: 'Metered usage', unitPriceUsd: 1.005, quantity: 1 },
  ]), 1.01)
})

test('renderInvoice ends with a total row', () => {
  const rendered = renderInvoice([
    { description: 'Consulting', unitPriceUsd: 120, quantity: 2 },
  ])
  assert.match(rendered.split('\\n').at(-1) ?? '', /^Total\\s+\\$240\\.00$/)
})
`,
}

function writeSandbox(directory: string): void {
  for (const [relative, content] of Object.entries(FILES)) {
    const path = join(directory, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }

  // A git repository, because every one of the four tools reports `gitBranch`
  // (or its equivalent) and a capture without one leaves that field untested.
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: directory, stdio: 'pipe' })
  git('init', '--quiet', '--initial-branch', 'main')
  git('add', '.')
  git(
    '-c', 'user.name=Sandbox',
    '-c', 'user.email=sandbox@example.invalid',
    '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '--message', 'Initial sandbox',
  )
}

await runScript(USAGE, () => {
  const { options } = parseArguments(process.argv.slice(2), {
    string: ['into'],
    boolean: ['force'],
  })

  const into = typeof options.into === 'string' ? options.into : ''
  const target = into ? resolve(into) : mkdtempSync(join(tmpdir(), 'lcc-cassette-sandbox-'))

  if (into) {
    if (options.force === true) rmSync(target, { recursive: true, force: true })
    mkdirSync(target, { recursive: true })
  }

  writeSandbox(target)
  process.stdout.write(`${target}\n`)
})
