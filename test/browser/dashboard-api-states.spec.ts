import { expect, test } from '@playwright/test'
import {
  browserEvents,
  browserProject,
  browserRun,
  browserRunNode,
  browserSessionEvents,
  browserTextEvent,
  browserTree,
} from '../fixtures/browser-api'
import { mockDashboardApi } from './api-mocks'

test('shows an empty dashboard and degraded source details', async ({ page }) => {
  const sourceMessage = 'Claude transcripts could not be read for this scenario.'

  await mockDashboardApi(page, {
    tree: () => ({
      json: browserTree([], {
        includeProject: false,
        sources: [{
          source: 'claude',
          state: 'unavailable',
          sessions: 0,
          malformed: 0,
          message: sourceMessage,
        }],
      }),
    }),
  })

  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'No local sessions found' })).toBeVisible()
  await expect(page.getByText('No matching sessions')).toBeVisible()
  await page.getByRole('button', { name: /Filters/ }).click()
  await expect(page.getByText(sourceMessage)).toBeVisible()
})

test('shows loading states while a slow tree request is pending', async ({ page }) => {
  const root = browserRunNode({
    key: 'recovered-session',
    sid: 'recovered-session',
    label: 'Recovered API session',
  })
  let releaseTree!: () => void
  const treeRelease = new Promise<void>((resolve) => {
    releaseTree = resolve
  })

  await mockDashboardApi(page, {
    tree: async () => {
      await treeRelease
      return { json: browserTree([root]) }
    },
    run: () => ({ json: browserRun(root) }),
    events: () => ({ json: browserEvents(root, []) }),
    sessionEvents: () => ({ json: browserSessionEvents(root) }),
  })

  await page.goto('/')

  await expect(page.getByLabel('Loading local sessions…')).toBeVisible()
  await expect(page.getByLabel('Loading selected session')).toBeVisible()
  releaseTree()
  await expect(page.getByRole('heading', { name: root.label, exact: true })).toBeVisible()
  await expect(page.getByLabel('Loading local sessions…')).toHaveCount(0)
})

test('renders appended events and replaces them after a provider revision reset', async ({ page }) => {
  const root = browserRunNode({
    key: 'polling-session',
    sid: 'polling-session',
    label: 'Polling API session',
    live: true,
    subLive: true,
  })
  const eventQueries: string[] = []

  await mockDashboardApi(page, {
    tree: () => ({ json: browserTree([root]) }),
    run: () => ({ json: browserRun(root) }),
    events: ({ call, url }) => {
      eventQueries.push(url.search)
      if (call === 1) {
        return {
          json: browserEvents(root, [browserTextEvent('Initial browser event', 1)], {
            next: 1,
          }),
        }
      }
      if (call === 2) {
        return {
          json: browserEvents(root, [browserTextEvent('Appended browser event', 2)], {
            next: 2,
          }),
        }
      }
      if (call === 3) {
        return {
          json: browserEvents(root, [browserTextEvent('Rebuilt browser event', 3)], {
            next: 1,
            revision: 2,
            reset: true,
          }),
        }
      }
      return {
        json: browserEvents(root, [], { next: 1, revision: 2 }),
      }
    },
    sessionEvents: () => ({ json: browserSessionEvents(root) }),
  })

  await page.goto('/')
  await page.getByRole('navigation', { name: 'Session views' })
    .getByRole('button', { name: /Activity/ })
    .click()

  await expect(page.getByText('Initial browser event')).toBeVisible()
  await expect(page.getByText('Appended browser event')).toBeVisible({ timeout: 4_000 })
  await expect(page.getByText('Rebuilt browser event')).toBeVisible({ timeout: 4_000 })
  await expect(page.getByText('Initial browser event')).toHaveCount(0)
  await expect(page.getByText('Appended browser event')).toHaveCount(0)

  expect(eventQueries).toEqual(expect.arrayContaining([
    expect.stringContaining('since=1&revision=1'),
    expect.stringContaining('since=2&revision=1'),
  ]))
})

test('keeps the newer session when an older run response finishes late', async ({ page }) => {
  const first = browserRunNode({
    key: 'first-session',
    sid: 'first-session',
    label: 'First API session',
  })
  const second = browserRunNode({
    key: 'second-session',
    sid: 'second-session',
    label: 'Second API session',
  })
  let firstRunRequested = false
  let firstRunFinished = false
  let releaseFirstRun!: () => void
  const firstRunRelease = new Promise<void>((resolve) => {
    releaseFirstRun = resolve
  })

  await mockDashboardApi(page, {
    tree: () => ({ json: browserTree([first, second]) }),
    run: async ({ url }) => {
      const key = url.searchParams.get('key')
      if (key === first.key) {
        firstRunRequested = true
        await firstRunRelease
        firstRunFinished = true
        return { json: browserRun(first) }
      }
      return { json: browserRun(second) }
    },
    events: ({ url }) => {
      const root = url.searchParams.get('key') === second.key ? second : first
      return { json: browserEvents(root, []) }
    },
    sessionEvents: ({ url }) => {
      const root = url.searchParams.get('key') === second.key ? second : first
      return { json: browserSessionEvents(root) }
    },
  })

  await page.goto('/')
  await expect.poll(() => firstRunRequested).toBe(true)
  await page.getByText(second.label, { exact: true }).click()
  await expect(page.getByRole('heading', { name: second.label, exact: true })).toBeVisible()
  expect(new URL(page.url()).searchParams.get('project')).toBe(browserProject)

  releaseFirstRun()
  await expect.poll(() => firstRunFinished).toBe(true)
  await expect(page.getByRole('heading', { name: second.label, exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: first.label, exact: true })).toHaveCount(0)
})
