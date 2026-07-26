import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildTree,
  flatten,
  pathFor,
  resetRunCaches,
  rootOf,
  runPhases,
} from '#server/utils/runs'
import { resetScanCache } from '#server/utils/transcript'
import * as fixture from '../fixtures/transcripts'

const SESSION = 'sess-1'

describe('run hierarchy', () => {
  let directory: string
  let tree: Awaited<ReturnType<typeof buildTree>>

  beforeEach(async () => {
    resetScanCache()
    resetRunCaches()
    directory = await mkdtemp(join(tmpdir(), 'liveclaudecode-runs-'))
    fixture.writeTranscript(join(directory, `${SESSION}.jsonl`), [
      fixture.userText('/ship @plan.md'),
      fixture.assistant([
        fixture.text('**Wave 1 — two slices**'),
        fixture.tool('Agent', 'spawn-a', { description: 'slice A' }),
        fixture.tool('Agent', 'spawn-b', { description: 'slice B' }),
      ], { ts: fixture.T0(1) }),
      fixture.userResult('spawn-a', 'done', { ts: fixture.T0(30) }),
    ])
    fixture.writeSubagent(join(directory, SESSION), 'agent-a', [
      fixture.assistant([fixture.tool('Edit', 'e1', { file_path: '/repo/src/a.ts' })], { ts: fixture.T0(2) }),
      fixture.userResult('e1', 'ok', { ts: fixture.T0(3) }),
    ], { agentType: 'implementation-worker', description: 'slice A', toolUseId: 'spawn-a' })
    fixture.writeSubagent(join(directory, SESSION), 'agent-b', [
      fixture.assistant([
        fixture.text('**Wave 2 — follow up**'),
        fixture.tool('Bash', 'b1', { command: 'pnpm test' }),
      ], { ts: fixture.T0(4) }),
    ], { agentType: 'implementation-worker', description: 'slice B', toolUseId: 'spawn-b' })
    tree = await buildTree(directory, 99_999)
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
    resetScanCache()
    resetRunCaches()
  })

  it('hangs subagents off the transcript that spawned them', () => {
    expect(tree.roots).toHaveLength(1)
    expect(tree.roots[0]?.key).toBe(SESSION)
    expect(tree.roots[0]?.children.map(child => child.label).sort()).toEqual(['slice A', 'slice B'])
  })

  it('distinguishes returned and running agents', () => {
    const states = Object.fromEntries(tree.roots[0]!.children.map(child => [child.label, child.spawnState]))
    expect(states).toEqual({ 'slice A': 'returned', 'slice B': 'running' })
  })

  it('rolls up totals for the whole subtree', () => {
    const root = tree.roots[0]!
    expect(root.subAgents).toBe(2)
    expect(root.subTools).toBe(4)
    expect(root.subFiles).toEqual({ 'src/a.ts': 1 })
  })

  it('produces depth-ordered timeline lanes', () => {
    const lanes = flatten(tree.roots[0]!)
    expect(lanes.map(lane => lane.depth)).toEqual([0, 1, 1])
    expect(lanes[0]?.key).toBe(SESSION)
  })

  it('finds the top-level run for a worker', () => {
    expect(rootOf(tree.roots, `${SESSION}/agent-b`)?.key).toBe(SESSION)
  })

  it('merges phase announcements across every agent', () => {
    const phases = runPhases(tree.roots[0]!)
    expect(phases.map(phase => phase.title)).toEqual(['Wave 1 — two slices', 'Wave 2 — follow up'])
    expect(Object.fromEntries(phases.map(phase => [phase.title, phase.who])))
      .toEqual({ 'Wave 1 — two slices': 'main', 'Wave 2 — follow up': 'slice B' })
  })

  it('maps session and subagent keys to transcript paths', () => {
    expect(pathFor('/p', 'abc')).toBe('/p/abc.jsonl')
    expect(pathFor('/p', 'abc/agent-1')).toBe('/p/abc/subagents/agent-1.jsonl')
  })

  it('rejects traversal-shaped run keys', () => {
    expect(() => pathFor('/p', '../passwd')).toThrow('Invalid run key')
  })

  it('can exclude every run with the age filter', async () => {
    resetScanCache()
    expect((await buildTree(directory, 0)).roots).toEqual([])
  })
})
