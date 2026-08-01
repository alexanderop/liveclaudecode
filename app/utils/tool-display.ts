/** Human labels for well-known transcript tools shown in event feeds. */
export const TOOL_LABELS: Readonly<Record<string, string>> = {
  Read: 'Read file',
  Grep: 'Searched code',
  Glob: 'Located files',
  Bash: 'Ran command',
  Edit: 'Edited file',
  Write: 'Wrote file',
  Agent: 'Delegated work',
  Task: 'Delegated work',
  TodoWrite: 'Updated plan',
  WebSearch: 'Searched the web',
  WebFetch: 'Read web page',
}

/** Icon names for well-known transcript tools shown in event feeds. */
export const TOOL_FEED_ICONS: Readonly<Record<string, string>> = {
  Read: 'i-lucide-file-search',
  Grep: 'i-lucide-search',
  Glob: 'i-lucide-folder-search',
  Bash: 'i-lucide-square-terminal',
  Edit: 'i-lucide-file-pen-line',
  Write: 'i-lucide-file-plus-2',
  Agent: 'i-lucide-git-fork',
  Task: 'i-lucide-git-fork',
  TodoWrite: 'i-lucide-list-checks',
  WebSearch: 'i-lucide-globe-2',
  WebFetch: 'i-lucide-globe-2',
}

/** Feed label for a tool-use event, falling back to the raw tool name. */
export function toolUseLabel(tool: string | undefined): string {
  return TOOL_LABELS[tool || ''] || tool || 'Used tool'
}

/** Feed icon for a tool-use event, falling back to a generic wrench. */
export function toolUseIcon(tool: string | undefined): string {
  return TOOL_FEED_ICONS[tool || ''] || 'i-lucide-wrench'
}
