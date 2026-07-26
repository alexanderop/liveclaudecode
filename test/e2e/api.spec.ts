import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { $fetch, setup } from '@nuxt/test-utils/e2e'
import type { EventsResponse, RunResponse, TreeResponse } from '#shared/types/run'
import * as fixture from '../fixtures/transcripts'

const SESSION = 'sess-1'
const directory = mkdtempSync(join(tmpdir(), 'liveclaudecode-api-'))

fixture.writeTranscript(join(directory, `${SESSION}.jsonl`), [
  fixture.userText('/ship @plan.md'),
  fixture.assistant([
    fixture.text('**Wave 1**'),
    fixture.tool('Agent', 'spawn-a', { description: 'slice A' }),
  ], { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20 } }),
  fixture.system('turn_duration', { durationMs: 4_000, messageCount: 2 }),
])
fixture.writeSubagent(join(directory, SESSION), 'agent-a', [
  fixture.assistant([fixture.tool('Edit', 'e1', { file_path: '/repo/src/a.ts' })]),
  fixture.userResult('e1', 'ok'),
], { agentType: 'implementation-worker', description: 'slice A', toolUseId: 'spawn-a' })

vi.stubEnv('LCC_PROJECT', directory)
vi.stubEnv('LCC_HOURS', '99999')

describe('read-only API', async () => {
  await setup({
    rootDir: fileURLToPath(new URL('../..', import.meta.url)),
    server: true,
  })

  afterAll(() => {
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
  })

  it('returns the run hierarchy', async () => {
    const response = await $fetch<TreeResponse>('/api/tree')
    expect(response.projects[0]?.name).toBe('repo')
    expect(response.projects[0]?.roots[0]?.key).toBe(SESSION)
    expect(response.projects[0]?.roots[0]?.children[0]?.agentType).toBe('implementation-worker')
  })

  it('describes the whole run for a selected worker', async () => {
    const response = await $fetch<RunResponse>(`/api/run?key=${SESSION}/agent-a`)
    expect(response.root.key).toBe(SESSION)
    expect(response.node.label).toBe('slice A')
    expect(response.lanes).toHaveLength(2)
    expect(response.files).toEqual([['src/a.ts', 1]])
    expect(response.phases.map(phase => phase.title)).toEqual(['Wave 1'])
    expect(response.diagnostics.turns[0]?.durationMs).toBe(4_000)
    expect(response.diagnostics.usage).toMatchObject({ in: 10, out: 5, cr: 20 })
    expect(response.diagnostics.agents).toHaveLength(2)
  })

  it('paginates events by their index and links spawned agents', async () => {
    const first = await $fetch<EventsResponse>(`/api/events?key=${SESSION}&since=0`)
    expect(first.events.length).toBeGreaterThan(0)
    expect(first.events.find(event => event.spawn)?.childKey).toBe(`${SESSION}/agent-a`)

    const second = await $fetch<EventsResponse>(`/api/events?key=${SESSION}&since=${first.next}`)
    expect(second.events).toEqual([])
    expect(second.next).toBe(first.next)
  })

  it('returns 404 for an unknown key', async () => {
    await expect($fetch('/api/run?key=nope')).rejects.toMatchObject({ statusCode: 404 })
  })
})
