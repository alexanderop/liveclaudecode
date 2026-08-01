import { assert, describe, it } from '@effect/vitest'
import { mergeAgentFileChanges, splitPath } from '~/utils/file-changes'

describe('mergeAgentFileChanges', () => {
  it('folds patch changes into the touched files and sorts by operations', () => {
    const merged = mergeAgentFileChanges(
      [
        { path: 'app/a.ts', ops: 1 },
        { path: 'app/b.ts', ops: 1 },
      ],
      [
        { path: 'app/b.ts', linesAdded: 12, linesRemoved: 3 },
        { path: 'app/b.ts', linesAdded: 2, linesRemoved: 0 },
        { path: 'app/new.ts', linesAdded: 5, linesRemoved: 1 },
      ],
    )

    assert.deepStrictEqual(merged, [
      { path: 'app/b.ts', ops: 3, added: 14, removed: 3 },
      { path: 'app/a.ts', ops: 1, added: 0, removed: 0 },
      { path: 'app/new.ts', ops: 1, added: 5, removed: 1 },
    ])
  })

  it('returns an empty list for an agent without file activity', () => {
    assert.deepStrictEqual(mergeAgentFileChanges([], []), [])
  })
})

describe('splitPath', () => {
  it('splits nested paths into name and directory', () => {
    assert.deepStrictEqual(splitPath('app/components/Dashboard.vue'), {
      name: 'Dashboard.vue',
      directory: 'app/components',
    })
  })

  it('labels top-level files as repository root', () => {
    assert.deepStrictEqual(splitPath('README.md'), {
      name: 'README.md',
      directory: 'Repository root',
    })
  })
})
