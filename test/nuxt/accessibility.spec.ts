import { mountSuspended } from '@nuxt/test-utils/runtime'
import axe from 'axe-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import IndexPage from '~/pages/index.vue'
import RunChanges from '~/components/RunChanges.vue'
import RunOverview from '~/components/RunOverview.vue'
import { runResponse } from '../fixtures/runs'

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('accessibility', () => {
  it('has no detectable semantic violations in the empty dashboard state', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({
      projects: [],
      sources: [],
      now: 0,
    }))
    const component = await mountSuspended(IndexPage, {
      attachTo: document.body,
      global: {
        stubs: {
          RunCanvas: true,
        },
      },
    })

    try {
      const results = await axe.run(component.element, {
        resultTypes: ['violations'],
        rules: {
          // happy-dom has no layout engine, so contrast results are not meaningful here.
          'color-contrast': { enabled: false },
        },
      })

      expect(results.violations).toEqual([])
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
      const results = await axe.run(document.body, {
        resultTypes: ['violations'],
        rules: {
          'color-contrast': { enabled: false },
          // These are isolated views; the dashboard supplies their enclosing main landmark.
          'region': { enabled: false },
        },
      })

      expect(results.violations).toEqual([])
    } finally {
      changes.unmount()
      overview.unmount()
    }
  })
})
