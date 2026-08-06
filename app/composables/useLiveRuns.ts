import type { Ref, WritableComputedRef } from 'vue'
import type {
  CostSummaryWire,
  ProjectRunsWire,
  RunNodeWire,
  RunResponseWire,
  SessionSourceStatusWire,
  TranscriptEventWire,
} from '#shared/schemas/api'
import { useAtomSet, useAtomValue } from '@effect/atom-vue'
import { computed } from 'vue'
import type { SessionSort } from '~/utils/session-filter'
import type { ProjectOption, SessionSourceFilter } from '~/atoms/filters'
import type { FeedDensity } from '~/atoms/preferences'
import type { SessionRangeHours } from '~/atoms/range'
import { eventsAtoms, eventsKey } from '~/atoms/events'
import { filtersAtoms } from '~/atoms/filters'
import { preferencesAtoms } from '~/atoms/preferences'
import { rangeAtoms } from '~/atoms/range'
import { runAtoms, runKey } from '~/atoms/run-detail'
import { selectionAtoms } from '~/atoms/selection'
import { sessionEventsAtoms, sessionEventsKey } from '~/atoms/session-events'
import { treeAtoms } from '~/atoms/tree'
import { useAtomModel } from '~/composables/atom'
import { feedValue, toFeedView } from '~/utils/feed-view'

/** Stable empty, so a feed with nothing in it does not publish a new array. */
const NO_EVENTS: ReadonlyArray<TranscriptEventWire> = []

export interface UseLiveRunsReturn {
  /** All discovered projects with their session trees, unfiltered. */
  readonly projects: Readonly<Ref<ReadonlyArray<ProjectRunsWire>>>
  /** Per-source scanner status, e.g. a provider that failed to load. */
  readonly sources: Readonly<Ref<ReadonlyArray<SessionSourceStatusWire>>>
  /** Aggregated cost summary for the visible range, when available. */
  readonly costs: Readonly<Ref<CostSummaryWire | null>>
  /** True until the first tree response (or failure) arrives. */
  readonly loading: Readonly<Ref<boolean>>
  /** True while the *tree* poll is failing; cleared by its next success. */
  readonly offline: Readonly<Ref<boolean>>
  /** Projects with the sidebar filters applied. */
  readonly visibleProjects: Readonly<Ref<ProjectRunsWire[]>>
  /** All known projects as name-sorted select options, unfiltered. */
  readonly projectOptions: Readonly<Ref<ProjectOption[]>>
  /** Project id of the current selection, or `null` before the first load. */
  readonly selectedProject: Readonly<Ref<string | null>>
  /** Key of the selected agent, or `null` before the first load. */
  readonly selectedKey: Readonly<Ref<string | null>>
  /** Tree node of the selected agent, when it exists in the current tree. */
  readonly selectedNode: Readonly<Ref<RunNodeWire | null>>
  /** Root session node the selected agent belongs to. */
  readonly selectedRoot: Readonly<Ref<RunNodeWire | null>>
  /** Detail payload for the selected agent (lanes, files, diagnostics). */
  readonly run: Readonly<Ref<RunResponseWire | null>>
  /** Transcript events of the selected agent. */
  readonly events: Readonly<Ref<ReadonlyArray<TranscriptEventWire>>>
  /** Merged activity feed across every agent of the selected session. */
  readonly sessionEvents: Readonly<Ref<ReadonlyArray<TranscriptEventWire>>>
  /** True when the session feed hit the per-poll limit and dropped events. */
  readonly sessionEventsTruncated: Readonly<Ref<boolean>>
  /** Transcript events of the agent opened in the inspector overlay. */
  readonly inspectedEvents: Readonly<Ref<ReadonlyArray<TranscriptEventWire>>>
  /** True while the first inspector poll for a new target is in flight. */
  readonly inspectedEventsLoading: Readonly<Ref<boolean>>
  /** Free-text search across projects, session labels, and agents. */
  readonly query: WritableComputedRef<string>
  /** Restrict sessions to one transcript source. */
  readonly sourceFilter: WritableComputedRef<SessionSourceFilter>
  /** Restrict sessions to one project id, or `'all'`. */
  readonly projectFilter: WritableComputedRef<string>
  /** Show only sessions with live activity. */
  readonly liveOnly: WritableComputedRef<boolean>
  /** Show only finished sessions that ended with errors. */
  readonly attentionOnly: WritableComputedRef<boolean>
  /** Hide empty sessions that never recorded any activity. */
  readonly hideIdle: WritableComputedRef<boolean>
  /** Minimum number of subagents a session must have spawned. */
  readonly minimumSubagents: WritableComputedRef<number>
  /** Session ordering within a project. */
  readonly sessionSort: WritableComputedRef<SessionSort>
  /** Automatically follow the most recently active live agent. */
  readonly followActive: WritableComputedRef<boolean>
  /** Keep the event feed scrolled to the newest output. */
  readonly followOutput: WritableComputedRef<boolean>
  /** Show only error events in the feed. */
  readonly errorsOnly: WritableComputedRef<boolean>
  /** Rendering density of the event feed. */
  readonly density: WritableComputedRef<FeedDensity>
  /** Time range of sessions to show, in hours; `0` means all time. */
  readonly hours: WritableComputedRef<SessionRangeHours>
  /** Select an agent (and optionally another project) and load its detail. */
  readonly select: (key: string, project?: string | null) => Promise<void>
  /** Open an agent of the selected session in the inspector overlay. */
  readonly inspect: (key: string) => Promise<void>
  /** Close the inspector overlay and drop its stream. */
  readonly clearInspection: () => void
}

/**
 * The dashboard's state, as `index.vue` still reads it.
 *
 * Nothing is owned here any more. Every member is a binding to an atom, and the
 * only logic left is the shape of the object — which exists so `index.vue` did
 * not have to change in the same step as the transport beneath it. Stage 7
 * deletes this file and moves those bindings into the page.
 *
 * The four poll intervals, the `AbortController` pool, the two request gates,
 * the generation counters, and the `disposed` flag are all gone: a different
 * query is a different atom, an unobserved atom is interrupted, and an
 * interrupted `HttpClient` request aborts its own `fetch`.
 *
 * Every `useAtom*` call below happens during `setup()`, which is not a style
 * choice — `injectRegistry` falls back to a module-level singleton rather than
 * throwing, so a call from `onMounted` or a watcher would silently bind to
 * global state shared with every other component.
 */
export function useLiveRuns(): UseLiveRunsReturn {
  const projects = useAtomValue(() => treeAtoms.projects)
  const sources = useAtomValue(() => treeAtoms.sources)
  const costs = useAtomValue(() => treeAtoms.costs)
  const loading = useAtomValue(() => treeAtoms.loading)
  const offline = useAtomValue(() => treeAtoms.offline)
  const visibleProjects = useAtomValue(() => filtersAtoms.visibleProjects)
  const projectOptions = useAtomValue(() => filtersAtoms.projectOptions)

  const selectedProject = useAtomValue(() => selectionAtoms.project)
  const selectedKey = useAtomValue(() => selectionAtoms.key)
  const selectedNode = useAtomValue(() => selectionAtoms.node)
  const selectedRoot = useAtomValue(() => selectionAtoms.root)
  const inspectedKey = useAtomValue(() => selectionAtoms.inspected)
  const setSelection = useAtomSet(() => selectionAtoms.selection)
  const setInspected = useAtomSet(() => selectionAtoms.inspected)

  const query = useAtomModel(() => filtersAtoms.query)
  const sourceFilter = useAtomModel(() => filtersAtoms.source)
  const projectFilter = useAtomModel(() => filtersAtoms.project)
  const liveOnly = useAtomModel(() => filtersAtoms.liveOnly)
  const attentionOnly = useAtomModel(() => filtersAtoms.attentionOnly)
  const hideIdle = useAtomModel(() => filtersAtoms.hideIdle)
  const minimumSubagents = useAtomModel(() => filtersAtoms.minimumSubagents)
  const sessionSort = useAtomModel(() => filtersAtoms.sort)
  const followActive = useAtomModel(() => preferencesAtoms.followActive)
  const followOutput = useAtomModel(() => preferencesAtoms.followOutput)
  const errorsOnly = useAtomModel(() => preferencesAtoms.errorsOnly)
  const density = useAtomModel(() => preferencesAtoms.density)
  const hours = useAtomModel(() => rangeAtoms.hours)

  // Each thunk reads the refs above, so the subscription follows the selection:
  // choosing another agent swaps which atom this component is bound to, and the
  // node behind the old one is torn down with its in-flight request.
  const runResult = useAtomValue(() =>
    runAtoms.run(runKey(selectedProject.value, selectedKey.value, hours.value)))
  const eventsResult = useAtomValue(() =>
    eventsAtoms.events(eventsKey(selectedProject.value, selectedKey.value, hours.value)))
  const inspectedResult = useAtomValue(() =>
    eventsAtoms.events(eventsKey(selectedProject.value, inspectedKey.value, hours.value)))
  // Keyed on the session *root*: `/api/session-events` merges every agent
  // beneath it, so selecting a subagent must not restart this feed.
  const sessionResult = useAtomValue(() =>
    sessionEventsAtoms.sessionEvents(
      sessionEventsKey(
        selectedProject.value,
        selectedRoot.value?.key ?? selectedKey.value,
        hours.value,
      ),
    ))

  return {
    projects,
    sources,
    costs,
    loading,
    offline,
    visibleProjects,
    projectOptions,
    selectedProject,
    selectedKey,
    selectedNode,
    selectedRoot,
    run: computed(() => feedValue(runResult.value, response => response, null)),
    events: computed(() => feedValue(eventsResult.value, events => events, NO_EVENTS)),
    sessionEvents: computed(() =>
      feedValue(sessionResult.value, response => response.events, NO_EVENTS)),
    sessionEventsTruncated: computed(() =>
      feedValue(sessionResult.value, response => response.truncated, false)),
    inspectedEvents: computed(() => feedValue(inspectedResult.value, events => events, NO_EVENTS)),
    // Only while something is inspected: with the overlay closed the feed is
    // gated off and sits at `loading` forever, which is not a spinner anybody
    // should see.
    inspectedEventsLoading: computed(() =>
      Boolean(inspectedKey.value) && toFeedView(inspectedResult.value).tag === 'loading'),
    query,
    sourceFilter,
    projectFilter,
    liveOnly,
    attentionOnly,
    hideIdle,
    minimumSubagents,
    sessionSort,
    followActive,
    followOutput,
    errorsOnly,
    density,
    hours,
    /**
     * Selecting is one write. The detail, the transcript, and the session feed
     * follow because they are keyed on it — there is nothing here to clear, and
     * nothing to await: the caller used to await three requests it then ignored.
     */
    select: (key, project = selectedProject.value) => {
      if (project) setSelection({ project, key })
      return Promise.resolve()
    },
    inspect: (key) => {
      setInspected(key)
      return Promise.resolve()
    },
    clearInspection: () => setInspected(null),
  }
}
