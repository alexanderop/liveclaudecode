import { expect, test } from '@playwright/test'
import axe from 'axe-core'

declare global {
  interface Window {
    /** Injected into the page by this spec before running the audit. */
    axe: typeof axe
  }
}

const hydrationPatterns = [
  'Hydration completed but contains mismatches',
  'Hydration text content mismatch',
  'Hydration node mismatch',
  'Hydration children mismatch',
  'Hydration attribute mismatch',
  'Hydration class mismatch',
  'Hydration style mismatch',
]

test('shows the today-versus-week cost estimate and its billing limits', async ({ page }) => {
  await page.route('**/api/tree**', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    body.costs = {
      currency: 'USD',
      usd: 4.7,
      todayUsd: 1.23,
      last7DaysUsd: 4.7,
      coverageHours: 168,
      pricedRequests: 12,
      unpricedRequests: 0,
      estimated: true,
    }
    await route.fulfill({ response, json: body })
  })

  await page.goto('/', { waitUntil: 'networkidle' })

  const costs = page.getByRole('region', { name: 'Estimated Claude API cost' })
  await expect(costs).toBeVisible()
  await expect(costs).toContainText('Today$1.23')
  await expect(costs).toContainText('Last 7 days$4.70')
  await expect(costs).toContainText(
    'Transcript-only estimate; excludes hidden helper calls and plan billing.',
  )
})

test('hydrates the synthetic dashboard and supports its primary keyboard workflow', async ({
  page,
  baseURL,
}) => {
  const hydrationErrors: string[] = []
  const externalRequests: string[] = []

  page.on('console', (message) => {
    if (hydrationPatterns.some(pattern => message.text().includes(pattern))) {
      hydrationErrors.push(message.text())
    }
  })
  await page.route('**/*', async (route) => {
    const requestUrl = new URL(route.request().url())
    if (requestUrl.origin !== new URL(baseURL!).origin) {
      externalRequests.push(requestUrl.href)
      await route.abort()
      return
    }
    await route.continue()
  })

  await page.goto('/', { waitUntil: 'networkidle' })

  await expect(page.getByRole('heading', { name: 'Verify the browser dashboard', exact: true })).toBeVisible()
  await expect(page.getByText('Claude', { exact: true }).first()).toBeVisible()
  const sessionViews = page.getByRole('navigation', { name: 'Session views' })
  await expect(sessionViews).toBeVisible()

  await page.getByRole('button', { name: 'Search' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByPlaceholder('Jump to a session or view…')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  await sessionViews.getByRole('button', { name: /Activity/ }).click()
  await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible()

  // Destination mnemonics no longer act as global shortcuts.
  await page.keyboard.press('d')
  await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible()

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: /^Ask/ }).click()
  const askComposer = page.getByRole('textbox', { name: 'Question about this session' })
  await expect(page.locator('.ask-context')).toBeVisible()
  await askComposer.fill('A draft that must survive closing Ask')
  await askComposer.press('Escape')
  await expect(page.locator('.ask-context')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible()

  await page.getByRole('button', { name: /^Ask/ }).click()
  await expect(page.getByRole('textbox', { name: 'Question about this session' }))
    .toHaveValue('A draft that must survive closing Ask')
  await page.getByRole('button', { name: 'Close Ask' }).click()

  await page.addScriptTag({ content: axe.source })
  for (const mode of ['Light', 'Dark']) {
    await page.getByRole('button', { name: 'Color mode' }).click()
    await page.getByRole('option', { name: mode }).click()
    await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${mode.toLowerCase()}\\b`))
    // The palette flips with the root color-scheme; wait for it to be applied
    // and for the mode picker to fully close before auditing contrast.
    await expect.poll(() =>
      page.evaluate(() => getComputedStyle(document.documentElement).colorScheme),
    ).toBe(mode.toLowerCase())
    await expect(page.getByRole('option', { name: mode })).toHaveCount(0)

    const violations = await page.evaluate(async () => {
      const results = await window.axe.run(document, {
        resultTypes: ['violations'],
        rules: {
          // The keyboard-operable resize separator sits between the sidebar and main landmarks.
          'region': { enabled: false },
        },
      })
      return results.violations
    })

    expect(
      violations.map(violation => ({
        id: violation.id,
        nodes: violation.nodes.map(node => node.target),
      })),
      `${mode} mode accessibility violations`,
    ).toEqual([])
  }

  await page.setViewportSize({ width: 800, height: 900 })
  await page.getByRole('navigation', { name: 'Session views' }).getByRole('button', { name: /Agents/ }).click()
  await page.locator('.sketch-node').first().click()
  await expect(page.locator('.supporting-slideover')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.supporting-slideover')).toHaveCount(0)

  expect(hydrationErrors).toEqual([])
  expect(externalRequests).toEqual([])
})

test('keeps selected-agent activity inside a scrollable viewport', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' })
  await page.getByRole('navigation', { name: 'Session views' }).getByRole('button', { name: /Agents/ }).click()
  await page.locator('.sketch-node').first().click()
  await page.getByRole('tab', { name: 'Activity' }).click()

  const feed = page.locator('.inspector-activity > .feed')
  await expect(feed).toBeVisible()

  const dimensions = await feed.evaluate((element) => {
    const main = document.querySelector<HTMLElement>('.main-content')
    const workspace = document.querySelector<HTMLElement>('.session-workspace')
    return {
      feedClientHeight: element.clientHeight,
      feedScrollHeight: element.scrollHeight,
      mainBottom: main?.getBoundingClientRect().bottom,
      workspaceBottom: workspace?.getBoundingClientRect().bottom,
      viewportHeight: window.innerHeight,
    }
  })

  expect(dimensions.feedScrollHeight).toBeGreaterThan(dimensions.feedClientHeight)
  expect(dimensions.mainBottom).toBeLessThanOrEqual(dimensions.viewportHeight)
  expect(dimensions.workspaceBottom).toBeLessThanOrEqual(dimensions.viewportHeight)

  await feed.hover()
  await page.mouse.wheel(0, 500)
  await expect.poll(() => feed.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
})
