import { describe, expect, it } from 'vitest'

import {
  headingDirection,
  MAX_DROP_DISTANCE,
  planRocketFlight,
  rocketKeyframes,
  type Point,
  type RocketFlightPlan
} from './rocket-flight'

/** Hands out the given values in order, then keeps returning the last one. */
function sequence(values: number[]): () => number {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)]
}

const VIEWPORT = { width: 1440, height: 900 }
const ORIGIN = { x: 40, y: 18 }

function plan(random: () => number, viewport = VIEWPORT): RocketFlightPlan {
  return planRocketFlight({ random, viewport, origin: ORIGIN })
}

/** Pulls the translate/rotate pair back out of a keyframe transform. */
function readTransform(transform: string): { point: Point; headingDeg: number } {
  const match = /^translate3d\((-?[\d.]+)px, (-?[\d.]+)px, 0\) rotate\((-?[\d.]+)deg\)$/.exec(transform)
  if (!match) throw new Error(`unexpected transform: ${transform}`)
  return {
    point: { x: Number(match[1]), y: Number(match[2]) },
    headingDeg: Number(match[3])
  }
}

describe('headingDirection', () => {
  it('maps a nose-up rocket to the direction it faces', () => {
    expect(headingDirection(0)).toMatchObject({ x: expect.closeTo(0, 6), y: expect.closeTo(-1, 6) })
    expect(headingDirection(90)).toMatchObject({ x: expect.closeTo(1, 6), y: expect.closeTo(0, 6) })
    expect(headingDirection(180)).toMatchObject({ x: expect.closeTo(0, 6), y: expect.closeTo(1, 6) })
  })
})

describe('planRocketFlight', () => {
  it('never drops further than the product cap, however lucky the roll', () => {
    expect(plan(sequence([1])).dropDistance).toBe(MAX_DROP_DISTANCE)
  })

  it('drops a visible distance on the unluckiest roll', () => {
    expect(plan(sequence([0])).dropDistance).toBeGreaterThanOrEqual(100)
  })

  it('keeps the drop inside a short window instead of falling out of sight', () => {
    const short = plan(sequence([1]), { width: 1440, height: 320 })
    expect(short.dropDistance).toBeLessThan(320 - ORIGIN.y)
  })

  it('does not invert the drop when the window is shorter than the minimum fall', () => {
    const tiny = plan(sequence([1]), { width: 1440, height: 60 })
    expect(tiny.dropDistance).toBeGreaterThanOrEqual(0)
  })

  it('always cruises rightwards, whatever the pitch roll', () => {
    for (const roll of [0, 0.25, 0.5, 0.75, 1]) {
      const heading = headingDirection(plan(sequence([0.5, roll])).cruiseHeading)
      expect(heading.x).toBeGreaterThan(0)
    }
  })

  it('tilts up-right on a low roll and down-right on a high one', () => {
    expect(headingDirection(plan(sequence([0.5, 0])).cruiseHeading).y).toBeLessThan(0)
    expect(headingDirection(plan(sequence([0.5, 1])).cruiseHeading).y).toBeGreaterThan(0)
  })

  it('spends exactly three seconds on the slow cruise and less on the exit dash', () => {
    const flight = plan(sequence([0.5]))
    expect(flight.cruiseMs).toBe(3000)
    expect(flight.exitMs).toBeLessThan(flight.cruiseMs)
  })

  it('reports a total that covers all four legs', () => {
    const flight = plan(sequence([0.5]))
    expect(flight.totalMs).toBe(flight.dropMs + flight.turnMs + flight.cruiseMs + flight.exitMs)
  })

  it('sets an exit long enough to clear the far corner of the viewport', () => {
    const flight = plan(sequence([0.5]))
    expect(flight.exitDistance).toBeGreaterThan(Math.hypot(VIEWPORT.width, VIEWPORT.height))
  })
})

describe('rocketKeyframes', () => {
  it('falls straight down, nose first', () => {
    const flight = plan(sequence([0.5]))
    const frames = rocketKeyframes(flight)
    const start = readTransform(frames[0].transform)
    const bottom = readTransform(frames[1].transform)

    expect(start.point).toEqual({ x: 0, y: 0 })
    expect(bottom.point.x).toBe(0)
    expect(bottom.point.y).toBeCloseTo(flight.dropDistance, 1)
    expect(start.headingDeg).toBe(180)
    expect(bottom.headingDeg).toBe(180)
    expect(headingDirection(bottom.headingDeg).y).toBeGreaterThan(0)
  })

  it('turns on the spot, without travelling during the turn', () => {
    const flight = plan(sequence([0.5, 0.1]))
    const [, beforeTurn, afterTurn] = rocketKeyframes(flight).map((frame) => readTransform(frame.transform))

    expect(afterTurn.point).toEqual(beforeTurn.point)
    expect(afterTurn.headingDeg).not.toBe(beforeTurn.headingDeg)
    expect(afterTurn.headingDeg).toBeCloseTo(flight.cruiseHeading, 1)
  })

  // The one property the whole effect is about: the rocket flies where its nose points.
  it.each([0, 0.2, 0.5, 0.8, 1])('travels exactly where the nose points (pitch roll %s)', (roll) => {
    const flight = plan(sequence([0.5, roll]))
    const frames = rocketKeyframes(flight).map((frame) => readTransform(frame.transform))
    const nose = headingDirection(flight.cruiseHeading)

    for (const [from, to] of [
      [frames[2], frames[3]],
      [frames[3], frames[4]]
    ]) {
      const travelled = { x: to.point.x - from.point.x, y: to.point.y - from.point.y }
      const distance = Math.hypot(travelled.x, travelled.y)
      expect(distance).toBeGreaterThan(0)
      expect(travelled.x / distance).toBeCloseTo(nose.x, 3)
      expect(travelled.y / distance).toBeCloseTo(nose.y, 3)
      expect(to.headingDeg).toBeCloseTo(flight.cruiseHeading, 1)
    }
  })

  it('holds the cruise heading from the end of the turn onwards', () => {
    const flight = plan(sequence([0.5, 0.9]))
    const frames = rocketKeyframes(flight)
    const headings = frames.slice(2).map((frame) => readTransform(frame.transform).headingDeg)
    expect(new Set(headings).size).toBe(1)
  })

  it('lays the legs out on the timeline in proportion to their durations', () => {
    const flight = plan(sequence([0.5]))
    const frames = rocketKeyframes(flight)
    const offsets = frames.map((frame) => frame.offset)

    expect(offsets[0]).toBe(0)
    expect(offsets[1]).toBeCloseTo(flight.dropMs / flight.totalMs, 6)
    expect(offsets[2]).toBeCloseTo((flight.dropMs + flight.turnMs) / flight.totalMs, 6)
    expect(offsets[3]).toBeCloseTo((flight.dropMs + flight.turnMs + flight.cruiseMs) / flight.totalMs, 6)
    expect(offsets[4]).toBe(1)
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets)
  })
})
