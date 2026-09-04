/**
 * Flight plan for the title-bar rocket easter egg.
 *
 * Everything geometric lives here as pure functions so the one property the effect is really
 * about -- the rocket always points where it is going -- can be asserted in tests instead of
 * eyeballed in the running app.
 *
 * Angle convention: `headingDeg` is the CSS `rotate()` value applied to a rocket drawn
 * nose-up, i.e. 0deg = nose up, clockwise positive. The travel direction that belongs to a
 * heading is therefore `(sin h, -cos h)` in screen space (y grows downwards), which is what
 * `headingDirection()` returns and what every leg of the plan is built from.
 */

/** Hard ceiling on the drop, straight from the product ask. */
export const MAX_DROP_DISTANCE = 500
/** Below this the drop reads as a twitch rather than a fall. */
const MIN_DROP_DISTANCE = 120
/** Keeps the hovering rocket clear of the very bottom edge of the window. */
const BOTTOM_MARGIN = 48

/** Nose down: the rocket falls head-first. */
const DROP_HEADING = 180
/** Nose right: heading of a purely horizontal cruise, the axis `pitchDeg` tilts around. */
const CRUISE_HEADING = 90
/** How far off horizontal the cruise may tilt, up or down. */
const MAX_CRUISE_PITCH = 32

const MIN_DROP_MS = 700
const MAX_DROP_MS = 1000
/** Long enough to read as a deliberate turn, short enough not to stall the show. */
const TURN_MS = 320
/** The slow cruise, straight from the product ask. */
const CRUISE_MS = 3000
/** The exit is a dash, not a drift. */
const EXIT_MS = 600

const MIN_CRUISE_DISTANCE = 120
const MAX_CRUISE_DISTANCE = 200

export interface Viewport {
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

export interface RocketFlightPlan {
  /** Vertical fall, in px, never above `MAX_DROP_DISTANCE`. */
  dropDistance: number
  /** Cruise tilt off horizontal, in degrees; negative aims up-right, positive down-right. */
  pitchDeg: number
  /** Heading (CSS rotate) held during the fall. */
  dropHeading: number
  /** Heading (CSS rotate) held from the end of the turn until the rocket is gone. */
  cruiseHeading: number
  /** Distance covered during the slow cruise. */
  cruiseDistance: number
  /** Distance covered during the dash off-screen -- always past the far edge. */
  exitDistance: number
  dropMs: number
  turnMs: number
  cruiseMs: number
  exitMs: number
  /** Sum of the four legs, i.e. when the rocket may be unmounted. */
  totalMs: number
}

/** Unit travel vector for a heading, in screen space (y grows downwards). */
export function headingDirection(headingDeg: number): Point {
  const radians = (headingDeg * Math.PI) / 180
  return { x: Math.sin(radians), y: -Math.cos(radians) }
}

function lerp(min: number, max: number, ratio: number): number {
  return min + (max - min) * ratio
}

/**
 * Builds one flight. `random` is injected (and consumed in a fixed order: drop distance,
 * pitch, cruise distance, drop duration) so tests can pin every leg.
 */
export function planRocketFlight(input: {
  random: () => number
  viewport: Viewport
  origin: Point
}): RocketFlightPlan {
  const { random, viewport, origin } = input

  // The fall is capped by the ask AND by the window: dropping a rocket below the bottom edge
  // just hides the part of the animation the click was for.
  const room = Math.max(0, viewport.height - origin.y - BOTTOM_MARGIN)
  const ceiling = Math.min(MAX_DROP_DISTANCE, room)
  const dropDistance = ceiling <= MIN_DROP_DISTANCE ? ceiling : lerp(MIN_DROP_DISTANCE, ceiling, random())

  const pitchDeg = lerp(-MAX_CRUISE_PITCH, MAX_CRUISE_PITCH, random())
  const cruiseDistance = lerp(MIN_CRUISE_DISTANCE, MAX_CRUISE_DISTANCE, random())
  const dropMs = lerp(MIN_DROP_MS, MAX_DROP_MS, random())

  // One diagonal of the viewport clears the far edge from anywhere inside it, whatever the
  // heading, so the dash never ends with a rocket still parked on screen.
  const exitDistance = Math.hypot(viewport.width, viewport.height) + MAX_CRUISE_DISTANCE

  return {
    dropDistance,
    pitchDeg,
    dropHeading: DROP_HEADING,
    cruiseHeading: CRUISE_HEADING + pitchDeg,
    cruiseDistance,
    exitDistance,
    dropMs,
    turnMs: TURN_MS,
    cruiseMs: CRUISE_MS,
    exitMs: EXIT_MS,
    totalMs: dropMs + TURN_MS + CRUISE_MS + EXIT_MS
  }
}

export interface RocketKeyframe {
  offset: number
  transform: string
  easing?: string
  // The DOM's `Keyframe` carries an index signature; without a matching one here these frames
  // cannot be handed straight to `Element.animate()`.
  [property: string]: string | number | undefined
}

/**
 * The plan as Web Animations keyframes. Position and heading travel together in one
 * `transform` list -- that pairing is the whole point, so it is not split across two
 * animations that could drift apart.
 */
export function rocketKeyframes(plan: RocketFlightPlan): RocketKeyframe[] {
  const { totalMs } = plan
  const dropEnd = plan.dropMs / totalMs
  const turnEnd = (plan.dropMs + plan.turnMs) / totalMs
  const cruiseEnd = (plan.dropMs + plan.turnMs + plan.cruiseMs) / totalMs

  const heading = headingDirection(plan.cruiseHeading)
  const cruise = {
    x: heading.x * plan.cruiseDistance,
    y: plan.dropDistance + heading.y * plan.cruiseDistance
  }
  const exit = {
    x: cruise.x + heading.x * plan.exitDistance,
    y: cruise.y + heading.y * plan.exitDistance
  }

  const at = (point: Point, headingDeg: number): string =>
    `translate3d(${point.x.toFixed(2)}px, ${point.y.toFixed(2)}px, 0) rotate(${headingDeg.toFixed(2)}deg)`

  return [
    // Gravity: the fall accelerates.
    { offset: 0, transform: at({ x: 0, y: 0 }, plan.dropHeading), easing: 'cubic-bezier(0.33, 0, 0.8, 0.4)' },
    // Hover and swing the nose round to the new course.
    { offset: dropEnd, transform: at({ x: 0, y: plan.dropDistance }, plan.dropHeading), easing: 'ease-in-out' },
    // Steady cruise.
    { offset: turnEnd, transform: at({ x: 0, y: plan.dropDistance }, plan.cruiseHeading), easing: 'linear' },
    // Then light the engine and go.
    { offset: cruiseEnd, transform: at(cruise, plan.cruiseHeading), easing: 'cubic-bezier(0.5, 0, 1, 1)' },
    { offset: 1, transform: at(exit, plan.cruiseHeading) }
  ]
}
