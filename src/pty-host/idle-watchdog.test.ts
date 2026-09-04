import { describe, expect, it, vi } from 'vitest'

import {
  IDLE_EXIT_TIMEOUT_MS,
  IdleWatchdog,
  STARTUP_GRACE_TIMEOUT_MS,
  type IdleTimerHandle,
  type IdleTimers
} from './idle-watchdog'

class FakeTimers implements IdleTimers {
  private next = 0
  readonly scheduled = new Map<number, { handler: () => void; ms: number }>()
  readonly cleared: number[] = []
  readonly durations: number[] = []

  setTimeout(handler: () => void, ms: number): IdleTimerHandle {
    this.next += 1
    this.scheduled.set(this.next, { handler, ms })
    this.durations.push(ms)
    return this.next
  }

  clearTimeout(handle: IdleTimerHandle): void {
    this.cleared.push(handle as number)
    this.scheduled.delete(handle as number)
  }

  get pending(): number {
    return this.scheduled.size
  }

  /** Runs the newest pending deadline, as a real timer would once it elapsed. */
  fire(): void {
    const [handle, entry] = [...this.scheduled.entries()].at(-1) ?? []
    if (handle === undefined || !entry) throw new Error('No deadline is pending.')
    this.scheduled.delete(handle)
    entry.handler()
  }
}

// Mirrors how the entry point composes idleness: a host with sessions is never idle, whether
// or not a UI is attached.
const buildHarness = (state = { sessions: 0, clients: 0 }, idleTimeoutMs = 1_000, startupGraceMs = 9_000) => {
  const timers = new FakeTimers()
  const onExpire = vi.fn()
  const watchdog = new IdleWatchdog(
    () => state.sessions === 0 && state.clients === 0,
    onExpire,
    timers,
    idleTimeoutMs,
    startupGraceMs
  )
  return { watchdog, timers, onExpire, state }
}

/**
 * Puts a watchdog past its startup grace the way the real thing gets there: something showed
 * up, so the next empty stretch is measured against the idle deadline. Every case below that
 * is about the idle deadline goes through this first.
 */
const afterFirstClient = (harness: ReturnType<typeof buildHarness>): ReturnType<typeof buildHarness> => {
  harness.state.clients = 1
  harness.watchdog.evaluate()
  harness.state.clients = 0
  return harness
}

describe('IdleWatchdog', () => {
  it('exits an empty host once the deadline elapses', () => {
    const harness = afterFirstClient(buildHarness())

    harness.watchdog.evaluate()
    expect(harness.watchdog.armed).toBe(true)
    expect(harness.timers.durations).toEqual([1_000])
    expect(harness.onExpire).not.toHaveBeenCalled()

    harness.timers.fire()

    expect(harness.onExpire).toHaveBeenCalledOnce()
    expect(harness.watchdog.armed).toBe(false)
  })

  it('never arms while a session is running, even with nobody attached', () => {
    const harness = buildHarness({ sessions: 1, clients: 0 })

    harness.watchdog.evaluate()

    // This is the state the pty-host exists for: the UI is gone and the agents keep working.
    expect(harness.watchdog.armed).toBe(false)
    expect(harness.timers.pending).toBe(0)
  })

  it('cancels a running deadline as soon as the host stops being idle', () => {
    const harness = buildHarness()
    harness.watchdog.evaluate()
    expect(harness.timers.durations).toEqual([9_000])

    harness.state.clients = 1
    harness.watchdog.evaluate()

    expect(harness.watchdog.armed).toBe(false)
    expect(harness.timers.cleared).toEqual([1])
    expect(harness.onExpire).not.toHaveBeenCalled()
  })

  it('lets idle time accumulate instead of re-arming on every evaluation', () => {
    const harness = afterFirstClient(buildHarness())

    harness.watchdog.evaluate()
    harness.watchdog.evaluate()
    harness.watchdog.evaluate()

    // Re-arming would let a client that reconnects in a loop keep an empty host alive.
    expect(harness.timers.durations).toEqual([1_000])
    expect(harness.timers.pending).toBe(1)
  })

  it('re-checks idleness when the deadline fires', () => {
    const harness = afterFirstClient(buildHarness())
    harness.watchdog.evaluate()

    harness.state.sessions = 1
    harness.timers.fire()

    expect(harness.onExpire).not.toHaveBeenCalled()
  })

  it('arms again after the host empties out a second time', () => {
    const harness = buildHarness({ sessions: 1, clients: 1 })
    harness.watchdog.evaluate()

    harness.state.clients = 0
    harness.state.sessions = 0
    harness.watchdog.evaluate()
    harness.timers.fire()

    expect(harness.onExpire).toHaveBeenCalledOnce()
  })

  it('tolerates a cancel with nothing pending', () => {
    const harness = buildHarness()

    expect(() => harness.watchdog.cancel()).not.toThrow()
    expect(harness.timers.cleared).toEqual([])
  })

  it('waits a minute by default, and whatever the composition root asked for otherwise', () => {
    const timers = new FakeTimers()
    const busyThenIdle = (watchdog: IdleWatchdog, state: { idle: boolean }): void => {
      state.idle = false
      watchdog.evaluate()
      state.idle = true
      watchdog.evaluate()
    }

    const defaults = { idle: true }
    busyThenIdle(new IdleWatchdog(() => defaults.idle, vi.fn(), timers), defaults)
    const asked = { idle: true }
    busyThenIdle(new IdleWatchdog(() => asked.idle, vi.fn(), timers, 250), asked)

    expect(timers.durations).toEqual([IDLE_EXIT_TIMEOUT_MS, 250])
    expect(IDLE_EXIT_TIMEOUT_MS).toBe(60_000)
  })

  /**
   * The regression that made this distinction exist: with one knob for both states, an E2E run
   * shortening the idle deadline to 250ms had the host exit ~340ms after binding its endpoint —
   * before the client that spawned it finished its connect backoff — so the app silently fell
   * back to in-process PTYs and nothing was kept alive.
   */
  it('waits out the startup grace, not the idle deadline, before any client has attached', () => {
    const harness = buildHarness({ sessions: 0, clients: 0 }, 250, 9_000)

    harness.watchdog.evaluate()

    expect(harness.timers.durations).toEqual([9_000])
  })

  it('switches to the idle deadline once a client has come and gone', () => {
    const harness = buildHarness({ sessions: 0, clients: 0 }, 250, 9_000)
    harness.watchdog.evaluate()

    harness.state.clients = 1
    harness.watchdog.evaluate()
    harness.state.clients = 0
    harness.watchdog.evaluate()

    expect(harness.timers.durations).toEqual([9_000, 250])
    harness.timers.fire()
    expect(harness.onExpire).toHaveBeenCalledOnce()
  })

  it('counts a session as activity too, so a host whose only client never attached still shortens', () => {
    const harness = buildHarness({ sessions: 1, clients: 0 }, 250, 9_000)
    harness.watchdog.evaluate()

    harness.state.sessions = 0
    harness.watchdog.evaluate()

    expect(harness.timers.durations).toEqual([250])
  })

  it('gives the startup grace enough room for the launcher connect schedule', () => {
    // The launcher retries for ~9.55s before reporting the host unavailable; a grace shorter
    // than that would put the host's exit inside the window it is meant to survive.
    expect(STARTUP_GRACE_TIMEOUT_MS).toBeGreaterThan(10_000)
  })
})
