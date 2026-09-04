// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '../store/use-app-store'
import TitleBar from './TitleBar'

/** Stand-in for the Animation the real Web Animations API hands back. */
class FakeAnimation {
  cancelled = false
  private readonly listeners = new Map<string, Set<() => void>>()

  addEventListener(type: string, callback: () => void): void {
    const bucket = this.listeners.get(type) ?? new Set()
    bucket.add(callback)
    this.listeners.set(type, bucket)
  }

  removeEventListener(type: string, callback: () => void): void {
    this.listeners.get(type)?.delete(callback)
  }

  cancel(): void {
    this.cancelled = true
  }

  emit(type: string): void {
    for (const callback of [...(this.listeners.get(type) ?? [])]) callback()
  }
}

interface RecordedFlight {
  keyframes: Keyframe[]
  options: KeyframeAnimationOptions
  animation: FakeAnimation
}

const flights: RecordedFlight[] = []
const originalAnimate = Element.prototype.animate

// jsdom implements neither animate() nor matchMedia(); both are the guards RocketFlight
// checks before it starts a flight, so the suite has to supply them.
function installAnimateStub(): void {
  Element.prototype.animate = function stubAnimate(
    keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
    options?: number | KeyframeAnimationOptions
  ) {
    const animation = new FakeAnimation()
    flights.push({
      keyframes: (keyframes ?? []) as Keyframe[],
      options: (options ?? {}) as KeyframeAnimationOptions,
      animation
    })
    return animation as unknown as Animation
  } as typeof Element.prototype.animate
}

const rockets = (): NodeListOf<Element> => document.querySelectorAll('.rocket-flight')

const clickBrand = async (): Promise<void> => {
  await userEvent.click(screen.getByRole('button', { name: 'CodeFly — launch a rocket' }))
}

const readTransform = (keyframe: Keyframe): { x: number; y: number; headingDeg: number } => {
  const match = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px, 0\) rotate\((-?[\d.]+)deg\)/.exec(
    String(keyframe.transform)
  )
  if (!match) throw new Error(`unexpected transform: ${String(keyframe.transform)}`)
  return { x: Number(match[1]), y: Number(match[2]), headingDeg: Number(match[3]) }
}

describe('TitleBar', () => {
  beforeEach(() => {
    flights.length = 0
    useAppStore.getState().reset()
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }) as unknown as typeof window.matchMedia
    installAnimateStub()
  })

  afterEach(() => {
    Element.prototype.animate = originalAnimate
  })

  it('keeps a draggable strip next to the two no-drag buttons', () => {
    render(<TitleBar />)
    expect(document.querySelector('.title-bar-drag-area')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Settings' })).not.toBeNull()
  })

  it('launches a rocket when the brand is clicked', async () => {
    render(<TitleBar />)
    expect(rockets()).toHaveLength(0)

    await clickBrand()

    expect(rockets()).toHaveLength(1)
    expect(flights).toHaveLength(1)
  })

  it('drops nose-first, then flies rightwards on the heading it turned to', async () => {
    render(<TitleBar />)
    await clickBrand()

    const frames = flights[0].keyframes.map(readTransform)
    expect(frames[0]).toMatchObject({ x: 0, y: 0, headingDeg: 180 })
    expect(frames[1].y).toBeGreaterThan(0)
    expect(frames[1].y).toBeLessThanOrEqual(500)
    // Turned once, then held that heading all the way off-screen.
    expect(frames[2].headingDeg).not.toBe(180)
    expect(frames[4].headingDeg).toBe(frames[2].headingDeg)
    expect(frames[4].x).toBeGreaterThan(frames[3].x)
  })

  it('spends three of its seconds cruising slowly before the dash out', async () => {
    render(<TitleBar />)
    await clickBrand()

    const { keyframes, options } = flights[0]
    const total = Number(options.duration)
    const cruiseFraction = Number(keyframes[3].offset) - Number(keyframes[2].offset)
    expect(cruiseFraction * total).toBeCloseTo(3000, 0)

    const frames = keyframes.map(readTransform)
    const cruiseSpeed = Math.hypot(frames[3].x - frames[2].x, frames[3].y - frames[2].y) / 3000
    const exitSpeed =
      Math.hypot(frames[4].x - frames[3].x, frames[4].y - frames[3].y) / ((1 - Number(keyframes[3].offset)) * total)
    expect(exitSpeed).toBeGreaterThan(cruiseSpeed * 10)
  })

  it('can have several rockets in the air at once', async () => {
    render(<TitleBar />)
    await clickBrand()
    await clickBrand()
    await clickBrand()

    expect(rockets()).toHaveLength(3)
  })

  it('cleans the rocket up once its flight finishes', async () => {
    render(<TitleBar />)
    await clickBrand()

    await act(async () => {
      flights[0].animation.emit('finish')
    })

    expect(rockets()).toHaveLength(0)
  })

  it('does not leave a stranded rocket when animations are unavailable', async () => {
    Element.prototype.animate = undefined as unknown as typeof Element.prototype.animate
    render(<TitleBar />)

    await clickBrand()

    expect(rockets()).toHaveLength(0)
    expect(flights).toHaveLength(0)
  })

  it('skips the flight for viewers who asked for reduced motion', async () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })) as unknown as typeof window.matchMedia

    render(<TitleBar />)
    await clickBrand()

    expect(flights).toHaveLength(0)
    expect(rockets()).toHaveLength(0)
  })
})
