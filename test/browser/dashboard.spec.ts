import { expect, test } from '@playwright/test'
import axe from 'axe-core'

const hydrationPatterns = [
  'Hydration completed but contains mismatches',
  'Hydration text content mismatch',
  'Hydration node mismatch',
  'Hydration children mismatch',
  'Hydration attribute mismatch',
  'Hydration class mismatch',
  'Hydration style mismatch',
]

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
    await page.waitForTimeout(300)

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
