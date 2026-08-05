import { assert, describe, it } from '@effect/vitest'
import { allCassettes, type Cassette } from '../fixtures/cassette'
import { sourceForPath } from '../fixtures/cassette-projection'
import {
  chunksForFile,
  collectEnvironmentSecrets,
  ENTROPY_THRESHOLD_BITS,
  formatResidueHits,
  type NamedSecret,
  type ScanChunk,
  scanChunks,
  shannonEntropy,
} from '../cassettes/redaction/scanners'

/**
 * Gate 2 — hygiene.
 *
 * The recorder runs these scanners before it writes, which is the fast
 * feedback. *This* is the guarantee: it runs them over every committed
 * cassette byte, so a hand-edited or hand-constructed cassette cannot get in by
 * never going through the recorder.
 *
 * Note what this proves on CI versus locally. The environment detector finds
 * the *running* machine's identity, so on a CI runner it proves nothing about
 * the machine a cassette was recorded on — there, the pattern detectors
 * (credential shapes, emails, entropy, home-rooted paths) carry the weight. On
 * a maintainer's machine it also catches the case the patterns cannot: their
 * own username or hostname surviving into a cassette they are about to commit.
 */

const cassettes = allCassettes()

/**
 * Manifest values worth scanning, minus the ones that are opaque by
 * construction. A sha256 is 64 hex characters of maximal entropy; including it
 * would mean every cassette fails the entropy detector on its own hashes.
 */
const OPAQUE_MANIFEST_KEYS = new Set(['sha256'])

function* manifestChunks(cassette: Cassette): Generator<ScanChunk> {
  const walk = function* (value: unknown, path: string): Generator<ScanChunk> {
    if (typeof value === 'string') {
      yield { label: `cassette.json ${path}`, text: value, keyClass: 'scrub' }
      return
    }
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) yield* walk(item, `${path}[${index}]`)
      return
    }
    if (value && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        if (OPAQUE_MANIFEST_KEYS.has(key)) continue
        yield* walk(nested, path ? `${path}.${key}` : key)
      }
    }
  }
  yield* walk(cassette.manifest, '')
}

/** Streamed rather than collected: a cassette is tens of thousands of chunks. */
function* chunksFor(cassette: Cassette): Generator<ScanChunk> {
  yield* manifestChunks(cassette)
  for (const [path, content] of cassette.files) {
    yield* chunksForFile(sourceForPath(path), path, content)
  }
}

describe('cassette hygiene', () => {
  // Collected once: `git config` shells out, and the answer cannot change
  // between cases in one run.
  const secrets: readonly NamedSecret[] = collectEnvironmentSecrets()

  it('has cassettes to scan', () => {
    // Without this, a repository that lost `test/cassettes` would report a
    // clean hygiene run — the most reassuring possible way to prove nothing.
    assert.ok(
      cassettes.length > 0,
      'No cassettes found. See docs/cassette-scenarios.md to record one.',
    )
  })

  for (const cassette of cassettes) {
    it(`${cassette.id} contains no residue`, () => {
      const hits = scanChunks(chunksFor(cassette), secrets)
      assert.deepStrictEqual(
        hits,
        [],
        `Residue in ${cassette.id}:\n${formatResidueHits(hits)}\n\n`
        + 'Cassettes are never hand-edited. Re-record this one, and if the recorder '
        + 'lets the value through, extend test/cassettes/redaction/rules.ts first.',
      )
    })
  }

  it('separates opaque model state from ordinary identifiers by entropy', () => {
    // A detector nobody tests is a detector a refactor can silently break, and
    // this one is the last line against a secret shape nobody enumerated. The
    // two ends are taken from a real capture: encrypted reasoning state on one
    // side, a UUID and a camelCase key on the other.
    const opaque = 'ErcCCokBCBAYAipACY7HqZmDIAY0Sj0RmS6gmXy7ikGflt7f0moIWYlLs1AKHfk7'
    assert.ok(shannonEntropy(opaque) > ENTROPY_THRESHOLD_BITS)
    assert.ok(shannonEntropy('f3fde044-e8ba-40d3-9f18-fa96795c261e') < ENTROPY_THRESHOLD_BITS)
    assert.ok(shannonEntropy('supportedNativeDocumentMimeTypes') < ENTROPY_THRESHOLD_BITS)
  })

  it('does not flag a UUID, a git SHA, or a pseudonymized path', () => {
    // The false positives that made the first calibration unusable. Each is a
    // shape a real cassette carries on nearly every line.
    const hits = scanChunks([
      { label: 'probe', text: 'f3fde044-e8ba-40d3-9f18-fa96795c261e', keyClass: 'scrub' },
      { label: 'probe', text: 'c8a1b4e2d9f60371a5c8e2b7d4f10396a7b2c81b', keyClass: 'scrub' },
      { label: 'probe', text: '/Users/user-1/Projects/invoice-sandbox/src/invoice.ts', keyClass: 'scrub' },
      { label: 'probe', text: 'supportedNativeDocumentMimeTypes', keyClass: 'pseudonymize', kind: 'key' },
    ], [])

    assert.deepStrictEqual(hits, [])
  })

  it('flags a leaked home-rooted path and a credential shape', () => {
    const hits = scanChunks([
      { label: 'probe', text: '/Users/realname/Projects/secret', keyClass: 'scrub' },
      { label: 'probe', text: 'export TOKEN=ghp_abcdefghijklmnopqrstuvwxyz01', keyClass: 'scrub' },
      { label: 'probe', text: 'mail me at person@example.com', keyClass: 'scrub' },
    ], [])

    // The token trips both the shape detector and the entropy backstop, which
    // is the intent: overlapping detectors are how an unrecognised credential
    // shape still gets caught.
    assert.deepStrictEqual(
      [...new Set(hits.map(hit => hit.scanner))].sort(),
      ['credential', 'email', 'entropy', 'path'],
    )
  })

  it('flags the operator\'s own configuration even under a pseudonymized home', () => {
    // The leak this detector was written for. Pseudonymizing the user segment
    // is not enough: `/Users/user-1/.claude/rules/agent-browser.md` names
    // nobody and still publishes what the operator has installed, and it
    // arrives without the session ever opening it — VS Code attaches every
    // applicable instruction file to each chat request.
    const hits = scanChunks([
      { label: 'probe', text: '/Users/user-1/.claude/rules/agent-browser.md', keyClass: 'scrub' },
      { label: 'probe', text: 'file:///Users/user-1/.codex/skills/deploy.md', keyClass: 'pseudonymize' },
    ], [])

    assert.deepStrictEqual(hits.map(hit => hit.scanner), ['home-config', 'home-config'])
  })

  it('accepts the pseudonym config directory and a plain home-rooted file', () => {
    const hits = scanChunks([
      { label: 'probe', text: '/Users/user-1/.agent-config/file-2.md', keyClass: 'scrub' },
      // No dot-directory: an ordinary file in the pseudonym home is not an
      // inventory of anything.
      { label: 'probe', text: '/Users/user-1/notes.md', keyClass: 'scrub' },
    ], [])

    assert.deepStrictEqual(hits, [])
  })

  it('flags a deep temp path but not a shallow one', () => {
    // Depth, not presence: a session writing `/tmp/probe.mjs` is doing ordinary
    // work, while three or more segments below a temp root is the capture
    // machine's directory layout.
    const deep = scanChunks([{
      label: 'probe',
      text: '/private/tmp/runner-501/-Users-x-Projects-y/scratchpad/sandbox/src/a.ts',
      keyClass: 'scrub',
    }], [])
    const shallow = scanChunks([
      { label: 'probe', text: '/tmp/probe.mjs', keyClass: 'scrub' },
    ], [])

    assert.deepStrictEqual(deep.map(hit => hit.scanner), ['temp-path'])
    assert.deepStrictEqual(shallow, [])
  })

  it('leaves a pseudonymized path and a preserved opaque id alone', () => {
    const hits = scanChunks([
      { label: 'probe', text: '/Users/user-1/Projects/repo-1/src/invoice.ts', keyClass: 'pseudonymize' },
      { label: 'probe', text: 'user-1@example.invalid', keyClass: 'scrub' },
      // A message id is high-entropy and expected; `preserve` is what exempts it.
      { label: 'probe', text: 'msg_01Zk3qP9vX2mLr8TnB6wYc4JdF1sHgA5eU', keyClass: 'preserve' },
    ], [])

    assert.deepStrictEqual(hits, [])
  })
})
