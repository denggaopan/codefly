import { describe, expect, it } from 'vitest'

import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  maxSidebarWidthFor,
  MIN_SIDEBAR_WIDTH,
  MIN_WORKSPACE_WIDTH,
  parseStoredSidebarWidth
} from './sidebar-width'

describe('maxSidebarWidthFor', () => {
  it('caps at the absolute maximum on a wide viewport', () => {
    expect(maxSidebarWidthFor(2560)).toBe(MAX_SIDEBAR_WIDTH)
  })

  it('always leaves the workspace its minimum width on a narrow viewport', () => {
    expect(maxSidebarWidthFor(900)).toBe(900 - MIN_WORKSPACE_WIDTH)
  })

  it('never drops below the sidebar minimum, even on an absurdly small viewport', () => {
    expect(maxSidebarWidthFor(100)).toBe(MIN_SIDEBAR_WIDTH)
    expect(maxSidebarWidthFor(0)).toBe(MIN_SIDEBAR_WIDTH)
  })
})

describe('clampSidebarWidth', () => {
  it('keeps an in-range width, rounded to whole pixels', () => {
    expect(clampSidebarWidth(333.6, 1920)).toBe(334)
  })

  it('clamps below the minimum up to the minimum', () => {
    expect(clampSidebarWidth(10, 1920)).toBe(MIN_SIDEBAR_WIDTH)
    expect(clampSidebarWidth(-500, 1920)).toBe(MIN_SIDEBAR_WIDTH)
  })

  it('clamps above the viewport-derived maximum', () => {
    expect(clampSidebarWidth(5000, 1920)).toBe(MAX_SIDEBAR_WIDTH)
    expect(clampSidebarWidth(5000, 900)).toBe(900 - MIN_WORKSPACE_WIDTH)
  })

  it('falls back to the default for a non-finite width', () => {
    expect(clampSidebarWidth(Number.NaN, 1920)).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY, 1920)).toBe(DEFAULT_SIDEBAR_WIDTH)
  })
})

describe('parseStoredSidebarWidth', () => {
  it('returns the default when nothing was stored', () => {
    expect(parseStoredSidebarWidth(null, 1920)).toBe(DEFAULT_SIDEBAR_WIDTH)
  })

  it('reads a stored pixel value and clamps it for the current viewport', () => {
    expect(parseStoredSidebarWidth('420', 1920)).toBe(420)
    expect(parseStoredSidebarWidth('420', 700)).toBe(700 - MIN_WORKSPACE_WIDTH)
    expect(parseStoredSidebarWidth('12', 1920)).toBe(MIN_SIDEBAR_WIDTH)
  })

  it('returns the default for anything that is not a finite number', () => {
    expect(parseStoredSidebarWidth('', 1920)).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(parseStoredSidebarWidth('wide', 1920)).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(parseStoredSidebarWidth('Infinity', 1920)).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(parseStoredSidebarWidth('{"width":300}', 1920)).toBe(DEFAULT_SIDEBAR_WIDTH)
  })
})
