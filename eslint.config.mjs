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
  {
    files: ['app/**/*.{ts,vue}', 'shared/**/*.ts', 'test/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            // `group` matches with gitignore semantics, where a directory
            // prefix also matches everything under it — the barrel has to be
            // pinned with an anchored regex or it bans the deep paths too.
            regex: '^effect/unstable/reactivity$',
            message: 'Deep-import instead, e.g. effect/unstable/reactivity/Atom. The barrel drags in AtomHttpApi, AtomRpc, Hydration and Reactivity for ~20KB gz extra.',
          },
          {
            group: [
              'effect/unstable/reactivity/AtomHttpApi',
              'effect/unstable/reactivity/AtomRpc',
            ],
            message: '+60KB gz, and both convert HttpClientError and SchemaError into defects. This app talks to its own /api/** through app/api/api.ts.',
          },
        ],
        paths: [
          {
            // The package index re-exports AtomHttpApi and AtomRpc
            // (repos/effect/packages/atom/vue/src/index.ts:37-47), so banning
            // the deep paths alone leaves a hole. Allowlist instead.
            name: '@effect/atom-vue',
            allowImportNames: [
              'useAtom',
              'useAtomValue',
              'useAtomSet',
              'useAtomRef',
              'registryKey',
              'injectRegistry',
            ],
            message: 'Only the composables and the registry key come from @effect/atom-vue. Atom constructors come from the deep path: effect/unstable/reactivity/Atom.',
          },
        ],
      }],
    },
  },
  {
    files: ['app/atoms/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: 'MemberExpression[property.name=/^(withRefresh|debounce|swr|searchParam)$/]',
        message: 'Banned: these schedule a raw setTimeout and read Date.now() (Atom.ts withRefresh/debounce/swr, searchParam), so TestClock cannot control them. Model recurring work as Stream.tick inside runtime.atom — see app/atoms/feed.ts.',
      }],
    },
  },
  {
    files: ['app/**/*.vue'],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: 'MemberExpression[object.name="Effect"]',
        message: 'Components stay plain Vue. Effect belongs in app/api/** and app/atoms/**.',
      }, {
        selector: 'MemberExpression[object.name="Layer"]',
        message: 'Components stay plain Vue. Layers belong in app/api/** and app/atoms/**.',
      }, {
        selector: 'CallExpression[callee.name="$fetch"]',
        message: 'Data fetching belongs in app/api/api.ts behind the Api service, read through an atom.',
      }],
    },
  },
)
