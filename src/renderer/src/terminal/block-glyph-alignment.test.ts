import { describe, expect, it } from 'vitest'

import { alignBlockGlyphGrid } from './block-glyph-alignment'

// Builds the DOM shape xterm produces once the WebGL addon has attached: a .xterm-screen
// with the renderer's canvas inside it, whose bitmap width is cols * deviceCellWidth.
const hostWithCanvas = (canvasWidth: number): HTMLElement => {
  const host = document.createElement('div')
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  const canvas = document.createElement('canvas')
  canvas.width = canvasWidth
  screen.append(canvas)
  host.append(screen)
  return host
}

// The DOM renderer paints into .xterm-rows and creates no canvas at all.
const hostWithoutCanvas = (): HTMLElement => {
  const host = document.createElement('div')
  const screen = document.createElement('div')
  screen.className = 'xterm-screen'
  screen.append(document.createElement('div'))
  host.append(screen)
  return host
}

const terminalWith = (cols: number, letterSpacing?: number) => ({ cols, options: { letterSpacing } })

describe('alignBlockGlyphGrid', () => {
  it('adds one device pixel of letter spacing when the device cell width is odd', () => {
    const terminal = terminalWith(80, 0)

    alignBlockGlyphGrid(terminal, hostWithCanvas(80 * 13))

    expect(terminal.options.letterSpacing).toBe(1)
  })

  it('leaves letter spacing at zero when the device cell width is already even', () => {
    const terminal = terminalWith(80, 0)

    alignBlockGlyphGrid(terminal, hostWithCanvas(80 * 12))

    expect(terminal.options.letterSpacing).toBe(0)
  })

  it('treats missing letter spacing as zero', () => {
    const terminal = terminalWith(80, undefined)

    alignBlockGlyphGrid(terminal, hostWithCanvas(80 * 13))

    expect(terminal.options.letterSpacing).toBe(1)
  })

  // Re-running on an already-corrected terminal must be a no-op. The measured cell width now
  // INCLUDES the spacing already applied (13 + 1 = 14), so a check that naively looked at the
  // cell width would call it even, drop the spacing back to 0, and flip-flop on every resize.
  it('keeps the spacing it already applied instead of oscillating on the next fit', () => {
    const terminal = terminalWith(80, 1)

    alignBlockGlyphGrid(terminal, hostWithCanvas(80 * 14))

    expect(terminal.options.letterSpacing).toBe(1)
  })

  it('removes spacing that is no longer needed after the cell width changes', () => {
    // A move to a display where the char width lands on an even number of device pixels.
    const terminal = terminalWith(80, 1)

    alignBlockGlyphGrid(terminal, hostWithCanvas(80 * 13))

    expect(terminal.options.letterSpacing).toBe(0)
  })

  it('leaves the terminal alone when the WebGL renderer is not attached', () => {
    const terminal = terminalWith(80, 0)

    alignBlockGlyphGrid(terminal, hostWithoutCanvas())

    expect(terminal.options.letterSpacing).toBe(0)
  })

  it('leaves the terminal alone when the canvas has no usable size yet', () => {
    const terminal = terminalWith(80, 0)

    alignBlockGlyphGrid(terminal, hostWithCanvas(0))

    expect(terminal.options.letterSpacing).toBe(0)
  })

  it('leaves the terminal alone when the cell width is not a whole number of pixels', () => {
    const terminal = terminalWith(80, 0)

    // 1050 / 80 = 13.125 — not a grid this function can reason about.
    alignBlockGlyphGrid(terminal, hostWithCanvas(1050))

    expect(terminal.options.letterSpacing).toBe(0)
  })

  it('leaves the terminal alone before it has any columns', () => {
    const terminal = terminalWith(0, 0)

    alignBlockGlyphGrid(terminal, hostWithCanvas(0))

    expect(terminal.options.letterSpacing).toBe(0)
  })
})
