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

function cleanSessionText(value: string): string {
  let cleaned = value
  for (const tag of EMBEDDED_CONTEXT_BLOCKS) {
    const escaped = escapeRegExp(tag)
    cleaned = cleaned.replace(new RegExp(`<${escaped}[^>]*>[\\s\\S]*?<\\/${escaped}>`, 'gi'), ' ')
  }

  cleaned = cleaned
    .replace(/<image\b[^>]*>[\s\S]*?<\/image>/gi, ' ')
    .replace(/^\s*#\s*AGENTS\.md instructions[^\n]*$/gim, ' ')
    .replace(/^\s*#\s*(?:Agent guide|Codex desktop context)\s*$/gim, ' ')
    .replace(/^\s*#{1,6}\s*Files mentioned by the user:\s*$/gim, ' ')
    .replace(/^\s*#{1,6}\s+[^:\n]+:\s+\/(?:Users|private|var|tmp)\/[^\n]*$/gim, ' ')
    .replace(/<command-(?:name|message|args)>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[(?:Image|Attachment)\s*#?\d+\]/gi, ' ')
    .replace(/::[a-z][\w-]*(?:\{[^}\n]*\})?/gi, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return cleaned
}

/** Remove injected context before deriving a human-readable session title. */
export function normalizeSessionLabel(value: string, fallback = ''): string {
  const cleaned = cleanSessionText(value)

  if (!cleaned || cleaned.startsWith('Caveat:')) return fallback
  return cleaned.slice(0, 120)
}

/** Produce a compact, presentation-safe result excerpt without internal UI directives. */
export function normalizeSessionSummary(value: string, fallback = ''): string {
  const cleaned = cleanSessionText(value)
  if (!cleaned) return fallback
  return cleaned.length > 360 ? `${cleaned.slice(0, 357)}…` : cleaned
}
