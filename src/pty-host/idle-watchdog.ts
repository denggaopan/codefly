/**
 * A host with no sessions and nobody attached is dead weight: it outlived its last session,
 * or it was started by a UI that then failed to connect.
 */
export const IDLE_EXIT_TIMEOUT_MS = 60_000

/**
 * How long a host that has never had a client waits before giving up.
 *
 * Deliberately separate from the idle deadline, because the two states only look alike. A
 * host that has just been spawned is idle by every measure and yet must not exit: the client
 * that spawned it is still working through its connect backoff, and a host that exits inside
 * that window kills the very handshake it exists for. So this has to comfortably exceed the
 * launcher's whole connect schedule, while the idle deadline — which only starts mattering
 * after a client has come and gone — is free to be short. Keeping one knob for both is what
 * made a small idle timeout silently unsafe.
 */
export const STARTUP_GRACE_TIMEOUT_MS = 30_000

/** Opaque on purpose, so a test can hand back a counter instead of a real Timeout. */
export type IdleTimerHandle = unknown

export type IdleTimers = {
  setTimeout(handler: () => void, ms: number): IdleTimerHandle
  clearTimeout(handle: IdleTimerHandle): void
}

/**
 * Decides when the host has nothing left to do.
 *
 * Note what is deliberately *not* idle: sessions running with no client attached. That is the
 * state the whole pty-host exists to support — the UI is closed and the agents keep working —
 * so the timer only ever runs while the session table is empty.
 */
export class IdleWatchdog {
  private handle?: IdleTimerHandle
  /**
   * Whether anything has ever attached or run here. Read off `isIdle` rather than asked of
   * the server, so the watchdog needs no extra API to tell "spawned moments ago, client still
   * connecting" apart from "the last client left".
   */
  private everActive = false

  constructor(
    private readonly isIdle: () => boolean,
    private readonly onExpire: () => void,
    private readonly timers: IdleTimers = { setTimeout, clearTimeout },
    private readonly idleTimeoutMs = IDLE_EXIT_TIMEOUT_MS,
    private readonly startupGraceMs = STARTUP_GRACE_TIMEOUT_MS
  ) {}

  get armed(): boolean {
    return this.handle !== undefined
  }

  /** Called after anything that can change the client or session population. */
  evaluate(): void {
    if (!this.isIdle()) {
      this.everActive = true
      this.cancel()
      return
    }
    // An already running deadline is left alone: idle time is meant to accumulate, and
    // re-arming on every evaluation would let a client that reconnects in a loop keep an
    // empty host alive forever.
    if (this.handle !== undefined) return
    this.handle = this.timers.setTimeout(
      () => {
        this.handle = undefined
        // Re-checked because a spawn or a connection can land in the same tick as the timer.
        if (this.isIdle()) this.onExpire()
      },
      this.everActive ? this.idleTimeoutMs : this.startupGraceMs
    )
  }

  cancel(): void {
    if (this.handle === undefined) return
    this.timers.clearTimeout(this.handle)
    this.handle = undefined
  }
}
