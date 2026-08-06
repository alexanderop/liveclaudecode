import { mountSuspended } from '@nuxt/test-utils/runtime'
import axe from 'axe-core'
import type { RunOptions } from 'axe-core'
import { flushPromises, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import IndexPage from '~/pages/index.vue'
import RunChanges from '~/components/RunChanges.vue'
import RunOverview from '~/components/RunOverview.vue'
import { mockLiveApi } from '../fixtures/live-api'
import { mountWithAtoms } from '../fixtures/mount-atoms'
import { runNode, runResponse, treeResponse } from '../fixtures/runs'
import { servingTree } from '../fixtures/stub-api'

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

/** These views are attached to `document.body`, so several may be live at once. */
let mounted: VueWrapper[] = []
/** One per `mountWithAtoms`, disposed with the mount that owns it. */
let registries: Array<() => void> = []

afterEach(() => {
  for (const component of mounted) component.unmount()
  for (const dispose of registries) dispose()
  mounted = []
  registries = []
  document.body.innerHTML = ''
})

describe('accessibility', () => {
  it('has no detectable semantic violations in the empty dashboard state', async () => {
    const empty = { ...treeResponse([]), projects: [] }
    mockLiveApi(runNode(), { tree: () => empty })
    const dashboard = await mountWithAtoms(IndexPage, {
      api: servingTree(empty),
      attachTo: document.body,
      global: {
        stubs: {
          UTooltip: { template: '<slot />' },
        },
      },
    })
    const component = dashboard.wrapper
    mounted.push(component)
    registries.push(() => dashboard.registry.dispose())

    await flushPromises()
    expect(component.get('[data-workspace-heading]').text()).toBe('No local sessions found')
    await expectNoViolations(component.element)
  })

  it('has no detectable violations across the populated dashboard panels', async () => {
    const root = runNode()
    const run = runResponse()
    mockLiveApi(root, { run: () => run })
    const dashboard = await mountWithAtoms(IndexPage, {
      api: servingTree(treeResponse(root)),
      attachTo: document.body,
      global: {
        stubs: {
          UTooltip: { template: '<slot />' },
        },
      },
    })
    const component = dashboard.wrapper
    mounted.push(component)
    registries.push(() => dashboard.registry.dispose())

    await flushPromises()
    await expectNoViolations(component.element)

    for (const shortcut of ['a', 'g', 'i', 'd', 'q']) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: shortcut }))
      await flushPromises()
      await expectNoViolations(component.element)
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
    mounted.push(changes, overview)

    // These are isolated views; the dashboard supplies their enclosing main landmark.
    await expectNoViolations(document.body, ['region'])
  })
})
