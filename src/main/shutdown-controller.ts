export type BeforeQuitEvent = {
  preventDefault(): void
}

export type ShutdownControllerOptions = {
  shutdown(): Promise<void>
  quit(): void
  onError(error: unknown): void
}

export const createBeforeQuitHandler = ({ shutdown, quit, onError }: ShutdownControllerOptions) => {
  let shutdownComplete = false
  let shutdownInFlight: Promise<void> | undefined

  return (event: BeforeQuitEvent): void => {
    if (shutdownComplete) return
    event.preventDefault()
    if (shutdownInFlight) return

    const finish = (): void => {
      shutdownComplete = true
      quit()
    }

    try {
      shutdownInFlight = shutdown()
    } catch (error) {
      onError(error)
      finish()
      return
    }

    void shutdownInFlight.then(finish, (error: unknown) => {
      onError(error)
      finish()
    })
  }
}
