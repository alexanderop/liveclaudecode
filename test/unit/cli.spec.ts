import { describe, expect, it } from 'vitest'
import { parseArguments } from '../../bin/liveclaudecode'

describe('CLI arguments', () => {
  it('uses the same defaults as the original viewer', () => {
    expect(parseArguments([])).toMatchObject({
      project: '',
      port: 8787,
      host: '127.0.0.1',
      hours: 24,
      open: false,
    })
  })

  it('accepts a project and viewer options', () => {
    expect(parseArguments(['/repo', '--port', '9000', '--host', '0.0.0.0', '--hours', '3', '--open']))
      .toMatchObject({ project: '/repo', port: 9000, host: '0.0.0.0', hours: 3, open: true })
  })

  it('rejects unsafe or malformed values', () => {
    expect(() => parseArguments(['--port', '0'])).toThrow('Port')
    expect(() => parseArguments(['--hours', '-1'])).toThrow('Hours')
    expect(() => parseArguments(['--wat'])).toThrow('Unknown option')
  })
})
