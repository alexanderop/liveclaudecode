import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { $fetch, fetch, setup } from '@nuxt/test-utils/e2e'
import type { CostOverviewResponse, EventsResponse, RunResponse, SessionEventsResponse, TreeResponse } from '#shared/types/run'
import type { ChatActionResponse, ChatEventsResponse } from '#shared/types/chat'
import * as fixture from '../fixtures/transcripts'
import * as codex from '../fixtures/codex'
import * as copilot from '../fixtures/copilot'

const SESSION = 'sess-1'
const OLD_SESSION = 'sess-old'
const CODEX_SESSION = '11111111-1111-4111-8111-111111111111'
const CODEX_AGENT = '22222222-2222-4222-8222-222222222222'
const COPILOT_SESSION = '33333333-3333-4333-8333-333333333333'
const directory = mkdtempSync(join(tmpdir(), 'liveclaudecode-api-'))
const codexDirectory = mkdtempSync(join(tmpdir(), 'liveclaudecode-codex-api-'))
const vscodeDirectory = mkdtempSync(join(tmpdir(), 'liveclaudecode-vscode-api-'))
const copilotCliDirectory = mkdtempSync(join(tmpdir(), 'liveclaudecode-copilot-cli-api-'))
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
  ], {
    model: 'claude-sonnet-5',
    messageId: 'msg-cost-e2e',
    usage: {
      input_tokens: 2,
      output_tokens: 11,
      cache_read_input_tokens: 3_289,
      cache_creation_input_tokens: 1_507,
      cache_creation: {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 1_507,
      },
      service_tier: 'standard',
      inference_geo: 'not_available',
      speed: 'standard',
    },
  }),
  fixture.system('turn_duration', { durationMs: 4_000, messageCount: 2 }),
])
fixture.writeSubagent(join(directory, SESSION), 'agent-a', [
  fixture.assistant([fixture.tool('Edit', 'e1', { file_path: '/repo/src/a.ts' })]),
  fixture.userResult('e1', 'ok'),
], { agentType: 'implementation-worker', description: 'slice A', toolUseId: 'spawn-a' })

// A session whose file mtime predates even the LCC_HOURS default window, so
// it is only reachable through an explicit `?hours=0` (all time) override.
const oldTranscriptPath = join(directory, `${OLD_SESSION}.jsonl`)
fixture.writeTranscript(oldTranscriptPath, [
  fixture.userText('Archived request'),
  fixture.assistant([fixture.text('Archived result')]),
])
const oldMtime = new Date('2001-01-01T00:00:00.000Z')
utimesSync(oldTranscriptPath, oldMtime, oldMtime)

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
vi.stubEnv('LCC_COPILOT_SESSIONS', copilotCliDirectory)
vi.stubEnv('LCC_HOURS', '99999')

// Scripted ACP agents so POST /api/chat can be exercised over HTTP without a
// real agent binary. `LCC_ACP_*` values are split on whitespace, so this
// requires a checkout path without spaces (as the repo's tooling already does).
const fakeAcpAgent = fileURLToPath(new URL('../fixtures/acp-agent.mjs', import.meta.url))
const nodeBinary = process.execPath.includes(' ') ? 'node' : process.execPath
vi.stubEnv('LCC_ACP_CLAUDE', `${nodeBinary} ${fakeAcpAgent} reply`)
vi.stubEnv('LCC_ACP_CODEX', `${nodeBinary} ${fakeAcpAgent} hang`)

function sourceSnapshot(root: string) {
  return Object.fromEntries(
    readdirSync(root, { recursive: true })
      .map(String)
      .sort()
      .flatMap((relative) => {
        const path = join(root, relative)
        const stat = statSync(path)
        return stat.isFile()
          ? [[relative, {
              content: readFileSync(path).toString('base64'),
              mode: stat.mode,
              mtimeMs: stat.mtimeMs,
              size: stat.size,
            }] as const]
          : []
      }),
  )
}

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
    rmSync(copilotCliDirectory, { recursive: true, force: true })
  })

  it('serves the dashboard shell with its document language and primary navigation', async () => {
    const html = await $fetch<string>('/')

    expect(html).toMatch(/<html\s+lang="en"/)
    expect(html).toContain('<title>Claude + Codex + Copilot Sessions — Live</title>')
    expect(html).toContain('<main class="main-content">')
    expect(html).toContain('aria-label="Overview workspace"')
    expect(html).toContain('aria-label="Session views"')
  })

  it('prevents caching of every live read endpoint', async () => {
    const paths = [
      '/api/tree',
      '/api/costs',
      `/api/run?key=${SESSION}`,
      `/api/events?key=${SESSION}&since=0`,
      `/api/session-events?key=${SESSION}`,
      `/api/chat?project=${encodeURIComponent(directory)}&key=${SESSION}&since=0&revision=0`,
    ]

    for (const path of paths) {
      const response = await fetch(path)
      expect(response.headers.get('cache-control'), path).toBe('no-store')
    }
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
    expect(response.costs).toMatchObject({
      currency: 'USD',
      pricedRequests: 1,
      unpricedRequests: 0,
      estimated: true,
    })
    expect(response.costs!.usd).toBe(0.0067998)
  })

  it('returns real cost and usage groups for each coding harness and model', async () => {
    const response = await $fetch<CostOverviewResponse>('/api/costs')

    expect(response).toMatchObject({
      currency: 'USD',
      estimated: true,
      sessions: 3,
      pricedRequests: 1,
    })
    expect(response.estimatedUsd).toBe(0.0067998)
    expect(response.harnesses).toEqual([
      expect.objectContaining({ source: 'claude', estimatedUsd: 0.0067998, sessions: 1 }),
      expect.objectContaining({ source: 'codex', estimatedUsd: null, sessions: 1 }),
      expect.objectContaining({ source: 'copilot', estimatedUsd: null, sessions: 1 }),
    ])
    expect(response.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'claude', label: 'claude-sonnet-5' }),
      expect.objectContaining({ source: 'codex', label: 'gpt-5.6-test' }),
    ]))
    expect(response.usage.out).toBeGreaterThan(11)
  })

  it('merges root and subagent transcripts into one chronological activity stream', async () => {
    const response = await $fetch<SessionEventsResponse>(`/api/session-events?key=${SESSION}`)

    expect(response.key).toBe(SESSION)
    expect(response.truncated).toBe(false)
    expect(new Set(response.events.map(event => event.agentKey))).toEqual(new Set([
      SESSION,
      `${SESSION}/agent-a`,
    ]))
    expect(response.events.find(event => event.agentKey === `${SESSION}/agent-a`)).toMatchObject({
      agentLabel: 'slice A',
      agentType: 'implementation-worker',
      agentDepth: 1,
    })
    expect(response.events.map(event => event.ts || '')).toEqual(
      [...response.events].sort((left, right) => (left.ts || '').localeCompare(right.ts || '')).map(event => event.ts || ''),
    )
  })

  it('describes the whole run for a selected worker', async () => {
    const response = await $fetch<RunResponse>(`/api/run?key=${SESSION}/agent-a`)
    expect(response.transcriptPath).toBe(`${directory}/${SESSION}/subagents/agent-a.jsonl`)
    expect(response.root.key).toBe(SESSION)
    expect(response.node.label).toBe('slice A')
    expect(response.lanes).toHaveLength(2)
    expect(response.files).toEqual([['src/a.ts', 1]])
    expect(response.diagnostics.cost).toMatchObject({ pricedRequests: 1, estimated: true })
    expect(response.phases.map(phase => phase.title)).toEqual(['Wave 1'])
    expect(response.diagnostics.turns[0]?.durationMs).toBe(4_000)
    expect(response.diagnostics.usage).toMatchObject({ in: 2, out: 11, cr: 3_289, cw: 1_507 })
    expect(response.diagnostics.cost?.usd).toBe(0.0067998)
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

  it('serves an empty session chat and accepts a reset without starting an agent', async () => {
    const events = await $fetch<ChatEventsResponse>(
      `/api/chat?project=${encodeURIComponent(directory)}&key=${SESSION}&since=0&revision=0`,
    )
    expect(events).toEqual({
      events: [],
      next: 0,
      revision: 0,
      reset: false,
      status: 'idle',
      agent: null,
    })

    const reset = await $fetch<ChatActionResponse>('/api/chat', {
      method: 'POST',
      body: { action: 'reset', project: directory, key: SESSION },
    })
    expect(reset).toEqual({ status: 'idle' })
  })

  it('maps a Codex rollout into the same run, file, plan, usage, and event contracts', async () => {
    const key = `codex:${CODEX_SESSION}`
    const response = await $fetch<RunResponse>(`/api/run?key=${key}`)

    expect(response.transcriptPath).toBe(codexRootPath)
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
    const original = readFileSync(codexRootPath)
    try {
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
    } finally {
      writeFileSync(codexRootPath, original)
    }
  })

  it('maps Copilot chat, tools, commands, edits, and targeted incremental updates', async () => {
    const original = readFileSync(copilotRootPath)
    try {
      const key = `copilot:${COPILOT_SESSION}`
      const response = await $fetch<RunResponse>(`/api/run?key=${key}`)
      expect(response.transcriptPath).toBe(copilotRootPath)
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
    } finally {
      writeFileSync(copilotRootPath, original)
    }
  })

  it('returns 404 for an unknown key', async () => {
    await expect($fetch('/api/run?key=nope')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('does not mutate transcript sources while serving repeated reads', async () => {
    const before = {
      claude: sourceSnapshot(directory),
      codex: sourceSnapshot(codexDirectory),
      copilot: sourceSnapshot(vscodeDirectory),
    }

    await $fetch('/api/tree')
    await $fetch(`/api/run?key=${SESSION}`)
    await $fetch(`/api/events?key=${SESSION}&since=0`)
    await $fetch(`/api/run?key=codex:${CODEX_SESSION}`)
    await $fetch(`/api/run?key=copilot:${COPILOT_SESSION}`)
    await $fetch('/api/tree')

    expect({
      claude: sourceSnapshot(directory),
      codex: sourceSnapshot(codexDirectory),
      copilot: sourceSnapshot(vscodeDirectory),
    }).toEqual(before)
  })

  async function projectIdContaining(rootKey: string): Promise<string> {
    const tree = await $fetch<TreeResponse>('/api/tree')
    const project = tree.projects.find(item => item.roots.some(root => root.key === rootKey))
    expect(project, `expected a project containing ${rootKey}`).toBeDefined()
    return project!.id
  }

  it('honors the ?hours override on the tree, run, and events endpoints', async () => {
    const scoped = await $fetch<TreeResponse>('/api/tree')
    expect(scoped.hours).toBe(99_999)
    expect(scoped.projects.flatMap(project => project.roots.map(root => root.key)))
      .not.toContain(OLD_SESSION)

    const allTime = await $fetch<TreeResponse>('/api/tree?hours=0')
    expect(allTime.hours).toBe(0)
    expect(allTime.projects.flatMap(project => project.roots.map(root => root.key)))
      .toContain(OLD_SESSION)

    await expect($fetch(`/api/run?key=${OLD_SESSION}`)).rejects.toMatchObject({ statusCode: 404 })
    const run = await $fetch<RunResponse>(`/api/run?key=${OLD_SESSION}&hours=0`)
    expect(run.root.key).toBe(OLD_SESSION)

    await expect($fetch(`/api/events?key=${OLD_SESSION}&since=0`))
      .rejects.toMatchObject({ statusCode: 404 })
    const events = await $fetch<EventsResponse>(`/api/events?key=${OLD_SESSION}&since=0&hours=0`)
    expect(events.key).toBe(OLD_SESSION)
    expect(events.events.length).toBeGreaterThan(0)
  })

  it('honors ?project scoping on run and events lookups', async () => {
    const project = encodeURIComponent(await projectIdContaining(SESSION))

    const scopedRun = await $fetch<RunResponse>(`/api/run?key=${SESSION}&project=${project}`)
    expect(scopedRun.root.key).toBe(SESSION)
    const scopedEvents = await $fetch<EventsResponse>(
      `/api/events?key=${SESSION}&since=0&project=${project}`,
    )
    expect(scopedEvents.key).toBe(SESSION)

    const wrongProject = encodeURIComponent('/does-not-exist')
    await expect($fetch(`/api/run?key=${SESSION}&project=${wrongProject}`))
      .rejects.toMatchObject({ statusCode: 404 })
    await expect($fetch(`/api/events?key=${SESSION}&since=0&project=${wrongProject}`))
      .rejects.toMatchObject({ statusCode: 404 })
  })

  it('answers a chat send action over HTTP through a scripted ACP agent', async () => {
    const project = await projectIdContaining(SESSION)
    const chatUrl = `/api/chat?project=${encodeURIComponent(project)}&key=${SESSION}&since=0&revision=0`

    try {
      const sent = await $fetch<ChatActionResponse>('/api/chat', {
        method: 'POST',
        body: {
          action: 'send',
          project,
          key: SESSION,
          agent: 'claude',
          text: 'What did this session ship?',
        },
      })
      expect(['starting', 'busy']).toContain(sent.status)

      const finished = await vi.waitFor(async () => {
        const polled = await $fetch<ChatEventsResponse>(chatUrl)
        expect(polled.status).toBe('idle')
        expect(polled.events.length).toBeGreaterThanOrEqual(3)
        return polled
      }, { timeout: 15_000, interval: 250 })

      expect(finished.agent).toBe('claude')
      // The reply chunk is delivered on the update stream while the turn end
      // comes from the prompt response, so their relative order is unspecified.
      expect(finished.events[0]).toEqual({ kind: 'user', text: 'What did this session ship?' })
      expect(finished.events).toContainEqual({
        kind: 'assistant-chunk',
        agent: 'claude',
        text: 'Fake agent reply.',
      })
      expect(finished.events).toContainEqual({ kind: 'turn-end', stopReason: 'end_turn' })
      expect(finished.events).toHaveLength(3)
    } finally {
      await $fetch('/api/chat', {
        method: 'POST',
        body: { action: 'reset', project, key: SESSION },
      })
    }
  })

  it('cancels an in-flight chat turn over HTTP', async () => {
    const key = `codex:${CODEX_SESSION}`
    const project = await projectIdContaining(key)
    const chatUrl = `/api/chat?project=${encodeURIComponent(project)}&key=${encodeURIComponent(key)}&since=0&revision=0`

    try {
      // The scripted codex agent accepts the prompt but never answers it.
      await $fetch<ChatActionResponse>('/api/chat', {
        method: 'POST',
        body: { action: 'send', project, key, agent: 'codex', text: 'Hang until cancelled' },
      })
      await vi.waitFor(async () => {
        const polled = await $fetch<ChatEventsResponse>(chatUrl)
        expect(polled.status).toBe('busy')
      }, { timeout: 15_000, interval: 250 })

      const cancelled = await $fetch<ChatActionResponse>('/api/chat', {
        method: 'POST',
        body: { action: 'cancel', project, key },
      })
      expect(cancelled.status).toBe('idle')

      const after = await $fetch<ChatEventsResponse>(chatUrl)
      expect(after.status).toBe('idle')
      expect(after.events.at(-1)).toEqual({ kind: 'turn-end', stopReason: 'cancelled' })
    } finally {
      await $fetch('/api/chat', {
        method: 'POST',
        body: { action: 'reset', project, key },
      })
    }
  })
})
