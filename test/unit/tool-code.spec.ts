import { assert, describe, it } from '@effect/vitest'
import { toolCodePreview } from '~/utils/tool-code'

const payload = (value: unknown): string => JSON.stringify(value, null, 2)

describe('toolCodePreview', () => {
  it('reconstructs an edit as a diff in the edited file language', () => {
    const preview = toolCodePreview('Edit', payload({
      file_path: '/repo/app/utils/format.ts',
      old_string: 'const a = 1\nconst b = 2',
      new_string: 'const a = 1\nconst b = 3',
    }))

    assert.strictEqual(preview.language, 'typescript')
    assert.strictEqual(preview.path, '/repo/app/utils/format.ts')
    assert.strictEqual(preview.diff, true)
    assert.strictEqual(preview.code, 'const a = 1\nconst b = 2\nconst b = 3')
    assert.deepStrictEqual(preview.removed, [2])
    assert.deepStrictEqual(preview.added, [3])
  })

  it('accepts the snake-case keys used by str_replace style editors', () => {
    const preview = toolCodePreview('str_replace_editor', payload({
      path: 'main.py',
      old_str: 'x = 1',
      new_str: 'x = 2',
    }))

    assert.strictEqual(preview.language, 'python')
    assert.strictEqual(preview.diff, true)
    assert.deepStrictEqual(preview.removed, [1])
    assert.deepStrictEqual(preview.added, [2])
  })

  it('concatenates a MultiEdit into one diff separated by a blank line', () => {
    const preview = toolCodePreview('MultiEdit', payload({
      file_path: 'app.css',
      edits: [
        { old_string: 'a', new_string: 'b' },
        { old_string: 'c', new_string: 'd' },
      ],
    }))

    assert.strictEqual(preview.language, 'css')
    assert.strictEqual(preview.code, 'a\nb\n\nc\nd')
    assert.deepStrictEqual(preview.removed, [1, 4])
    assert.deepStrictEqual(preview.added, [2, 5])
  })

  it('shows a whole-file write as fully added content', () => {
    const preview = toolCodePreview('Write', payload({
      file_path: 'config.yaml',
      content: 'one: 1\ntwo: 2',
    }))

    assert.strictEqual(preview.language, 'yaml')
    assert.strictEqual(preview.code, 'one: 1\ntwo: 2')
    assert.deepStrictEqual(preview.added, [1, 2])
    assert.deepStrictEqual(preview.removed, [])
  })

  it('keeps non-editing tools as their JSON payload', () => {
    const input = payload({ command: 'pnpm test', description: 'Run tests' })
    const preview = toolCodePreview('Bash', input)

    assert.deepStrictEqual(preview, { language: 'json', code: input, added: [], removed: [], diff: false })
  })

  it('falls back to the raw text when the payload was clipped mid-string', () => {
    const clipped = payload({ file_path: 'a.ts', old_string: 'const a = 1' }).slice(0, 40)
    const preview = toolCodePreview('Edit', clipped)

    assert.strictEqual(preview.diff, false)
    assert.strictEqual(preview.language, 'json')
    assert.strictEqual(preview.code, clipped)
  })

  it('falls back for an empty payload', () => {
    assert.strictEqual(toolCodePreview('Edit', '').diff, false)
    assert.strictEqual(toolCodePreview(undefined, '   ').code, '   ')
  })

  it('falls back when an edit payload names no file', () => {
    const preview = toolCodePreview('Write', payload({ content: 'hello' }))

    assert.strictEqual(preview.diff, false)
    assert.strictEqual(preview.language, 'json')
  })

  it('uses plain text for a file with no bundled grammar', () => {
    const preview = toolCodePreview('Edit', payload({
      file_path: 'notes.xyz',
      old_string: 'a',
      new_string: 'b',
    }))

    assert.strictEqual(preview.language, 'text')
    assert.strictEqual(preview.diff, true)
  })
})
