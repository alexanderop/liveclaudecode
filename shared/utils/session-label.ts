const EMBEDDED_CONTEXT_BLOCKS = [
  'recommended_plugins',
  'environment_context',
  'app-context',
  'permissions instructions',
  'collaboration_mode',
  'apps_instructions',
  'plugins_instructions',
  'skills_instructions',
  'INSTRUCTIONS',
] as const

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Remove injected context before deriving a human-readable session title. */
export function normalizeSessionLabel(value: string, fallback = ''): string {
  let cleaned = value
  for (const tag of EMBEDDED_CONTEXT_BLOCKS) {
    const escaped = escapeRegExp(tag)
    cleaned = cleaned.replace(new RegExp(`<${escaped}[^>]*>[\\s\\S]*?<\\/${escaped}>`, 'gi'), ' ')
  }

  cleaned = cleaned
    .replace(/^\s*#\s*AGENTS\.md instructions[^\n]*$/gim, ' ')
    .replace(/^\s*#\s*(?:Agent guide|Codex desktop context)\s*$/gim, ' ')
    .replace(/<command-(?:name|message|args)>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[(?:Image|Attachment)\s*#?\d+\]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!cleaned || cleaned.startsWith('Caveat:')) return fallback
  return cleaned.slice(0, 120)
}
