import { PTY_HOST_ENV } from '../shared/pty-protocol'
import { createFileLogger } from './file-log'
import { resolveHostComposition } from './host-composition'
import { IdleWatchdog } from './idle-watchdog'
import { LaunchSpecResolver } from './launch-spec'
import { PtyRegistry } from './pty-registry'
import { PtyHostServer } from './server'

/**
 * Entry point of the resident pty-host: an `ELECTRON_RUN_AS_NODE=1` Electron process, spawned
 * detached by the main process, that owns every node-pty CodeFly has open.
 *
 * It is deliberately the one process here with no reason to stop. The UI attaching and
 * detaching, the renderer reloading, the app quitting and even an in-place upgrade all leave
 * this process — and therefore every agent CLI — running, so the only exits below are the
 * three where nothing would be lost: a lost single-instance race, an explicit `retire`, and
 * an empty host nobody is attached to.
 *
 * ---------------------------------------------------------------------------------------
 * Second composition root (and the only other place environment switches are read)
 * ---------------------------------------------------------------------------------------
 * `src/main/index.ts` is the composition root of the Electron side; this file is the one for
 * the host, because moving node-pty out of the main process also moved the agent executable
 * lookup here. Every switch below — the endpoint, the E2E substitutions, the idle timeout —
 * is read ONLY here and wired through the constructor seams `LaunchSpecResolver`,
 * `PtyRegistry`, `PtyHostServer` and `IdleWatchdog` already expose (see
 * `resolveHostComposition`). None of those branch on an environment variable themselves:
 * that rule is what keeps "what CodeFly runs" readable in one place per process, and it is
 * the same rule the domain services on the main side follow.
 *
 * In E2E mode (`CODEFLY_E2E=1` with `CODEFLY_E2E_AGENT_CMD`) only the resolved *executable*
 * changes, for agent kinds only. The bypass argv and bypass environment still come from the
 * agent registry through the production launch adapters, because the suite asserts the exact
 * argv Claude and Codex receive — an assertion that is worth nothing if the argv came from a
 * test-only branch. Shell and PowerShell keep resolving through the real locator. With
 * `CODEFLY_E2E` unset — every production build — the composition is byte-for-byte the
 * production one.
 */
const endpoint = process.env[PTY_HOST_ENV.endpoint]
const appVersion = process.env[PTY_HOST_ENV.appVersion]
const log = createFileLogger(process.env[PTY_HOST_ENV.logFile])

// A PTY, a client socket or a launch adapter can throw from a callback the host does not
// own. Exiting on that would kill every agent, so the failure is recorded and the process
// keeps its sessions instead.
process.on('uncaughtException', (error) => {
  log(`Uncaught exception: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
})
process.on('unhandledRejection', (reason) => {
  log(`Unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`)
})

const main = async (): Promise<void> => {
  if (endpoint === undefined || endpoint.length === 0) {
    log(`Refusing to start without ${PTY_HOST_ENV.endpoint}.`)
    process.exit(1)
  }
  if (appVersion === undefined) log(`Starting without ${PTY_HOST_ENV.appVersion}; reporting an unknown build.`)

  const { locator, idleTimeoutMs } = resolveHostComposition(process.env)
  const registry = new PtyRegistry(new LaunchSpecResolver(locator), undefined, process.env, log)
  let watchdog: IdleWatchdog | undefined
  const server = new PtyHostServer({
    endpoint,
    registry,
    appVersion: appVersion ?? 'unknown',
    platform: process.platform,
    log,
    onStateChanged: () => watchdog?.evaluate(),
    exitProcess: () => process.exit(0)
  })
  watchdog = new IdleWatchdog(
    () => registry.sessionCount === 0 && server.clientCount === 0,
    () => {
      log('Idle with no sessions and no clients; exiting.')
      void server.close().then(() => process.exit(0))
    },
    undefined,
    idleTimeoutMs
  )
  // Sessions leaving the table is the other half of "idle"; the server reports the rest.
  registry.onEvent((event) => {
    if (event.type === 'exit') watchdog?.evaluate()
  })

  log(`pty-host starting for CodeFly ${appVersion ?? 'unknown'} (idle exit after ${idleTimeoutMs}ms).`)
  const outcome = await server.listen()
  if (outcome === 'occupied') {
    // The host that owns the endpoint owns the sessions too; a second one would answer
    // nobody and hold a duplicate session table.
    process.exit(0)
  }
  // Armed straight away, on the startup grace rather than the idle deadline: a UI that dies
  // between spawning the host and its first `hello` must not leave this process resident for
  // the rest of the login session, but neither may the host outrun the connect backoff of the
  // client that just spawned it (see STARTUP_GRACE_TIMEOUT_MS).
  watchdog.evaluate()
}

void main().catch((error: unknown) => {
  log(`Failed to start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  process.exit(1)
})
