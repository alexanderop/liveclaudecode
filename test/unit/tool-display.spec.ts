import { assert, describe, it } from '@effect/vitest'
import { toolUseIcon, toolUseLabel } from '~/utils/tool-display'

describe('tool display', () => {
  it('labels well-known tools and falls back to the raw tool name', () => {
    assert.strictEqual(toolUseLabel('Bash'), 'Ran command')
    assert.strictEqual(toolUseLabel('Task'), 'Delegated work')
    assert.strictEqual(toolUseLabel('MyCustomTool'), 'MyCustomTool')
    assert.strictEqual(toolUseLabel(undefined), 'Used tool')
  })

  it('maps well-known tools to icons and falls back to a generic wrench', () => {
    assert.strictEqual(toolUseIcon('Edit'), 'i-lucide-file-pen-line')
    assert.strictEqual(toolUseIcon('WebFetch'), 'i-lucide-globe-2')
    assert.strictEqual(toolUseIcon('MyCustomTool'), 'i-lucide-wrench')
    assert.strictEqual(toolUseIcon(undefined), 'i-lucide-wrench')
  })
})
