import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { activitySession, makeActivityAtoms } from '~/atoms/activity'
import { eventsKey, makeEventsAtoms } from '~/atoms/events'
import { makeFiltersAtoms } from '~/atoms/filters'
import { makePreferencesAtoms } from '~/atoms/preferences'
import { makeRangeAtoms } from '~/atoms/range'
import { makeRunAtoms } from '~/atoms/run-detail'
import { makeSelectionAtoms } from '~/atoms/selection'
import { makeSessionEventsAtoms } from '~/atoms/session-events'
import { makeTreeAtoms } from '~/atoms/tree'
import { testAtoms } from '../../fixtures/atom-registry'
import {
  eventsResponse,
  runDiagnostics,
  runNode,
  runResponse,
  sessionEventsResponse,
  transcriptEvent,
  treeResponse,
} from '../../fixtures/runs'
import { stubApi, type StubApiHandlers } from '../../fixtures/stub-api'

const child = runNode({ key: 'session/worker', kind: 'subagent', label: 'Worker' })
const root = runNode({ key: 'session', children: [child], subAgents: 1 })

/**
 * The activity view over one session, with every feed beneath it stubbed.
 *
 * Six factories, because this atom is where the four data domains meet — which
 * is exactly why it is worth having as an atom: the same assertion against the
 * page would need a mounted dashboard.
 */
const withActivity = Effect.fn('withActivity')(function*(handlers: StubApiHandlers) {
  const stub = stubApi({ tree: () => Effect.succeed(treeResponse(root)), ...handlers })
  const atoms = yield* testAtoms(stub.layer)
  const range = makeRangeAtoms()
  const tree = makeTreeAtoms(atoms.runtime, range)
  const selection = makeSelectionAtoms(tree, makeFiltersAtoms(tree), makePreferencesAtoms())
  const events = makeEventsAtoms(atoms.runtime)
  const activity = makeActivityAtoms(
    selection,
    range,
    events,
    makeSessionEventsAtoms(atoms.runtime),
    makeRunAtoms(atoms.runtime),
  )
  yield* atoms.mount(tree.tree)
  yield* atoms.settled(tree.tree)

  // The transcript feed only fetches for a transcript something says it is
  // showing, which on the dashboard is `useTranscriptActivation` in
  // `index.vue`. Standing in for it here is not scaffolding: the activity view
  // reads the agent transcript, so without this it would assert against a feed
  // that is switched off. `events.spec.ts` owns the rule itself.
  yield* atoms.set(events.active, {
    target: eventsKey(
      yield* atoms.get(selection.project),
      yield* atoms.get(selection.key),
      yield* atoms.get(range.hours),
    ),
    delta: 1,
  })
  yield* atoms.mount(activity.feed)
  return { atoms, activity, selection }
})

const bodies = (events: ReadonlyArray<{ readonly body?: string | undefined }>) =>
  events.map(event => event.body)

describe('activity atoms', () => {
  it.effect('shows the session-wide merge once the server answers with one', () =>
    Effect.gen(function*() {
      const { atoms, activity } = yield* withActivity({
        sessionEvents: () => Effect.succeed(sessionEventsResponse('session', ['merged event'])),
        events: () => Effect.succeed(eventsResponse('session', ['agent event'])),
        run: () => Effect.succeed(runResponse({ root, node: root })),
      })

      assert.deepStrictEqual(bodies(yield* atoms.get(activity.feed)), ['merged event'])
    }))

  it.effect('falls back to the selected agent, labelled as the session root', () =>
    Effect.gen(function*() {
      const { atoms, activity } = yield* withActivity({
        sessionEvents: () => Effect.succeed(sessionEventsResponse('session', [])),
        events: () => Effect.succeed(eventsResponse('session', ['agent event'])),
        run: () => Effect.succeed(runResponse({ root, node: root })),
      })

      const [only] = yield* atoms.get(activity.feed)
      assert.strictEqual(only?.body, 'agent event')
      assert.strictEqual(only?.agentKey, 'session')
    }))

  it.effect('merges diagnostic incidents the transcript did not report', () =>
    Effect.gen(function*() {
      const { atoms, activity } = yield* withActivity({
        sessionEvents: () => Effect.succeed(sessionEventsResponse('session', ['merged event'])),
        events: () => Effect.succeed(eventsResponse('session', [])),
        run: () => Effect.succeed(runResponse({
          root,
          node: root,
          diagnostics: runDiagnostics({
            incidents: [{
              id: 'incident-1',
              severity: 'error',
              category: 'tool',
              title: 'Tool failed',
              detail: 'The command exited non-zero.',
              ts: '2026-07-29T09:00:00.000Z',
              line: 9,
              key: 'session',
            }],
          }),
        })),
      })

      // An incident with no matching error event becomes a system event, so the
      // activity view is the one place that shows both.
      assert.deepStrictEqual(bodies(yield* atoms.get(activity.feed)), [
        'merged event',
        'The command exited non-zero.',
      ])
    }))

  it.effect('filters to one agent, and remembers that per session', () =>
    Effect.gen(function*() {
      const { atoms, activity } = yield* withActivity({
        sessionEvents: () => Effect.succeed(sessionEventsResponse('session', [], {
          events: [
            transcriptEvent('from the root', { agentKey: 'session' }),
            transcriptEvent('from the worker', { agentKey: 'session/worker' }),
          ],
        })),
        events: () => Effect.succeed(eventsResponse('session', [])),
        run: () => Effect.succeed(runResponse({ root, node: root })),
      })
      const chosen = activity.agent(activitySession('/repo', 'session'))

      assert.deepStrictEqual(bodies(yield* atoms.get(activity.feed)), [
        'from the root',
        'from the worker',
      ])

      yield* atoms.set(chosen, 'session/worker')

      assert.deepStrictEqual(bodies(yield* atoms.get(activity.feed)), ['from the worker'])
      // The choice is keyed on the session, so another session opens unfiltered.
      assert.strictEqual(
        yield* atoms.get(activity.agent(activitySession('/repo', 'other'))),
        'all',
      )
    }))

  it.effect('lists the session agents for the filter', () =>
    Effect.gen(function*() {
      const { atoms, activity } = yield* withActivity({
        sessionEvents: () => Effect.succeed(sessionEventsResponse('session', [])),
        events: () => Effect.succeed(eventsResponse('session', [])),
        run: () => Effect.succeed(runResponse({ root, node: root })),
      })

      assert.deepStrictEqual(
        (yield* atoms.get(activity.agents)).map(agent => agent.key),
        ['session', 'session/worker'],
      )
    }))
})
