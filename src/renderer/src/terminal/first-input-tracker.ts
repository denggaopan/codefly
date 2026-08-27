export type FirstInputResult = { submitted?: string; passthrough: string }

type EscapeState = 'normal' | 'escape' | 'csi' | 'ss3' | 'osc' | 'osc-escape' | 'string' | 'string-escape'

export class FirstInputTracker {
  private captured = ''
  private complete = false
  private escapeState: EscapeState = 'normal'
  private previousWasCarriageReturn = false

  push(data: string): FirstInputResult {
    const result: FirstInputResult = { passthrough: data }
    if (this.complete) return result

    for (const character of data) {
      if (this.consumeEscape(character)) continue

      if (character === '\r') {
        this.previousWasCarriageReturn = true
        const submitted = this.submitLine()
        if (submitted !== undefined) {
          result.submitted = submitted
          break
        }
        continue
      }
      if (character === '\n') {
        if (this.previousWasCarriageReturn) {
          this.previousWasCarriageReturn = false
          continue
        }
        const submitted = this.submitLine()
        if (submitted !== undefined) {
          result.submitted = submitted
          break
        }
        continue
      }
      this.previousWasCarriageReturn = false

      if (character === '\b' || character === '\u007f') {
        const points = Array.from(this.captured)
        points.pop()
        this.captured = points.join('')
        continue
      }
      const codePoint = character.codePointAt(0)
      if (codePoint !== undefined && codePoint >= 0x20 && (codePoint < 0x7f || codePoint > 0x9f)) {
        this.captured += character
      }
    }
    return result
  }

  private submitLine(): string | undefined {
    const submitted = this.captured.trim()
    this.captured = ''
    if (submitted.length === 0) return undefined
    this.complete = true
    return submitted
  }

  private consumeEscape(character: string): boolean {
    if (this.escapeState === 'normal') {
      if (character === '\u001b') {
        this.escapeState = 'escape'
        return true
      }
      if (character === '\u009b') {
        this.escapeState = 'csi'
        return true
      }
      if (character === '\u008f') {
        this.escapeState = 'ss3'
        return true
      }
      if (character === '\u009d') {
        this.escapeState = 'osc'
        return true
      }
      if (['\u0090', '\u0098', '\u009e', '\u009f'].includes(character)) {
        this.escapeState = 'string'
        return true
      }
      return false
    }

    if (this.escapeState === 'escape') {
      if (character === '[') this.escapeState = 'csi'
      else if (character === ']') this.escapeState = 'osc'
      else if (character === 'O') this.escapeState = 'ss3'
      else if (['P', 'X', '^', '_'].includes(character)) this.escapeState = 'string'
      else this.escapeState = 'normal'
      return true
    }

    if (this.escapeState === 'csi') {
      const codePoint = character.codePointAt(0) ?? 0
      if (codePoint >= 0x40 && codePoint <= 0x7e) this.escapeState = 'normal'
      return true
    }

    if (this.escapeState === 'ss3') {
      this.escapeState = 'normal'
      return true
    }

    if (this.escapeState === 'osc') {
      if (character === '\u0007' || character === '\u009c') this.escapeState = 'normal'
      else if (character === '\u001b') this.escapeState = 'osc-escape'
      return true
    }

    if (this.escapeState === 'osc-escape') {
      if (character === '\\') this.escapeState = 'normal'
      else if (character !== '\u001b') this.escapeState = 'osc'
      return true
    }

    if (this.escapeState === 'string') {
      if (character === '\u009c') this.escapeState = 'normal'
      else if (character === '\u001b') this.escapeState = 'string-escape'
      return true
    }

    if (character === '\\') this.escapeState = 'normal'
    else if (character !== '\u001b') this.escapeState = 'string'
    return true
  }
}
