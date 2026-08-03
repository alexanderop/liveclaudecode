/**
 * A Comark AST node: `[tag, props, ...children]`, where children are either
 * nested nodes or text.
 */
export type ComarkNode = string | [tag: string, props?: unknown, ...children: unknown[]]

/**
 * Extracts the raw text of a Comark fence node.
 *
 * Comark renders code fences as `['pre', attrs, ['code', attrs, text]]` and
 * exposes the node to a custom `pre` component rather than passing the source
 * as a prop, so the text has to be read back out of the tree.
 */
export function comarkCodeText(node: unknown): string {
  if (typeof node === 'string') return node
  if (!Array.isArray(node)) return ''

  let text = ''
  for (const child of node.slice(2)) text += comarkCodeText(child)
  return text
}
