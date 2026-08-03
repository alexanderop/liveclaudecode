import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import RunNowBoard from '~/components/RunNowBoard.vue'
import { runNode, runResponse } from '../fixtures/runs'

let component: VueWrapper | null = null

afterEach(() => {
  component?.unmount()
  component = null
})

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
    const wrapper = component = await mountSuspended(RunNowBoard, {
      props: { root, run: runResponse() },
    })

    expect(wrapper.get('.now-health').text()).toContain('1 active')
    expect(wrapper.findAll('.now-agent')[0]!.text()).toContain('Timeline audit')
    expect(wrapper.findAll('.now-agent')[0]!.text()).toContain('Read')

    await wrapper.findAll('.now-agent')[0]!.trigger('click')
    expect(wrapper.emitted('select')).toEqual([['worker']])
  })

  it('shows the instruction a live session is working from', async () => {
    const root = runNode({ lastPrompt: 'now run the checks', subLive: true })
    const wrapper = component = await mountSuspended(RunNowBoard, {
      props: { root, run: runResponse() },
    })

    const instruction = wrapper.get('.now-instruction')
    expect(instruction.text()).toContain('Working from')
    expect(instruction.text()).toContain('now run the checks')
  })

  it('calls the instruction the last one once the session has stopped', async () => {
    const root = runNode({ lastPrompt: 'now run the checks', subLive: false })
    const wrapper = component = await mountSuspended(RunNowBoard, {
      props: { root, run: runResponse() },
    })

    expect(wrapper.get('.now-instruction').text()).toContain('Last instruction')
  })

  it('stays silent when the session never moved past its opening prompt', async () => {
    const root = runNode({ lastPrompt: 'Ship the dashboard' })
    const wrapper = component = await mountSuspended(RunNowBoard, {
      props: { root, run: runResponse() },
    })

    expect(wrapper.find('.now-instruction').exists()).toBe(false)
  })
})
