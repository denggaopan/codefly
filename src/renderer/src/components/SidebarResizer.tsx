import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

import { useTranslation } from '../i18n/use-translation'
import { maxSidebarWidthFor, MIN_SIDEBAR_WIDTH, SIDEBAR_WIDTH_KEYBOARD_STEP } from '../sidebar-width'
import { useAppStore } from '../store/use-app-store'

type DragState = {
  pointerId: number
  startX: number
  startWidth: number
}

/**
 * The vertical splitter between the project sidebar and the terminal workspace. Dragging it
 * resizes the sidebar live (the store clamps and persists every step); ArrowLeft/ArrowRight
 * nudge it from the keyboard, Home/End jump to the bounds, and a double-click restores the
 * default width. It is a WAI-ARIA "window splitter": a focusable separator whose value is the
 * sidebar width in pixels.
 *
 * Pointer capture is what makes the drag robust: once captured, move/up events keep arriving
 * here even when the pointer runs onto the xterm canvas (which listens for mouse events of
 * its own) or leaves the window entirely, so the handle can never be "dropped" mid-drag.
 */
export default function SidebarResizer() {
  const { t } = useTranslation()
  const width = useAppStore((state) => state.sidebarWidth)
  const setSidebarWidth = useAppStore((state) => state.setSidebarWidth)
  const resetSidebarWidth = useAppStore((state) => state.resetSidebarWidth)
  const [resizing, setResizing] = useState(false)
  const dragRef = useRef<DragState | null>(null)

  // Mirrored onto <body> so styles.css can switch the whole window to a col-resize cursor and
  // suspend text selection / terminal hit-testing for the duration of the drag.
  useEffect(() => {
    if (!resizing) return
    document.body.dataset.sidebarResizing = 'true'
    return () => {
      delete document.body.dataset.sidebarResizing
    }
  }, [resizing])

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || dragRef.current) return
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width }
    // Guarded: jsdom (unit tests) has no pointer capture. In a real browser it is always there.
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    setResizing(true)
    // Keeps the mousedown from starting a text selection that would smear across the
    // sidebar while dragging.
    event.preventDefault()
  }

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || event.pointerId !== drag.pointerId) return
    setSidebarWidth(drag.startWidth + (event.clientX - drag.startX))
  }

  // Shared by pointerup, pointercancel and lostpointercapture: whichever arrives first ends
  // the drag, the rest are no-ops. lostpointercapture covers the cases where no up event ever
  // comes (window losing focus mid-drag, the OS cancelling the pointer).
  const endDrag = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || event.pointerId !== drag.pointerId) return
    dragRef.current = null
    setResizing(false)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case 'ArrowLeft':
        setSidebarWidth(width - SIDEBAR_WIDTH_KEYBOARD_STEP)
        break
      case 'ArrowRight':
        setSidebarWidth(width + SIDEBAR_WIDTH_KEYBOARD_STEP)
        break
      case 'Home':
        setSidebarWidth(MIN_SIDEBAR_WIDTH)
        break
      case 'End':
        setSidebarWidth(maxSidebarWidthFor(window.innerWidth))
        break
      default:
        return
    }
    event.preventDefault()
  }

  return (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('sidebar.resizeHandle')}
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={maxSidebarWidthFor(window.innerWidth)}
      aria-valuenow={width}
      tabIndex={0}
      title={t('sidebar.resizeHandle')}
      data-resizing={resizing ? 'true' : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={handleKeyDown}
      onDoubleClick={resetSidebarWidth}
    />
  )
}
