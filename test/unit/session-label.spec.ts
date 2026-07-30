import { assert, describe, it } from '@effect/vitest'
import { normalizeSessionLabel, normalizeSessionSummary } from '#shared/utils/session-label'

describe('session label normalization', () => {
  it('removes injected plugin and environment context before keeping the user intent', () => {
    const label = normalizeSessionLabel(`
      <recommended_plugins>- Slack - Figma</recommended_plugins>
      <environment_context><cwd>/private/repo</cwd></environment_context>
      Implement the multi-agent debugging canvas
    `)

    assert.strictEqual(label, 'Implement the multi-agent debugging canvas')
  })

  it('uses the fallback when context contains no user intent', () => {
    assert.strictEqual(
      normalizeSessionLabel('<recommended_plugins>- Slack</recommended_plugins>', 'abc123'),
      'abc123',
    )
  })

  it('removes attachment metadata and internal UI directives from summaries', () => {
    assert.strictEqual(
      normalizeSessionSummary(`
        # Files mentioned by the user:
        ## screenshot.png: /var/folders/example/screenshot.png
        The dashboard is ready for review. ::codex-inline-vis{file="preview.html"}
      `),
      'The dashboard is ready for review.',
    )
  })
})
