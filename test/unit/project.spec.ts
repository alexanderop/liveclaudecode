import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  listProjectDirectories,
  projectDirectoryFor,
  resolveProjectDirectories,
  resolveProjectDirectory,
} from '#server/utils/project'

describe('project resolution', () => {
  let directory: string
  let projects: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'liveclaudecode-project-'))
    projects = join(directory, 'projects')
    await mkdir(projects)
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('uses Claude Code slugification for a repository path', () => {
    expect(projectDirectoryFor('/Users/me/code/app', projects)).toBe(join(projects, '-Users-me-code-app'))
  })

  it('accepts a transcript directory directly', async () => {
    const transcripts = join(directory, 'transcripts')
    await mkdir(transcripts)
    await writeFile(join(transcripts, 'run.jsonl'), '{}\n')
    expect(await resolveProjectDirectory(transcripts, directory, projects)).toBe(transcripts)
  })

  it('resolves a repository path through its transcript slug', async () => {
    const repository = join(directory, 'repo')
    await mkdir(repository)
    const transcriptDirectory = projectDirectoryFor(repository, projects)
    await mkdir(transcriptDirectory)
    expect(await resolveProjectDirectory(repository, directory, projects)).toBe(transcriptDirectory)
  })

  it('resolves a slug under the projects directory', async () => {
    const transcriptDirectory = join(projects, 'my-project')
    await mkdir(transcriptDirectory)
    expect(await resolveProjectDirectory('my-project', directory, projects)).toBe(transcriptDirectory)
  })

  it('discovers every project directory containing a JSONL transcript', async () => {
    const first = join(projects, 'first')
    const second = join(projects, 'second')
    const empty = join(projects, 'empty')
    await Promise.all([mkdir(first), mkdir(second), mkdir(empty)])
    await Promise.all([
      writeFile(join(first, 'one.jsonl'), '{}\n'),
      writeFile(join(second, 'two.jsonl'), '{}\n'),
    ])

    expect(await listProjectDirectories(projects)).toEqual([
      { id: 'first', directory: first },
      { id: 'second', directory: second },
    ])
    expect(await resolveProjectDirectories('', directory, projects)).toEqual([
      { id: 'first', directory: first },
      { id: 'second', directory: second },
    ])
  })
})
