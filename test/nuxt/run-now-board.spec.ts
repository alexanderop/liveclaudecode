import { mountSuspended } from '@nuxt/test-utils/runtime'
import { describe, expect, it } from 'vitest'
import RunNowBoard from '~/components/RunNowBoard.vue'
import { runNode, runResponse } from '../fixtures/runs'

describe('RunNowBoard', () => {
  it('summarizes the session and opens an agent from the attention-sorted board', async () => {
    const worker = runNode({
      key: 'worker',
      sid: 'worker',
      kind: 'subagent',
      label: 'Timeline audit',
      agentType: 'Explore',
      live: true,
      current: { tool: 'Read', summary: 'Inspecting the canvas', ts: '2026-07-25T18:02:00.000Z' },
      finalText: '',
      errors: 0,
      subErrors: 0,
      children: [],
    })
    const root = runNode({
      children: [worker],
      errors: 0,
      subErrors: 0,
      subAgents: 1,
      subTools: 6,
      subLive: true,
    })
    const component = await mountSuspended(RunNowBoard, {
      props: { root, run: runResponse() },
    })

    expect(component.get('.now-health').text()).toContain('1 active')
    expect(component.findAll('.now-agent')[0]!.text()).toContain('Timeline audit')
    expect(component.findAll('.now-agent')[0]!.text()).toContain('Read')

    await component.findAll('.now-agent')[0]!.trigger('click')
    expect(component.emitted('select')).toEqual([['worker']])
  })
})
