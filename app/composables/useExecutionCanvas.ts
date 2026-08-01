import {
  inject,
  provide,
  type InjectionKey,
  type Ref,
} from 'vue'
import type { ExecutionDirection } from '~/utils/execution-graph'

export interface ExecutionCanvasContext {
  /** Current layout direction of the canvas. */
  layoutDirection: Readonly<Ref<ExecutionDirection>>
  /** Select an agent node on the canvas. */
  selectNode: (key: string) => void
  /** Expand or collapse an agent node. */
  toggleNode: (key: string) => void
}

export const ExecutionCanvasKey: InjectionKey<ExecutionCanvasContext>
  = Symbol('ExecutionCanvas')

/** Provide the canvas context to descendant agent nodes; call in RunCanvas. */
export function provideExecutionCanvas(context: ExecutionCanvasContext): void {
  provide(ExecutionCanvasKey, context)
}

/**
 * Access the canvas context from an agent node.
 *
 * @throws when the component is rendered outside a RunCanvas subtree.
 */
export function useExecutionCanvas(): ExecutionCanvasContext {
  const context = inject(ExecutionCanvasKey)
  if (!context) throw new Error('ExecutionAgentNode must be rendered inside RunCanvas')
  return context
}
