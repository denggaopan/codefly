import { useEffect, useRef, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'

import { planRocketFlight, rocketKeyframes, type Point } from '../rocket-flight'

/**
 * One rocket, launched from the title bar's brand button: it falls nose-first, swings round
 * to a random rightwards course, cruises slowly for three seconds and then dashes off-screen.
 * The geometry (and the promise that the nose always points along the course) lives in
 * `rocket-flight.ts`; this component only measures the launch point and drives the animation.
 *
 * It portals to document.body so no ancestor's overflow or stacking context can clip a flight
 * that crosses the whole window, and it is inert to the pointer: purely decorative, and never
 * in the way of the UI it flies over.
 */
export default function RocketFlight({ origin, onDone }: { origin: Point; onDone: () => void }) {
  const bodyRef = useRef<HTMLDivElement | null>(null)
  // Kept in a ref so the effect below never re-runs (and restarts the flight) just because the
  // parent handed down a fresh callback identity.
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  useEffect(() => {
    const node = bodyRef.current
    const finish = () => onDoneRef.current()

    // No Web Animations (jsdom in the unit tests), or the viewer asked for less motion: skip
    // straight to the end so the launch does not leak a rocket that never leaves.
    const reducedMotion =
      typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!node || typeof node.animate !== 'function' || reducedMotion) {
      finish()
      return
    }

    const plan = planRocketFlight({
      random: Math.random,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      origin
    })
    const animation = node.animate(rocketKeyframes(plan), {
      duration: plan.totalMs,
      easing: 'linear',
      fill: 'forwards'
    })

    animation.addEventListener('finish', finish)
    animation.addEventListener('cancel', finish)
    return () => {
      animation.removeEventListener('finish', finish)
      animation.removeEventListener('cancel', finish)
      animation.cancel()
    }
  }, [origin])

  const anchorStyle = { left: `${origin.x}px`, top: `${origin.y}px` } as CSSProperties

  return createPortal(
    <div className="rocket-flight" style={anchorStyle} aria-hidden="true">
      <div className="rocket-flight-body" ref={bodyRef}>
        <svg className="rocket-flight-art" viewBox="0 0 32 44" width="32" height="44" fill="none">
          <defs>
            <linearGradient id="rocket-hull" x1="8" y1="4" x2="26" y2="40" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#ffffff" />
              <stop offset="0.55" stopColor="#e6e1ef" />
              <stop offset="1" stopColor="#a9a2ba" />
            </linearGradient>
            <linearGradient id="rocket-fin" x1="4" y1="26" x2="28" y2="38" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#c77dff" />
              <stop offset="1" stopColor="#7b2cbf" />
            </linearGradient>
            <linearGradient id="rocket-flame" x1="16" y1="32" x2="16" y2="44" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#fff3b0" />
              <stop offset="0.45" stopColor="#ff9e00" />
              <stop offset="1" stopColor="#ff5400" stopOpacity="0" />
            </linearGradient>
          </defs>
          {/* Fins first, so the hull overlaps their inner edges. */}
          <path d="M11 25 4 34l7 1z" fill="url(#rocket-fin)" />
          <path d="M21 25l7 9-7 1z" fill="url(#rocket-fin)" />
          {/* Nose up: this is the 0deg heading every rotation in the flight plan is measured from. */}
          <path
            d="M16 2c4.4 4.6 6.6 10.4 6.6 17.2 0 4.9-1 9.3-3 13.3h-7.2c-2-4-3-8.4-3-13.3C9.4 12.4 11.6 6.6 16 2z"
            fill="url(#rocket-hull)"
          />
          <circle cx="16" cy="17" r="3.4" fill="#0b1020" opacity="0.85" />
          <circle cx="16" cy="17" r="2.4" fill="#48cae4" />
          <circle cx="15" cy="16" r="0.8" fill="#ffffff" opacity="0.8" />
          <path d="M12.4 32.5h7.2l-1 3h-5.2z" fill="#7b2cbf" />
          <g className="rocket-flight-flame">
            <path d="M16 44c-3.2-3-4.8-6-4.8-9h9.6c0 3-1.6 6-4.8 9z" fill="url(#rocket-flame)" />
          </g>
        </svg>
      </div>
    </div>,
    document.body
  )
}
