import {
  inject,
  type InjectionKey,
  type Ref,
} from 'vue'
import type { ExecutionDirection } from '~/utils/execution-graph'

export interface ExecutionCanvasContext {
  layoutDirection: Readonly<Ref<ExecutionDirection>>
  selectNode: (key: string) => void
}

export const ExecutionCanvasKey: InjectionKey<ExecutionCanvasContext>
  = Symbol('ExecutionCanvas')

export function useExecutionCanvas(): ExecutionCanvasContext {
  const context = inject(ExecutionCanvasKey)
  if (!context) throw new Error('ExecutionAgentNode must be rendered inside RunCanvas')
  return context
}
