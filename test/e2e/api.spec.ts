import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { $fetch, setup } from '@nuxt/test-utils/e2e'
import type { EventsResponse, RunResponse, TreeResponse } from '#shared/types/run'
import * as fixture from '../fixtures/transcripts'
import * as codex from '../fixtures/codex'
import * as copilot from '../fixtures/copilot'

const SESSION = 'sess-1'
const CODEX_SESSION = '11111111-1111-4111-8111-111111111111'
const CODEX_AGENT = '22222222-2222-4222-8222-222222222222'
const COPILOT_SESSION = '33333333-3333-4333-8333-333333333333'
const directory = mkdtempSync(join(tmpdir(), 'liveclaudecode-api-'))
const codexDirectory = mkdtempSync(join(tmpdir(), 'liveclaudecode-codex-api-'))
const vscodeDirectory = mkdtempSync(join(tmpdir(), 'liveclaudecode-vscode-api-'))
const codexDay = join(codexDirectory, '2026', '07', '26')
const codexRootPath = join(codexDay, `rollout-2026-07-26T08-00-00-${CODEX_SESSION}.jsonl`)
const copilotRootPath = join(
  vscodeDirectory,
  'workspaceStorage',
  'repo-workspace',
  'chatSessions',
  `${COPILOT_SESSION}.jsonl`,
)

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

codex.writeRollout(codexRootPath, [
  codex.sessionMeta(CODEX_SESSION, {
    cwd: '/repo',
    originator: 'Codex Desktop',
    source: 'vscode',
  }),
  codex.turnContext({ cwd: '/repo', model: 'gpt-5.6-test', effort: 'high' }),
  codex.message('user', 'Ship the Codex adapter'),
  codex.event('task_started'),
  codex.toolCall('update_plan', 'plan-1', {
    plan: [{ step: 'Parse rollouts', status: 'completed' }],
  }),
  codex.toolOutput('plan-1', { ok: true }),
  codex.event('patch_apply_end', {
    call_id: 'patch-1',
    success: true,
    changes: { '/repo/src/codex.ts': { kind: 'update' } },
  }),
  codex.event('token_count', {
    info: {
      total_token_usage: {
        input_tokens: 30,
        cached_input_tokens: 10,
        output_tokens: 12,
      },
    },
  }),
  codex.toolCall('exec_command', 'live-command', { cmd: 'pnpm test' }),
], { malformed: true })
codex.writeRollout(
  join(codexDay, `rollout-2026-07-26T08-01-00-${CODEX_AGENT}.jsonl`),
  [
    codex.sessionMeta(CODEX_AGENT, {
      cwd: '/repo',
      source: codex.subagentSource(CODEX_SESSION, {
        nickname: 'Codex worker',
        role: 'worker',
        path: '/root/codex_worker',
      }),
    }),
    codex.turnContext({ cwd: '/repo' }),
    codex.message('assistant', 'Worker finished'),
    codex.event('task_complete'),
  ],
)

copilot.writeLog(copilotRootPath, [
  copilot.initial(copilot.snapshot({
    id: COPILOT_SESSION,
    title: 'Copilot API session',
    workingDirectory: '/repo',
    pendingRequests: [{ id: 'copilot-request' }],
    requests: [copilot.request('copilot-request', 'Ship the Copilot adapter', {
      timestamp: copilot.T0 + 5_000,
      state: 0,
      mode: 'agent',
      response: [
        copilot.tool('run_in_terminal', 'copilot-command', {
          complete: false,
          command: 'pnpm test:unit',
        }),
        copilot.textEdit('/repo/src/copilot.ts'),
        copilot.markdown('Copilot is still working.'),
      ],
    })],
  })),
])

vi.stubEnv('LCC_PROJECT', directory)
vi.stubEnv('LCC_CODEX_SESSIONS', codexDirectory)
vi.stubEnv('LCC_VSCODE_USER_DATA', vscodeDirectory)
vi.stubEnv('LCC_HOURS', '99999')

describe('read-only API', async () => {
  await setup({
    rootDir: fileURLToPath(new URL('../..', import.meta.url)),
    server: true,
  })

  afterAll(() => {
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
    rmSync(codexDirectory, { recursive: true, force: true })
    rmSync(vscodeDirectory, { recursive: true, force: true })
  })

  it('returns a combined, provider-tagged run hierarchy and source health', async () => {
    const response = await $fetch<TreeResponse>('/api/tree')
    const project = response.projects.find(item => item.name === 'repo')
    const claudeRoot = project?.roots.find(root => root.key === SESSION)
    const codexRoot = project?.roots.find(root => root.key === `codex:${CODEX_SESSION}`)
    const copilotRoot = project?.roots.find(root => root.key === `copilot:${COPILOT_SESSION}`)

    expect(project).toBeDefined()
    expect(claudeRoot?.source).toBe('claude')
    expect(claudeRoot?.children[0]?.agentType).toBe('implementation-worker')
    expect(codexRoot?.source).toBe('codex')
    expect(copilotRoot).toMatchObject({
      source: 'copilot',
      sourceDetail: 'VS Code · agent',
      live: true,
    })
    expect(codexRoot?.children[0]).toMatchObject({
      key: `codex:${CODEX_AGENT}`,
      label: 'Codex worker',
      parentAgentId: CODEX_SESSION,
    })
    expect(response.sources).toEqual([
      expect.objectContaining({ source: 'claude', state: 'ready', sessions: 1 }),
      expect.objectContaining({ source: 'codex', state: 'degraded', sessions: 1, malformed: 1 }),
      expect.objectContaining({ source: 'copilot', state: 'ready', sessions: 1 }),
    ])
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

  it('maps a Codex rollout into the same run, file, plan, usage, and event contracts', async () => {
    const key = `codex:${CODEX_SESSION}`
    const response = await $fetch<RunResponse>(`/api/run?key=${key}`)

    expect(response.root).toMatchObject({ key, source: 'codex', subLive: true })
    expect(response.lanes).toHaveLength(2)
    expect(response.files).toEqual([['src/codex.ts', 1]])
    expect(response.node.todos).toEqual([{ content: 'Parse rollouts', status: 'completed' }])
    expect(response.node.current).toMatchObject({ tool: 'exec_command', summary: 'pnpm test' })
    expect(response.diagnostics.usage).toEqual({ in: 30, out: 12, cr: 10, cw: 0 })
    expect(response.diagnostics.agents).toHaveLength(2)

    const events = await $fetch<EventsResponse>(`/api/events?key=${key}&since=0`)
    expect(events.events.some(event => event.kind === 'prompt')).toBe(true)
    expect(events.events.some(event => event.tool === 'exec_command')).toBe(true)
  })

  it('reads newly appended complete Codex records without duplicating prior events', async () => {
    const key = `codex:${CODEX_SESSION}`
    const first = await $fetch<EventsResponse>(`/api/events?key=${key}&since=0`)
    codex.appendRecords(codexRootPath, [
      codex.toolOutput('live-command', { exit_code: 0, output: 'passed' }),
      codex.message('assistant', 'Codex run complete', { ts: codex.C0(9) }),
      codex.event('task_complete', {}, codex.C0(10)),
    ])

    const second = await $fetch<EventsResponse>(`/api/events?key=${key}&since=${first.next}`)
    expect(second.events.map(event => event.kind)).toEqual(['tool_result', 'text'])
    expect(second.next).toBe(first.next + 2)

    const run = await $fetch<RunResponse>(`/api/run?key=${key}`)
    expect(run.root.subLive).toBe(false)
    expect(run.root.finalText).toBe('Codex run complete')
  })

  it('maps Copilot chat, tools, commands, edits, and targeted incremental updates', async () => {
    const key = `copilot:${COPILOT_SESSION}`
    const response = await $fetch<RunResponse>(`/api/run?key=${key}`)
    expect(response.root).toMatchObject({ key, source: 'copilot', subLive: true })
    expect(response.files).toEqual([['src/copilot.ts', 1]])
    expect(response.node.commands).toEqual([
      expect.objectContaining({ cmd: 'pnpm test:unit', ok: null }),
    ])
    expect(response.diagnostics.environment.entrypoint).toBe('VS Code')
    expect(response.diagnostics.changes[0]?.path).toBe('src/copilot.ts')

    const first = await $fetch<EventsResponse>(`/api/events?key=${key}&since=0`)
    expect(first.events.some(event => event.kind === 'prompt')).toBe(true)
    expect(first.events.some(event => event.tool === 'run_in_terminal')).toBe(true)

    copilot.appendRecords(copilotRootPath, [
      copilot.set(['requests', 0, 'response', 0], copilot.tool('run_in_terminal', 'copilot-command', {
        command: 'pnpm test:unit',
        exitCode: 0,
      })),
      copilot.set(['requests', 0, 'modelState'], { value: 1, completedAt: copilot.T0 + 8_000 }),
      copilot.set(['pendingRequests'], []),
    ])

    const second = await $fetch<EventsResponse>(
      `/api/events?key=${key}&since=${first.next}&revision=${first.revision}`,
    )
    expect(second.reset).toBe(true)
    expect(second.events.filter(event => event.kind === 'tool_result')).toEqual([
      expect.objectContaining({
        kind: 'tool_result',
        tool: 'run_in_terminal',
        error: false,
        body: 'Ran run_in_terminal',
      }),
    ])
    const updated = await $fetch<RunResponse>(`/api/run?key=${key}`)
    expect(updated.root.subLive).toBe(false)
    expect(updated.node.commands[0]?.ok).toBe(true)

    copilot.appendRecords(copilotRootPath, [
      copilot.set(['requests', 0, 'response', 2, 'value'], 'Copilot response complete.'),
    ])
    const streamed = await $fetch<EventsResponse>(
      `/api/events?key=${key}&since=${second.next}&revision=${second.revision}`,
    )
    expect(streamed.reset).toBe(true)
    expect(streamed.events.filter(event => event.kind === 'text')).toEqual([
      expect.objectContaining({ body: 'Copilot response complete.' }),
    ])
  })

  it('returns 404 for an unknown key', async () => {
    await expect($fetch('/api/run?key=nope')).rejects.toMatchObject({ statusCode: 404 })
  })
})
