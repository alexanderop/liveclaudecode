import type {
  EventsResponse,
  RunNode,
  RunResponse,
  SessionEventsResponse,
  SessionSourceStatus,
  TranscriptEvent,
  TreeResponse,
} from '#shared/types/run'
import { runNode, runResponse } from './runs'

export const browserProject = '/mock-project'

export function browserRunNode(overrides: Partial<RunNode> = {}): RunNode {
  return runNode({
    key: 'browser-session',
    sid: 'browser-session',
    label: 'Browser API session',
    errors: 0,
    subErrors: 0,
    ...overrides,
  })
}

export function browserTree(
  roots: RunNode[],
  options: {
    readonly sources?: SessionSourceStatus[]
    readonly includeProject?: boolean
  } = {},
): TreeResponse {
  return {
    projects: options.includeProject === false
      ? []
      : [{ id: browserProject, name: 'mock-project', roots }],
    sources: options.sources ?? [{
      source: 'claude',
      state: 'ready',
      sessions: roots.length,
      malformed: 0,
      message: '',
    }],
    now: Date.parse('2026-07-31T10:00:00.000Z'),
    hours: 168,
  }
}

export function browserRun(root: RunNode): RunResponse {
  return runResponse({
    key: root.key,
    transcriptPath: `/mock-project/${root.key}.jsonl`,
    node: root,
    root,
  })
}

export function browserTextEvent(
  body: string,
  line: number,
): TranscriptEvent {
  return {
    role: 'assistant',
    kind: 'text',
    ts: `2026-07-31T10:00:0${line}.000Z`,
    line,
    body,
  }
}

export function browserEvents(
  root: RunNode,
  events: TranscriptEvent[],
  options: Partial<Pick<EventsResponse, 'next' | 'revision' | 'reset'>> = {},
): EventsResponse {
  return {
    key: root.key,
    events,
    next: events.length,
    revision: 1,
    reset: false,
    node: root,
    ...options,
  }
}

export function browserSessionEvents(
  root: RunNode,
  events: TranscriptEvent[] = [],
): SessionEventsResponse {
  return {
    key: root.key,
    events,
    total: events.length,
    truncated: false,
  }
}
