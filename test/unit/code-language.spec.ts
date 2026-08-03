import { assert, describe, it } from '@effect/vitest'
import { languageForPath, PLAIN_LANGUAGE, resolveLanguage } from '~/utils/code-language'

describe('resolveLanguage', () => {
  it('passes through languages with a bundled grammar', () => {
    assert.strictEqual(resolveLanguage('typescript'), 'typescript')
    assert.strictEqual(resolveLanguage('json'), 'json')
  })

  it('maps aliases onto the grammar that serves them', () => {
    assert.strictEqual(resolveLanguage('ts'), 'typescript')
    assert.strictEqual(resolveLanguage('bash'), 'shellscript')
    assert.strictEqual(resolveLanguage('zsh'), 'shellscript')
    assert.strictEqual(resolveLanguage('yml'), 'yaml')
    assert.strictEqual(resolveLanguage('patch'), 'diff')
  })

  it('normalizes surrounding whitespace and casing', () => {
    assert.strictEqual(resolveLanguage('  TypeScript '), 'typescript')
  })

  it('keeps the special languages Shiki resolves without a grammar', () => {
    assert.strictEqual(resolveLanguage('ansi'), 'ansi')
    assert.strictEqual(resolveLanguage('text'), 'text')
  })

  it('falls back to plain text for unknown, empty, and missing languages', () => {
    assert.strictEqual(resolveLanguage('brainfuck'), PLAIN_LANGUAGE)
    assert.strictEqual(resolveLanguage(''), PLAIN_LANGUAGE)
    assert.strictEqual(resolveLanguage(undefined), PLAIN_LANGUAGE)
    assert.strictEqual(resolveLanguage(null), PLAIN_LANGUAGE)
  })
})

describe('languageForPath', () => {
  it('resolves by extension regardless of path depth or separator', () => {
    assert.strictEqual(languageForPath('app/utils/format.ts'), 'typescript')
    assert.strictEqual(languageForPath('/Users/me/project/main.go'), 'go')
    assert.strictEqual(languageForPath('C:\\src\\app.py'), 'python')
    assert.strictEqual(languageForPath('style.CSS'), 'css')
  })

  it('recognizes extensionless files that still have a grammar', () => {
    assert.strictEqual(languageForPath('scripts/.bashrc'), 'shellscript')
  })

  it('treats a leading dot as a dotfile rather than an extension', () => {
    assert.strictEqual(languageForPath('.gitignore'), PLAIN_LANGUAGE)
  })

  it('falls back to plain text for unknown extensions and empty paths', () => {
    assert.strictEqual(languageForPath('notes/todo.xyz'), PLAIN_LANGUAGE)
    assert.strictEqual(languageForPath('LICENSE'), PLAIN_LANGUAGE)
    assert.strictEqual(languageForPath(''), PLAIN_LANGUAGE)
    assert.strictEqual(languageForPath(undefined), PLAIN_LANGUAGE)
  })
})
