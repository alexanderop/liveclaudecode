/**
 * Session selection — step 2 of the recorder pipeline.
 *
 * Locating a session means locating everything the producing tool associates
 * with it, because a cassette is laid out natively so that replay exercises
 * *discovery* and not only parsing. Claude Code keeps subagents in a sibling
 * directory with `.meta.json` companions; Codex keeps one rollout under a
 * day directory; Copilot CLI keeps a whole session directory; VS Code keeps a
 * chat log under a workspace-storage directory whose `workspace.json` supplies
 * the project attribution.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import type { CassetteSource } from '../../test/cassettes/redaction/rules.ts'
import { type ResolvedRoots, SOURCES } from './sources.ts'

export interface SelectedFile {
  /** Absolute path on the capture machine. */
  readonly absolutePath: string
  /** Path inside the cassette, below `files/`. */
  readonly cassettePath: string
  readonly content: string
  /** Seconds since epoch, as `FakeEntry.mtime` and the scanners use. */
  readonly mtime: number
  /** JSONL transcripts are truncated and clipped; sidecars are copied whole. */
  readonly kind: 'transcript' | 'sidecar'
}

export interface Selection {
  readonly source: CassetteSource
  readonly files: readonly SelectedFile[]
  /** The tool root the selection came from, for relative-path reporting. */
  readonly root: string
}

export class SelectionError extends Error {}

function read(absolutePath: string, cassettePath: string, kind: SelectedFile['kind']): SelectedFile {
  const info = statSync(absolutePath)
  return {
    absolutePath,
    cassettePath,
    content: readFileSync(absolutePath, 'utf8'),
    mtime: Math.floor(info.mtimeMs / 1_000),
    kind,
  }
}

function listDirectory(path: string): string[] {
  try {
    return readdirSync(path).sort((left, right) => left.localeCompare(right))
  } catch {
    return []
  }
}

function exists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Claude Code: `<slug>/<sessionId>.jsonl`, plus
 * `<slug>/<sessionId>/subagents/<agentId>.jsonl` and its `.meta.json` sibling.
 */
function selectClaude(root: string, sessionId: string): SelectedFile[] {
  const subtree = SOURCES.claude.subtree
  for (const slug of listDirectory(root)) {
    const transcript = join(root, slug, `${sessionId}.jsonl`)
    if (!exists(transcript)) continue

    const files = [read(transcript, `${subtree}/${slug}/${sessionId}.jsonl`, 'transcript')]
    const subagents = join(root, slug, sessionId, 'subagents')
    for (const name of listDirectory(subagents)) {
      const absolute = join(subagents, name)
      if (!statSync(absolute).isFile()) continue
      const cassettePath = `${subtree}/${slug}/${sessionId}/subagents/${name}`
      if (name.endsWith('.jsonl')) files.push(read(absolute, cassettePath, 'transcript'))
      else if (name.endsWith('.meta.json')) files.push(read(absolute, cassettePath, 'sidecar'))
    }
    return files
  }
  throw new SelectionError(`No Claude transcript ${sessionId}.jsonl under any project of ${root}`)
}

/** Codex: one `YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, and nothing else. */
function selectCodex(root: string, sessionId: string): SelectedFile[] {
  const subtree = SOURCES.codex.subtree
  for (const year of listDirectory(root)) {
    for (const month of listDirectory(join(root, year))) {
      for (const day of listDirectory(join(root, year, month))) {
        const directory = join(root, year, month, day)
        for (const name of listDirectory(directory)) {
          if (!name.endsWith(`${sessionId}.jsonl`)) continue
          return [read(
            join(directory, name),
            `${subtree}/${year}/${month}/${day}/${name}`,
            'transcript',
          )]
        }
      }
    }
  }
  throw new SelectionError(`No Codex rollout for session ${sessionId} under ${root}`)
}

/**
 * Copilot CLI: `<sessionId>/events.jsonl`, and only that.
 *
 * The session directory also holds `session.db`, `workspace.yaml`,
 * `checkpoints/`, and a `files/` cache. None of it is read by
 * `scanCopilotCliRoot`, some of it is binary, and all of it would be committed
 * unredacted — a cassette carries what the product reads and nothing else.
 */
function selectCopilotCli(root: string, sessionId: string): SelectedFile[] {
  const subtree = SOURCES['copilot-cli'].subtree
  const events = join(root, sessionId, 'events.jsonl')
  if (!exists(events)) {
    throw new SelectionError(`No Copilot CLI events.jsonl for session ${sessionId} under ${root}`)
  }
  return [read(events, `${subtree}/${sessionId}/events.jsonl`, 'transcript')]
}

/**
 * VS Code Copilot Chat: `workspaceStorage/<id>/chatSessions/<uuid>.jsonl`, plus
 * the `workspace.json` that gives the session its project attribution — without
 * it, `copilot-runs.ts` files the session under no project at all.
 */
function selectCopilot(roots: readonly string[], sessionId: string): SelectedFile[] {
  const subtree = SOURCES.copilot.subtree
  for (const root of roots) {
    const storage = join(root, 'workspaceStorage')
    for (const workspace of listDirectory(storage)) {
      const transcript = join(storage, workspace, 'chatSessions', `${sessionId}.jsonl`)
      if (!exists(transcript)) continue

      const files = [read(
        transcript,
        `${subtree}/workspaceStorage/${workspace}/chatSessions/${sessionId}.jsonl`,
        'transcript',
      )]
      const metadata = join(storage, workspace, 'workspace.json')
      if (exists(metadata)) {
        files.push(read(
          metadata,
          `${subtree}/workspaceStorage/${workspace}/workspace.json`,
          'sidecar',
        ))
      }
      return files
    }
  }
  throw new SelectionError(
    `No VS Code chat session ${sessionId}.jsonl under ${roots.join(', ')}`,
  )
}

/**
 * One selector per source, each taking every root its tool is configured with.
 *
 * A table rather than a dispatch: adding a source is one entry that will not
 * compile until it has a selector, instead of another arm threaded through a
 * conditional.
 */
const SELECTORS: Readonly<
  Record<CassetteSource, (roots: readonly string[], sessionId: string) => SelectedFile[]>
> = {
  // Only VS Code is configured with several roots — stable and Insiders. The
  // rest take the first, which is the only one their descriptor yields.
  'copilot': selectCopilot,
  'claude': (roots, sessionId) => selectClaude(roots[0] ?? '', sessionId),
  'codex': (roots, sessionId) => selectCodex(roots[0] ?? '', sessionId),
  'copilot-cli': (roots, sessionId) => selectCopilotCli(roots[0] ?? '', sessionId),
}

export function selectSession(
  source: CassetteSource,
  sessionId: string,
  roots: ResolvedRoots,
): Selection {
  const candidates = roots[source]
  return {
    source,
    files: SELECTORS[source](candidates, sessionId),
    root: candidates[0] ?? '',
  }
}

/** A human-readable location for the review summary, never committed. */
export function describeSelection(selection: Selection): string {
  return selection.files
    .map(file => `  ${relative(selection.root, file.absolutePath) || basename(file.absolutePath)}`)
    .join('\n')
}
