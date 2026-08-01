// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt(
  {
    // Vendored reference material and scratch clones are not lintable source.
    ignores: ['repos/**', 'tmp/**', 'docs/**'],
  },
  {
    rules: {
      // Effect idioms rely on `void` type arguments in call position
      // (e.g. `Deferred.make<void>()`); the rule has no allowance for that.
      '@typescript-eslint/no-invalid-void-type': 'off',
    },
  },
)
