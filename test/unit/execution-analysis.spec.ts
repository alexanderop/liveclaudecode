import { assert, describe, it } from '@effect/vitest'
import { analyzeCoordination } from '~/utils/execution-analysis'
import { runNode, runResponse } from '../fixtures/runs'

describe('execution coordination analysis', () => {
  it('detects shared files, duplicated commands, bottlenecks, and the critical path', () => {
    const sharedFile = {
      path: 'app/components/Canvas.vue',
      ops: 1,
      tools: ['Edit'],
      lastTs: '2026-07-25T18:01:00.000Z',
    }
    const children = ['a', 'b', 'c'].map((key, index) => runNode({
      key,
      sid: key,
      kind: 'subagent',
      label: `Agent ${key}`,
      parentAgentId: 'root',
      files: index < 2 ? [sharedFile] : [],
      commands: [{ cmd: 'pnpm test:unit', ts: '2026-07-25T18:01:00.000Z', ok: true, tid: key }],
      firstTs: `2026-07-25T18:0${index}:00.000Z`,
      lastTs: `2026-07-25T18:0${index + 2}:00.000Z`,
    }))
    const root = runNode({ key: 'root', sid: 'root', children })
    const analysis = analyzeCoordination(root, runResponse(), Date.parse('2026-07-25T18:10:00.000Z'))

    assert.strictEqual(analysis.findings.some(finding => finding.kind === 'file-collision'), true)
    assert.strictEqual(analysis.findings.some(finding => finding.kind === 'duplicate-work'), true)
    assert.strictEqual(analysis.findings.some(finding => finding.kind === 'bottleneck'), true)
    assert.strictEqual(analysis.findings.some(finding => finding.kind === 'critical-path'), true)
    assert.strictEqual(analysis.collisionKeys.has('a'), true)
    assert.strictEqual(analysis.collisionKeys.has('b'), true)
    assert.strictEqual(analysis.criticalPathKeys.has('root'), true)
  })
})
