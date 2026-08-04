import { describe, expect, it } from 'vitest'
import { parseArguments } from '../../bin/liveclaudecode'

describe('CLI arguments', () => {
  it('shows the last seven days by default', () => {
    expect(parseArguments([])).toMatchObject({
      project: '',
      port: 8787,
      host: '127.0.0.1',
      hours: 168,
      open: false,
      desktop: false,
      portExplicit: false,
    })
  })

  it('accepts a project and viewer options', () => {
    expect(parseArguments(['/repo', '--port', '9000', '--host', '0.0.0.0', '--hours', '3', '--open']))
      .toMatchObject({ project: '/repo', port: 9000, host: '0.0.0.0', hours: 3, open: true })
  })

  it('opens the desktop shell on request, leaving the port unpinned', () => {
    expect(parseArguments(['--desktop'])).toMatchObject({ desktop: true, portExplicit: false })
    expect(parseArguments(['--desktop', '-p', '9000'])).toMatchObject({ desktop: true, portExplicit: true, port: 9000 })
  })

  it('rejects unsafe or malformed values', () => {
    expect(() => parseArguments(['--port', '0'])).toThrow('Port')
    expect(() => parseArguments(['--hours', '-1'])).toThrow('Hours')
    expect(() => parseArguments(['--wat'])).toThrow('Unknown option')
  })
})
