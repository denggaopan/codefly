import { describe, expect, it } from 'vitest'

import { FirstInputTracker } from './first-input-tracker'

describe('FirstInputTracker', () => {
  it('captures printable chunks and paste while forwarding each chunk unchanged', () => {
    const tracker = new FirstInputTracker()

    expect(tracker.push('fix ')).toEqual({ passthrough: 'fix ' })
    expect(tracker.push('skipped trades')).toEqual({ passthrough: 'skipped trades' })
    expect(tracker.push('\r')).toEqual({ passthrough: '\r', submitted: 'fix skipped trades' })
  })

  it('ignores complete and chunked ANSI sequences in captured input', () => {
    const tracker = new FirstInputTracker()

    expect(tracker.push('ab\u001b[D')).toEqual({ passthrough: 'ab\u001b[D' })
    expect(tracker.push('\u001b[')).toEqual({ passthrough: '\u001b[' })
    expect(tracker.push('1;5Ccd\r')).toEqual({ passthrough: '1;5Ccd\r', submitted: 'abcd' })
  })

  it('ignores SS3 and string-control ANSI sequences', () => {
    const tracker = new FirstInputTracker()

    expect(tracker.push('a\u001bOA')).toEqual({ passthrough: 'a\u001bOA' })
    expect(tracker.push('\u001bPignored')).toEqual({ passthrough: '\u001bPignored' })
    expect(tracker.push('\u001b\\b\r')).toEqual({ passthrough: '\u001b\\b\r', submitted: 'ab' })
  })

  it('captures bracketed paste content but not its ANSI markers', () => {
    const tracker = new FirstInputTracker()

    expect(tracker.push('\u001b[200~修复 skipped trades\u001b[201~\r')).toEqual({
      passthrough: '\u001b[200~修复 skipped trades\u001b[201~\r',
      submitted: '修复 skipped trades'
    })
  })

  it('backspaces one Unicode code point', () => {
    const tracker = new FirstInputTracker()

    expect(tracker.push('A😀B\u007f\u0008C\n')).toEqual({ passthrough: 'A😀B\u007f\u0008C\n', submitted: 'AC' })
  })

  it('keeps waiting after empty and whitespace-only lines', () => {
    const tracker = new FirstInputTracker()

    expect(tracker.push('\r\n')).toEqual({ passthrough: '\r\n' })
    expect(tracker.push('   \n')).toEqual({ passthrough: '   \n' })
    expect(tracker.push('real input\r')).toEqual({ passthrough: 'real input\r', submitted: 'real input' })
  })

  it('does not treat CRLF as two submissions', () => {
    const tracker = new FirstInputTracker()

    expect(tracker.push('first\r')).toEqual({ passthrough: 'first\r', submitted: 'first' })
    expect(tracker.push('\nsecond\r')).toEqual({ passthrough: '\nsecond\r' })
  })

  it('returns the first nonempty submission only once forever', () => {
    const tracker = new FirstInputTracker()

    expect(tracker.push('first\nsecond\n')).toEqual({ passthrough: 'first\nsecond\n', submitted: 'first' })
    expect(tracker.push('third\r')).toEqual({ passthrough: 'third\r' })
  })

  it('ignores OSC and other control sequences while retaining printable Unicode', () => {
    const tracker = new FirstInputTracker()

    expect(tracker.push('\u001b]0;window title\u0007你\u0000\u009c好\r')).toEqual({
      passthrough: '\u001b]0;window title\u0007你\u0000\u009c好\r',
      submitted: '你好'
    })
  })
})
