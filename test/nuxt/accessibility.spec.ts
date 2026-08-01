import { mountSuspended } from '@nuxt/test-utils/runtime'
import axe from 'axe-core'
import type { RunOptions } from 'axe-core'
import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import IndexPage from '~/pages/index.vue'
import RunChanges from '~/components/RunChanges.vue'
import RunOverview from '~/components/RunOverview.vue'
import { mockLiveApi } from '../fixtures/live-api'
import { runNode, runResponse, treeResponse } from '../fixtures/runs'

const axeOptions: RunOptions = {
  resultTypes: ['violations'],
  rules: {
    // happy-dom has no layout engine, so contrast results are not meaningful here.
    'color-contrast': { enabled: false },
  },
}

async function expectNoViolations(element: Element, disabledRules: string[] = []) {
  const rules = Object.fromEntries(disabledRules.map(rule => [rule, { enabled: false }]))
  const results = await axe.run(element, {
    ...axeOptions,
    rules: { ...axeOptions.rules, ...rules },
  })
  expect(results.violations).toEqual([])
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('accessibility', () => {
  it('has no detectable semantic violations in the empty dashboard state', async () => {
    mockLiveApi(runNode(), {
      tree: () => ({ ...treeResponse([]), projects: [] }),
    })
    const component = await mountSuspended(IndexPage, {
      attachTo: document.body,
      global: {
        stubs: {
          RunCanvas: true,
          UTooltip: { template: '<slot />' },
        },
      },
    })

    try {
      await flushPromises()
      expect(component.get('[data-workspace-heading]').text()).toBe('No local sessions found')
      await expectNoViolations(component.element)
    } finally {
      component.unmount()
    }
  })

  it('has no detectable violations across the populated dashboard panels', async () => {
    const root = runNode()
    const run = runResponse()
    mockLiveApi(root, { run: () => run })
    const component = await mountSuspended(IndexPage, {
      attachTo: document.body,
      global: {
        stubs: {
          RunCanvas: true,
          UTooltip: { template: '<slot />' },
        },
      },
    })

    try {
      await flushPromises()
      await expectNoViolations(component.element)

      for (const shortcut of ['a', 'g', 'i', 'd', 'q']) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: shortcut }))
        await flushPromises()
        await expectNoViolations(component.element)
      }
    } finally {
      component.unmount()
    }
  })

  it('has no detectable semantic violations in populated supporting views', async () => {
    const run = runResponse()
    const changes = await mountSuspended(RunChanges, {
      props: { run },
      attachTo: document.body,
    })
    const overview = await mountSuspended(RunOverview, {
      props: { run, selectedKey: run.key },
      attachTo: document.body,
    })

    try {
      // These are isolated views; the dashboard supplies their enclosing main landmark.
      await expectNoViolations(document.body, ['region'])
    } finally {
      changes.unmount()
      overview.unmount()
    }
  })
})
