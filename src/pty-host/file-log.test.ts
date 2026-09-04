import { describe, expect, it, vi } from 'vitest'

import { createFileLogger } from './file-log'

describe('createFileLogger', () => {
  it('appends one timestamped line per message', () => {
    const appendLine = vi.fn()
    const log = createFileLogger('C:\\Users\\Dev\\AppData\\pty-host.log', appendLine, () => new Date('2026-09-04T10:11:12.000Z'), 4242)

    log('Listening on the endpoint.')
    log('Client detached.')

    expect(appendLine.mock.calls).toEqual([
      ['C:\\Users\\Dev\\AppData\\pty-host.log', '2026-09-04T10:11:12.000Z [4242] Listening on the endpoint.\n'],
      ['C:\\Users\\Dev\\AppData\\pty-host.log', '2026-09-04T10:11:12.000Z [4242] Client detached.\n']
    ])
  })

  it.each([undefined, ''])('does nothing when the host was started without a log path (%s)', (filePath) => {
    const appendLine = vi.fn()
    const log = createFileLogger(filePath, appendLine)

    expect(() => log('Nowhere to write this.')).not.toThrow()
    expect(appendLine).not.toHaveBeenCalled()
  })

  it('swallows an unwritable log rather than taking the sessions down with it', () => {
    const appendLine = vi.fn(() => {
      throw new Error('ENOSPC')
    })
    const log = createFileLogger('/tmp/pty-host.log', appendLine)

    expect(() => log('Something worth logging.')).not.toThrow()
    expect(appendLine).toHaveBeenCalledOnce()
  })
})
