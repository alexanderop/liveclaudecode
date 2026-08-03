import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AreaChart from '~/components/charts/AreaChart.vue'

// The chart projects data into a fixed 800x240 viewBox. With the default
// padding (top 12, right 14, bottom 28, left 44) the plot area is 742x200,
// so for a 0..10 domain: x(0)=44, x(1)=415, x(2)=786; y(0)=212, y(5)=112,
// y(10)=12.
const data = [
  { day: 'Mon', value: 0 },
  { day: 'Tue', value: 5 },
  { day: 'Wed', value: 10 },
]
const categories = { value: { name: 'Errors', color: '#ff2200' } }

let component: VueWrapper | null = null

afterEach(() => {
  component?.unmount()
  component = null
})

function mockChartBounds(svg: { readonly element: Element }): void {
  vi.spyOn(svg.element, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 800,
    bottom: 240,
    width: 800,
    height: 240,
    toJSON: () => ({}),
  } as DOMRect)
}

describe('AreaChart', () => {
  it('scales a known series into the fixed view box', async () => {
    const wrapper = component = await mountSuspended(AreaChart, {
      props: { data, categories, xKey: 'day' },
    })

    const line = wrapper.get('svg path[fill="none"]')
    expect(line.attributes('stroke')).toBe('#ff2200')
    expect(line.attributes('stroke-width')).toBe('2.5')
    expect(line.attributes('d')).toMatch(/^M 44\.00 212\.00/)
    expect(line.attributes('d')).toContain('415.00 112.00')
    expect(line.attributes('d')).toMatch(/786\.00 12\.00$/)

    const area = wrapper.get('svg path[fill^="url(#"]')
    expect(area.attributes('d')).toMatch(/L 786\.00 212\.00 L 44\.00 212\.00 Z$/)
  })

  it('renders legend, grid lines, and axis labels from the series', async () => {
    const wrapper = component = await mountSuspended(AreaChart, {
      props: { data, categories, xKey: 'day', yFormatter: (value: number) => `${value}u` },
    })

    expect(wrapper.get('.chart-legend').text()).toContain('Errors')
    expect(wrapper.findAll('.chart-grid path')).toHaveLength(5)
    expect(wrapper.findAll('.chart-y-labels span').map(label => label.text()))
      .toEqual(['0u', '2.5u', '5u', '7.5u', '10u'])
    expect(wrapper.findAll('.chart-x-labels span').map(label => label.text()))
      .toEqual(['Mon', 'Tue', 'Wed'])
    expect(wrapper.get('svg').attributes('role')).toBe('img')
    expect(wrapper.get('svg').attributes('aria-label')).toBe('Data chart')
  })

  it('draws a labelled vertical rule at each marker index', async () => {
    const wrapper = component = await mountSuspended(AreaChart, {
      props: {
        data,
        categories,
        xKey: 'day',
        markers: [{ index: 1, label: 'Compaction · auto' }],
      },
    })

    const marker = wrapper.get('.chart-markers path')
    expect(marker.attributes('d')).toBe('M 415 12 L 415 212')
    expect(marker.get('title').text()).toBe('Compaction · auto')
  })

  it('ignores a marker pointing past the plotted data', async () => {
    const wrapper = component = await mountSuspended(AreaChart, {
      props: {
        data,
        categories,
        xKey: 'day',
        markers: [{ index: 3, label: 'off the end' }, { index: -1, label: 'before the start' }],
      },
    })

    expect(wrapper.find('.chart-markers').exists()).toBe(false)
  })

  it('highlights the nearest point on pointer move and emits it on click', async () => {
    const wrapper = component = await mountSuspended(AreaChart, {
      props: { data, categories, xKey: 'day' },
    })
    const svg = wrapper.get('svg')
    mockChartBounds(svg)

    await svg.trigger('pointermove', { clientX: 786 })

    expect(wrapper.get('.chart-crosshair path.chart-point').attributes('fill')).toBe('#ff2200')
    expect(wrapper.get('.chart-tooltip strong').text()).toBe('Wed')
    expect(wrapper.get('.chart-tooltip b').text()).toBe('10')

    await svg.trigger('click')
    expect(wrapper.emitted('click')).toEqual([[data[2], 2]])

    await svg.trigger('pointermove', { clientX: 415 })
    expect(wrapper.get('.chart-tooltip strong').text()).toBe('Tue')
    expect(wrapper.get('.chart-tooltip b').text()).toBe('5')

    await svg.trigger('pointerleave')
    expect(wrapper.find('.chart-tooltip').exists()).toBe(false)
    expect(wrapper.find('.chart-crosshair').exists()).toBe(false)
  })

  it('uses the tooltip title formatter over the axis label', async () => {
    const wrapper = component = await mountSuspended(AreaChart, {
      props: {
        data,
        categories,
        xKey: 'day',
        tooltipTitleFormatter: (datum, index) => `${datum.day} #${index}`,
      },
    })
    const svg = wrapper.get('svg')
    mockChartBounds(svg)

    await svg.trigger('pointermove', { clientX: 44 })
    expect(wrapper.get('.chart-tooltip strong').text()).toBe('Mon #0')
  })

  it('renders empty paths and ignores hover for an empty series', async () => {
    const wrapper = component = await mountSuspended(AreaChart, {
      props: { data: [], categories },
    })
    const svg = wrapper.get('svg')
    mockChartBounds(svg)

    expect(wrapper.get('svg path[fill="none"]').attributes('d')).toBe('')
    expect(wrapper.get('svg path[fill^="url(#"]').attributes('d')).toBe('')
    expect(wrapper.findAll('.chart-x-labels span')).toHaveLength(0)

    await svg.trigger('pointermove', { clientX: 400 })
    expect(wrapper.find('.chart-crosshair').exists()).toBe(false)
    await svg.trigger('click')
    expect(wrapper.emitted('click')).toBeUndefined()
  })

  it('centers a single-point series in the plot area', async () => {
    const wrapper = component = await mountSuspended(AreaChart, {
      props: { data: [{ day: 'Mon', value: 10 }], categories, xKey: 'day' },
    })

    expect(wrapper.get('svg path[fill="none"]').attributes('d')).toBe('M 415 12')
  })

  it('drops chrome in compact mode and honors hide flags', async () => {
    const wrapper = component = await mountSuspended(AreaChart, {
      props: { data, categories, compact: true, hideLegend: true, hideTooltip: true },
    })
    const svg = wrapper.get('svg')
    mockChartBounds(svg)

    expect(wrapper.get('.chart-root').classes()).toContain('compact')
    expect(wrapper.find('.chart-legend').exists()).toBe(false)
    expect(wrapper.find('.chart-grid').exists()).toBe(false)
    expect(wrapper.find('.chart-y-labels').exists()).toBe(false)
    expect(wrapper.find('.chart-x-labels').exists()).toBe(false)

    await svg.trigger('pointermove', { clientX: 415 })
    expect(wrapper.find('.chart-tooltip').exists()).toBe(false)
    expect(wrapper.find('.chart-crosshair').exists()).toBe(false)
  })
})
