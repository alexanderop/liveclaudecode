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

  await expect(page.getByRole('heading', { name: 'Verify the browser dashboard' })).toBeVisible()
  await expect(page.getByText('Claude', { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Supporting session views' })).toBeVisible()

  await page.getByRole('button', { name: /Jump to session/ }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByPlaceholder('Jump to a session or view…')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  await page.keyboard.press('a')
  await expect(page.getByRole('complementary', { name: 'Activity panel' })).toBeVisible()

  await page.keyboard.press('g')
  await expect(page.getByRole('complementary', { name: 'Guide panel' })).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByRole('complementary', { name: 'Guide panel' })).toHaveCount(0)

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
  await page.keyboard.press('a')
  await expect(page.locator('.supporting-slideover')).toBeVisible()
  await expect(page.getByRole('complementary', { name: 'Activity panel' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.supporting-slideover')).toHaveCount(0)

  expect(hydrationErrors).toEqual([])
  expect(externalRequests).toEqual([])
})
