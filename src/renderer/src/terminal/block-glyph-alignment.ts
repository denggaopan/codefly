// The subset of xterm's Terminal this needs. Keeping it structural lets the tests drive the
// function with a plain object instead of standing up a real terminal.
export type BlockGlyphTerminal = {
  cols: number
  options: { letterSpacing?: number }
}

/**
 * Nudges the terminal's cell grid onto an EVEN number of device pixels so xterm's Block
 * Element glyphs join without hairlines.
 *
 * The WebGL renderer draws Block Elements from its own vector table rather than the font
 * (see attachWebglRenderer in TerminalWorkspace), sizing every part as a multiple of
 * deviceCellWidth / 8. Most of those code points are a single rectangle, so a fractional
 * edge only softens the shape's outline. U+259B (▛) is the exception: xterm composes it from
 * two rectangles that MEET rather than overlap — the left half and the upper-right quadrant
 * abut at deviceCellWidth / 2. On an odd cell width that join lands on a half pixel, both
 * fillRects anti-alias into the same pixel column, and the two 50% passes composite to 75%
 * instead of 100%. The cell's background then shows through a one-pixel column of what should
 * be solid fill — the crack reported down Claude Code's startup logo, which draws its head
 * from ▛ (dumped from a live session: `▐▛███▛█` in #d77757 on a black background, so each ▛
 * leaks a hairline of pure black from the logo's top edge down to the eye below it).
 *
 * letterSpacing is added to the device char width in WHOLE device pixels
 * (WebglRenderer: `device.cell.width = device.char.width + Math.round(letterSpacing)`), so a
 * single pixel of it is enough to move every such join onto a pixel boundary. One device
 * pixel is 0.67 CSS px at 150% scaling — the text grid widens by well under a tenth of a
 * character and the seams disappear.
 *
 * Whether it is needed depends on the device pixel ratio, which can change while the app is
 * running (the window moved to a display at a different scale), so this runs on every fit
 * rather than once at startup. It measures the live grid off the renderer's canvas — bitmap
 * width divided by columns — and subtracts the spacing already in effect, so re-running on an
 * already-corrected terminal is a no-op instead of flip-flopping.
 *
 * No canvas means the WebGL renderer never attached and the pane is on xterm's DOM renderer,
 * which lays cells out on a fractional CSS grid regardless; there is nothing to align there.
 */
export const alignBlockGlyphGrid = (terminal: BlockGlyphTerminal, host: ParentNode): void => {
  const canvas = host.querySelector('.xterm-screen canvas')
  if (!(canvas instanceof HTMLCanvasElement) || canvas.width <= 0 || terminal.cols <= 0) return

  const deviceCellWidth = canvas.width / terminal.cols
  if (!Number.isInteger(deviceCellWidth)) return

  const applied = Math.round(terminal.options.letterSpacing ?? 0)
  const deviceCharWidth = deviceCellWidth - applied
  const spacing = deviceCharWidth % 2 === 0 ? 0 : 1
  if (spacing !== applied) terminal.options.letterSpacing = spacing
}
