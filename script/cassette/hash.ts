/**
 * The one content hash a cassette is identified by.
 *
 * The recorder computes it and `verify.ts` re-checks it, which is exactly the
 * pair that must never disagree: two spellings of "sha256 of the file" would
 * let a cassette pass the integrity gate it was never actually hashed for.
 */
import { createHash } from 'node:crypto'

export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}
