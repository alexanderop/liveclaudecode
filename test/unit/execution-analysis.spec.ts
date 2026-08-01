import { assert, describe, it } from '@effect/vitest'
import {
  analyzeCoordination,
  buildParentIndex,
  deepestLiveNode,
  findNode,
} from '~/utils/execution-analysis'
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

describe('buildParentIndex', () => {
  it('maps every descendant to its parent and leaves the root unmapped', () => {
    const leaf = runNode({ key: 'leaf' })
    const branch = runNode({ key: 'branch', children: [leaf] })
    const root = runNode({ key: 'root', children: [branch] })
    const parents = buildParentIndex(root)

    assert.strictEqual(parents.get('leaf')?.key, 'branch')
    assert.strictEqual(parents.get('branch')?.key, 'root')
    assert.strictEqual(parents.get('root'), undefined)
    assert.strictEqual(buildParentIndex(null).size, 0)
  })
})

describe('findNode', () => {
  it('finds the root itself and nested descendants by key', () => {
    const leaf = runNode({ key: 'leaf' })
    const root = runNode({ key: 'root', children: [runNode({ key: 'branch', children: [leaf] })] })

    assert.strictEqual(findNode(root, 'root'), root)
    assert.strictEqual(findNode(root, 'leaf'), leaf)
    assert.strictEqual(findNode(root, 'missing'), null)
    assert.strictEqual(findNode(null, 'root'), null)
    assert.strictEqual(findNode(root, null), null)
  })
})

describe('deepestLiveNode', () => {
  it('returns the node itself when no descendant is live', () => {
    const root = runNode({ children: [runNode({ key: 'idle', subLive: false })] })

    assert.strictEqual(deepestLiveNode(root).key, root.key)
  })

  it('descends into the most recently spawned live branch', () => {
    const worker = runNode({ key: 'worker', subLive: true })
    const earlier = runNode({ key: 'earlier', subLive: true })
    const later = runNode({ key: 'later', subLive: true, children: [worker] })
    const root = runNode({ key: 'root', subLive: true, children: [earlier, later] })

    assert.strictEqual(deepestLiveNode(root).key, 'worker')
  })
})
