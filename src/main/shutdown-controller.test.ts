import { describe, expect, it, vi } from 'vitest'

import { createBeforeQuitHandler } from './shutdown-controller'

const deferred = () => {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const quitEvent = () => ({ preventDefault: vi.fn() })

describe('createBeforeQuitHandler', () => {
  it('prevents quit until one shared shutdown completes, then permits re-entry', async () => {
    const gate = deferred()
    const shutdown = vi.fn(() => gate.promise)
    const quit = vi.fn()
    const onError = vi.fn()
    const handler = createBeforeQuitHandler({ shutdown, quit, onError })
    const first = quitEvent()
    const concurrent = quitEvent()

    handler(first)
    handler(concurrent)

    expect(first.preventDefault).toHaveBeenCalledOnce()
    expect(concurrent.preventDefault).toHaveBeenCalledOnce()
    expect(shutdown).toHaveBeenCalledOnce()
    expect(quit).not.toHaveBeenCalled()

    gate.resolve()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())

    const permitted = quitEvent()
    handler(permitted)
    expect(permitted.preventDefault).not.toHaveBeenCalled()
    expect(shutdown).toHaveBeenCalledOnce()
  })

  it('reports a shutdown rejection and still permits the final quit', async () => {
    const failure = new Error('PTY cleanup failed')
    const shutdown = vi.fn(async () => {
      throw failure
    })
    const quit = vi.fn()
    const onError = vi.fn()
    const handler = createBeforeQuitHandler({ shutdown, quit, onError })
    const event = quitEvent()

    handler(event)

    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(failure)
  })
})
