export type ChartDatum = Record<string, string | number | undefined>

export type ChartCategory = {
  name: string
  color: string
}

export type ChartPadding = {
  top: number
  right: number
  bottom: number
  left: number
}

export type AreaChartProps<T extends ChartDatum> = {
  data: T[]
  categories: Record<string, ChartCategory>
  height?: number
  xKey?: keyof T & string
  xTicks?: number
  yTicks?: number
  yDomain?: [number | undefined, number | undefined]
  padding?: ChartPadding
  lineWidth?: number
  hideArea?: boolean
  hideLegend?: boolean
  hideTooltip?: boolean
  compact?: boolean
  ariaLabel?: string
  xFormatter?: (datum: T, index: number) => string
  yFormatter?: (value: number) => string
  tooltipTitleFormatter?: (datum: T, index: number) => string
}
