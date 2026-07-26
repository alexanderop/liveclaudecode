import process from 'node:process'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { readdir, stat } from 'node:fs/promises'

export const PROJECTS_DIRECTORY = join(homedir(), '.claude', 'projects')

export interface ProjectDirectory {
  id: string
  directory: string
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function containsTranscript(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).some(name => name.endsWith('.jsonl'))
  } catch {
    return false
  }
}

export function projectDirectoryFor(cwd: string, projectsDirectory = PROJECTS_DIRECTORY): string {
  return join(projectsDirectory, cwd.replaceAll('/', '-'))
}

export async function newestProjectDirectory(projectsDirectory = PROJECTS_DIRECTORY): Promise<string> {
  let entries
  try {
    entries = await readdir(projectsDirectory, { withFileTypes: true })
  } catch {
    throw new Error(`No transcripts found under ${projectsDirectory}`)
  }

  const directories = await Promise.all(
    entries
      .filter(entry => entry.isDirectory())
      .map(async entry => {
        const path = join(projectsDirectory, entry.name)
        return { path, mtime: (await stat(path)).mtimeMs }
      }),
  )
  const newest = directories.sort((a, b) => b.mtime - a.mtime)[0]
  if (!newest) throw new Error(`No transcripts found under ${projectsDirectory}`)
  return newest.path
}

export async function listProjectDirectories(
  projectsDirectory = PROJECTS_DIRECTORY,
): Promise<ProjectDirectory[]> {
  let entries
  try {
    entries = await readdir(projectsDirectory, { withFileTypes: true })
  } catch {
    throw new Error(`No transcripts found under ${projectsDirectory}`)
  }

  const projects = await Promise.all(entries
    .filter(entry => entry.isDirectory())
    .map(async (entry): Promise<ProjectDirectory | null> => {
      const directory = join(projectsDirectory, entry.name)
      return (await containsTranscript(directory))
        ? { id: entry.name, directory }
        : null
    }))

  return projects
    .filter((project): project is ProjectDirectory => project !== null)
    .sort((a, b) => a.id.localeCompare(b.id))
}

export async function resolveProjectDirectories(
  input = '',
  cwd = process.cwd(),
  projectsDirectory = PROJECTS_DIRECTORY,
): Promise<ProjectDirectory[]> {
  if (!input) return listProjectDirectories(projectsDirectory)
  const directory = await resolveProjectDirectory(input, cwd, projectsDirectory)
  return [{ id: basename(directory), directory }]
}

export async function resolveProjectDirectory(
  input = '',
  cwd = process.cwd(),
  projectsDirectory = PROJECTS_DIRECTORY,
): Promise<string> {
  if (input) {
    const expanded = input.startsWith('~/') ? join(homedir(), input.slice(2)) : input
    const candidate = isAbsolute(expanded) ? expanded : resolve(cwd, expanded)
    if (await isDirectory(candidate)) {
      if (await containsTranscript(candidate)) return candidate
      const guessed = projectDirectoryFor(candidate, projectsDirectory)
      if (await isDirectory(guessed)) return guessed
    }

    const slug = join(projectsDirectory, input)
    if (await isDirectory(slug)) return slug
    throw new Error(`No transcripts for ${JSON.stringify(input)} under ${projectsDirectory}`)
  }

  const current = projectDirectoryFor(cwd, projectsDirectory)
  return (await isDirectory(current)) ? current : newestProjectDirectory(projectsDirectory)
}

export function projectName(projectDirectory: string): string {
  return basename(projectDirectory)
}
