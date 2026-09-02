import { spawn } from 'node:child_process'
import { mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { app } from 'electron'

import type { UpdateDownloadProgress, UpdateDownloadResult, UpdateInstallResult } from '../../shared/contracts'
import { electronFetch } from '../infrastructure/net-fetch'
import {
  compareVersionStrings,
  parseSemVer,
  stripVersionPrefix,
  type GetVersion,
  type TimeoutSignalFactory
} from './app-info-service'
import {
  isTrustedInstallerUrl,
  latestReleaseSchema,
  pickWindowsInstaller,
  DOWNLOAD_HEADERS,
  LATEST_RELEASE_URL,
  REQUEST_HEADERS,
  REQUEST_TIMEOUT_MS,
  type WindowsInstaller
} from './github-release'

const UPDATES_DIRECTORY = 'updates'

// The installer is streamed to a sibling `.part` file and only renamed into place once it is
// complete, so an interrupted download can never be mistaken for a ready installer.
const PART_SUFFIX = '.part'

// Progress is throttled before it reaches the IPC channel: a 100 MB installer arriving in
// 16 KB chunks would otherwise publish thousands of frames the UI cannot use.
const PROGRESS_INTERVAL_MS = 200
const PROGRESS_BYTES = 256 * 1024

// How long to wait for the OS to confirm the installer process actually started. Generous,
// because it is only ever hit when something is badly wrong: a healthy spawn confirms in
// milliseconds, and the cost of waiting is only that the app has not quit yet.
const SPAWN_CONFIRMATION_TIMEOUT_MS = 5_000

export type UpdaterHttpHeaders = { get(name: string): string | null }

// The slice of the fetch Response this service uses. `body` is iterated chunk by chunk, so
// the installer is written to disk as it arrives and never held in memory.
export type UpdaterHttpResponse = {
  ok: boolean
  status: number
  headers?: UpdaterHttpHeaders
  json(): Promise<unknown>
  body?: AsyncIterable<Uint8Array> | null
}

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal }
) => Promise<UpdaterHttpResponse>

export type InstallerWriteStream = {
  write(chunk: Uint8Array): Promise<void>
  close(): Promise<void>
}

// Narrow filesystem surface so tests can run the whole download in memory and never write a
// real installer into a real userData directory. `fileSize`, `remove` and `listFiles` are
// interrogative or best-effort and MUST NOT reject — the service treats their answers as
// facts and folds every real failure into a result, so a rejection here would escape as an
// unhandled IPC error. `ensureDirectory`, `openWriteStream` and `rename` may reject; those
// calls are guarded.
export type UpdaterFileSystem = {
  ensureDirectory(directory: string): Promise<void>
  /** Byte size of an existing file, or undefined when it is missing, unreadable, or not a file. */
  fileSize(filePath: string): Promise<number | undefined>
  openWriteStream(filePath: string): Promise<InstallerWriteStream>
  rename(from: string, to: string): Promise<void>
  /** Best-effort delete: a file that is already gone is not an error. */
  remove(filePath: string): Promise<void>
  /** File names directly inside `directory`; an empty list when it cannot be read. */
  listFiles(directory: string): Promise<readonly string[]>
}

/**
 * The slice of ChildProcess the install needs. `on` matters as much as `unref`: spawn does
 * NOT throw for a missing, quarantined, or blocked executable — it returns a process that
 * emits `'error'` on a later tick, which is both the failure this service has to report and,
 * with no listener attached, an unhandled event that would take the main process down.
 */
export type SpawnedInstaller = {
  unref(): void
  on(event: 'error', listener: (error: Error) => void): void
  on(event: 'spawn', listener: () => void): void
}

export type InstallerSpawner = (
  file: string,
  args: readonly string[],
  options: { detached: true; stdio: 'ignore' }
) => SpawnedInstaller

export type QuitApp = () => void
export type Clock = () => number
export type UserDataPath = () => string

const defaultGetVersion: GetVersion = () => app.getVersion()

// Chromium's network stack, not Node's global fetch: see net-fetch.ts for why the proxy matters.
const defaultFetch: FetchLike = electronFetch

const defaultFileSystem: UpdaterFileSystem = {
  ensureDirectory: async (directory) => {
    await mkdir(directory, { recursive: true })
  },
  fileSize: async (filePath) => {
    try {
      const stats = await stat(filePath)
      return stats.isFile() ? stats.size : undefined
    } catch {
      return undefined
    }
  },
  openWriteStream: async (filePath) => {
    const handle = await open(filePath, 'w')
    return {
      write: async (chunk) => {
        await handle.write(chunk)
      },
      close: () => handle.close()
    }
  },
  rename: (from, to) => rename(from, to),
  remove: async (filePath) => {
    try {
      await unlink(filePath)
    } catch {
      // Nothing to clean up: the partial file was never created, or is already gone.
    }
  },
  listFiles: async (directory) => {
    try {
      const entries = await readdir(directory, { withFileTypes: true })
      return entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
    } catch {
      // No updates directory yet, or it cannot be read: there is nothing to sweep.
      return []
    }
  }
}

const defaultSpawnInstaller: InstallerSpawner = (file, args, options) => spawn(file, [...args], options)

const defaultQuit: QuitApp = () => app.quit()

const defaultTimeoutSignal: TimeoutSignalFactory = (milliseconds) => AbortSignal.timeout(milliseconds)

// AbortSignal.timeout surfaces as a TimeoutError; an explicit abort surfaces as AbortError.
const isAbortFailure = (error: unknown): boolean => {
  const name = error instanceof Error ? error.name : ''
  return name === 'TimeoutError' || name === 'AbortError'
}

const describeRequestFailure = (error: unknown): string =>
  isAbortFailure(error) ? 'The update download timed out.' : 'Network request failed.'

const describeFailure = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : String(error)

// The timeout factory is injectable and may answer undefined (a test that wants no timeout),
// so the cancel signal has to survive on its own.
const combineSignals = (cancel: AbortSignal, timeout: AbortSignal | undefined): AbortSignal =>
  timeout ? AbortSignal.any([cancel, timeout]) : cancel

const UNREADABLE_RESPONSE = 'GitHub returned a response CodeFly could not read.'
const WINDOWS_ONLY_UPDATE = 'In-app updates are available on Windows only.'

type ReadyInstaller = { filePath: string; fileName: string; version: string }

/**
 * Downloads the Windows installer published with the latest GitHub release, then hands it to
 * the OS when the user asks to install.
 *
 * Two rules shape the whole service. First, the renderer never names a URL: `download()`
 * takes no arguments and re-resolves the release asset itself, and the resolved link is only
 * followed when it is an https GitHub URL (see isTrustedInstallerUrl) with a plain file name,
 * because the downloaded file is about to be executed. Second, nothing here ever rejects:
 * every failure is folded into an `error` result, exactly like AppInfoService.checkForUpdates,
 * so the renderer — which can only read `error.message` across the IPC boundary — always gets
 * a displayable outcome.
 */
export class UpdaterService {
  private readonly listeners = new Set<(progress: UpdateDownloadProgress) => void>()
  private inFlight: Promise<UpdateDownloadResult> | undefined
  private controller: AbortController | undefined
  private ready: ReadyInstaller | undefined
  /** Set once an installer process has been confirmed started; makes install() idempotent. */
  private launched = false

  constructor(
    private readonly getVersion: GetVersion = defaultGetVersion,
    private readonly fetch: FetchLike = defaultFetch,
    private readonly getUserDataPath: UserDataPath = () => app.getPath('userData'),
    private readonly fileSystem: UpdaterFileSystem = defaultFileSystem,
    private readonly spawnInstaller: InstallerSpawner = defaultSpawnInstaller,
    private readonly quit: QuitApp = defaultQuit,
    private readonly createTimeoutSignal: TimeoutSignalFactory = defaultTimeoutSignal,
    private readonly now: Clock = Date.now,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  onProgress(listener: (progress: UpdateDownloadProgress) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Starts (or joins) the download of the latest release installer. Deliberately not `async`:
   * a second call while a download is running must hand back the *same* promise rather than
   * start a competing download over the same `.part` file.
   */
  download(): Promise<UpdateDownloadResult> {
    if (this.platform !== 'win32') return Promise.resolve({ status: 'error', message: WINDOWS_ONLY_UPDATE })
    if (this.inFlight) return this.inFlight

    const controller = new AbortController()
    this.controller = controller
    const run = this.runDownload(controller.signal).finally(() => {
      this.inFlight = undefined
      if (this.controller === controller) this.controller = undefined
    })
    this.inFlight = run
    return run
  }

  /**
   * Aborts a running download and waits for it to unwind. The partial file is deleted by the
   * download itself once it has closed its write stream — deleting it from here would race
   * with a write that is still in flight (and Windows refuses to unlink an open file anyway).
   */
  async cancel(): Promise<void> {
    const inFlight = this.inFlight
    this.controller?.abort()
    // runDownload folds every failure into a result, but a rejection escaping a user action
    // that cannot meaningfully fail would surface as an unhandled IPC rejection.
    if (inFlight) await inFlight.then(undefined, () => undefined)
  }

  async install(): Promise<UpdateInstallResult> {
    if (this.platform !== 'win32') return { status: 'error', message: WINDOWS_ONLY_UPDATE }
    // Quitting is not instant — the app still tears down every PTY first — so the user has a
    // real window in which to click again. A second NSIS wizard racing the first over the
    // same install directory is worth guarding against here as well as in the renderer.
    if (this.launched) return { status: 'launched' }

    const ready = this.ready
    if (!ready) return { status: 'error', message: 'No installer has been downloaded yet. Download the update first.' }

    if ((await this.fileSize(ready.filePath)) === undefined) {
      return { status: 'error', message: 'The downloaded installer is no longer on disk. Download the update again.' }
    }

    const launch = await this.launchInstaller(ready.filePath)
    // CodeFly stays open on failure: quitting would leave the user with neither a running app
    // nor a running installer, and no idea that anything went wrong.
    if (!launch.ok) return { status: 'error', message: `Could not start the installer: ${launch.reason}` }

    this.launched = true

    // The installer overwrites files this process holds open, so CodeFly has to exit for it
    // to succeed. A failure to quit is not worth reporting — the installer is already up.
    try {
      this.quit()
    } catch (error) {
      console.error('UpdaterService: failed to quit after launching the installer.', error)
    }
    return { status: 'launched' }
  }

  /**
   * Starts the installer and waits for the OS to confirm it. `spawn` resolves synchronously
   * for a file that can never run — a quarantined, blocked, or deleted installer surfaces as
   * an `'error'` event on a later tick — so returning as soon as spawn returns would report
   * success for a launch that never happened, quit the app, and leave the unhandled `'error'`
   * event to crash the main process on its way out.
   */
  private launchInstaller(filePath: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    let installer: SpawnedInstaller
    try {
      installer = this.spawnInstaller(filePath, [], { detached: true, stdio: 'ignore' })
    } catch (error) {
      return Promise.resolve({ ok: false, reason: describeFailure(error) })
    }

    return new Promise((resolve) => {
      let settled = false
      const settle = (result: { ok: true } | { ok: false; reason: string }): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }

      // A process that reports neither outcome must not hang the invoke forever; the app
      // stays open, which is the same safe answer as an explicit failure.
      const timer = setTimeout(() => {
        settle({ ok: false, reason: 'the installer did not start in time' })
      }, SPAWN_CONFIRMATION_TIMEOUT_MS)
      // Node keeps the process alive for a pending timer; this one must never delay a quit.
      timer.unref?.()

      // Attached before anything else: an 'error' with no listener is a hard crash.
      installer.on('error', (error) => {
        settle({ ok: false, reason: describeFailure(error) })
      })
      installer.on('spawn', () => {
        // Only now is the child real enough to outlive this process.
        installer.unref()
        settle({ ok: true })
      })
    })
  }

  /**
   * `UpdaterFileSystem.fileSize` is documented as never rejecting, but this class promises
   * callers something stronger — that nothing here ever rejects — and an injected filesystem
   * is not this class's to trust. An unreadable file is indistinguishable from a missing one
   * for every decision made from this answer.
   */
  private async fileSize(filePath: string): Promise<number | undefined> {
    try {
      return await this.fileSystem.fileSize(filePath)
    } catch {
      return undefined
    }
  }

  /**
   * Deletes everything in the updates directory except the installer just downloaded —
   * superseded installers from earlier updates, and `.part` files orphaned by a crash or a
   * kill mid-download (every ordinary exit path removes its own). Without this the directory
   * grows by an installer per update, forever, inside the user's roaming profile.
   *
   * Best-effort by design: a successful download must not be reported as a failure because
   * housekeeping could not delete a file someone else has open.
   */
  private async sweepSupersededInstallers(directory: string, keepFileName: string): Promise<void> {
    try {
      const names = await this.fileSystem.listFiles(directory)
      for (const name of names) {
        if (name === keepFileName) continue
        await this.fileSystem.remove(join(directory, name))
      }
    } catch (error) {
      console.error('UpdaterService: failed to clean up superseded installers.', error)
    }
  }

  private async runDownload(signal: AbortSignal): Promise<UpdateDownloadResult> {
    const currentVersion = this.getVersion()

    let response: UpdaterHttpResponse
    try {
      response = await this.fetch(LATEST_RELEASE_URL, {
        headers: { ...REQUEST_HEADERS },
        // The metadata request keeps the same short timeout as the update check; the asset
        // request below must not, because a large installer legitimately takes minutes. The
        // cancel signal is combined in so that hitting Cancel against a hung api.github.com
        // lands immediately instead of leaving the dialog frozen for the whole timeout.
        signal: combineSignals(signal, this.createTimeoutSignal(REQUEST_TIMEOUT_MS))
      })
    } catch (error) {
      // Aborting this request is now how Cancel lands during the metadata round trip, so the
      // abort has to read as the user's own choice rather than as a network failure.
      if (signal.aborted) return { status: 'cancelled' }
      return { status: 'error', message: describeRequestFailure(error) }
    }

    if (response.status === 404) return { status: 'error', message: 'No published release is available to download.' }
    if (!response.ok) return { status: 'error', message: `GitHub returned HTTP ${response.status}.` }

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return { status: 'error', message: UNREADABLE_RESPONSE }
    }

    const release = latestReleaseSchema.safeParse(payload)
    if (!release.success) return { status: 'error', message: UNREADABLE_RESPONSE }

    const version = stripVersionPrefix(release.data.tag_name)
    if (!parseSemVer(version)) {
      return { status: 'error', message: `Could not read a version number from the release tag "${release.data.tag_name}".` }
    }

    const comparison = compareVersionStrings(version, currentVersion)
    if (comparison === null) {
      return { status: 'error', message: `Could not compare the installed version "${currentVersion}" with the latest release.` }
    }
    // The release is re-resolved here rather than trusted from the earlier check, so a user
    // who already updated by hand cannot be talked into downloading an older installer.
    if (comparison <= 0) return { status: 'error', message: 'CodeFly is already up to date.' }

    const installer = pickWindowsInstaller(release.data.assets)
    if (!installer) {
      return { status: 'error', message: `Release ${version} does not publish a Windows installer to download.` }
    }
    if (!isTrustedInstallerUrl(installer.downloadUrl)) {
      return { status: 'error', message: 'The installer download link does not point at GitHub, so it was not downloaded.' }
    }

    if (signal.aborted) return { status: 'cancelled' }
    return this.downloadInstaller(installer, version, signal)
  }

  private async downloadInstaller(
    installer: WindowsInstaller,
    version: string,
    signal: AbortSignal
  ): Promise<UpdateDownloadResult> {
    const directory = join(this.getUserDataPath(), UPDATES_DIRECTORY)
    const targetPath = join(directory, installer.fileName)
    const partPath = `${targetPath}${PART_SUFFIX}`

    try {
      await this.fileSystem.ensureDirectory(directory)
    } catch (error) {
      return { status: 'error', message: `Could not create the download folder: ${describeFailure(error)}` }
    }

    // A complete installer of the expected size is reused as-is: the user may have picked
    // "install later" and reopened CodeFly, and downloading it again would be pure waste.
    // There is no resume — a file of any other size is replaced by a fresh download.
    const existingBytes = await this.fileSize(targetPath)
    if (installer.size > 0 && existingBytes === installer.size) {
      await this.sweepSupersededInstallers(directory, installer.fileName)
      this.ready = { filePath: targetPath, fileName: installer.fileName, version }
      return { status: 'ready', version, fileName: installer.fileName }
    }

    let response: UpdaterHttpResponse
    try {
      response = await this.fetch(installer.downloadUrl, { headers: { ...DOWNLOAD_HEADERS }, signal })
    } catch (error) {
      if (signal.aborted) return { status: 'cancelled' }
      return { status: 'error', message: describeRequestFailure(error) }
    }

    if (!response.ok) return { status: 'error', message: `The installer download failed with HTTP ${response.status}.` }
    const body = response.body
    if (!body) return { status: 'error', message: 'The installer download returned no content.' }

    // Content-Length is authoritative for the transfer; the asset size from the release
    // metadata is the fallback, and 0 means "unknown", which the UI renders indeterminate.
    const declaredBytes = Number(response.headers?.get('content-length') ?? '')
    const totalBytes = Number.isFinite(declaredBytes) && declaredBytes > 0 ? declaredBytes : Math.max(installer.size, 0)

    let stream: InstallerWriteStream
    try {
      stream = await this.fileSystem.openWriteStream(partPath)
    } catch (error) {
      return { status: 'error', message: `Could not save the installer: ${describeFailure(error)}` }
    }

    let receivedBytes = 0
    let lastReportedAt = this.now()
    let lastReportedBytes = 0
    this.emitProgress({ version, receivedBytes: 0, totalBytes })

    try {
      for await (const chunk of body) {
        // Checked here as well as by the fetch signal: cancellation must land even when the
        // body being iterated does not honour the signal itself.
        if (signal.aborted) return this.discardPartial(partPath, stream, { status: 'cancelled' })

        await stream.write(chunk)
        receivedBytes += chunk.byteLength

        const at = this.now()
        if (at - lastReportedAt >= PROGRESS_INTERVAL_MS || receivedBytes - lastReportedBytes >= PROGRESS_BYTES) {
          lastReportedAt = at
          lastReportedBytes = receivedBytes
          this.emitProgress({ version, receivedBytes, totalBytes })
        }
      }
      await stream.close()
    } catch (error) {
      if (signal.aborted) return this.discardPartial(partPath, stream, { status: 'cancelled' })
      return this.discardPartial(partPath, stream, {
        status: 'error',
        message: `The installer download could not be completed: ${describeFailure(error)}`
      })
    }

    const writtenBytes = await this.fileSize(partPath)
    if (totalBytes > 0 && writtenBytes !== totalBytes) {
      await this.fileSystem.remove(partPath)
      return {
        status: 'error',
        message: `The downloaded installer is incomplete: expected ${totalBytes} bytes but got ${writtenBytes ?? receivedBytes}.`
      }
    }
    // With no declared size there is nothing to verify against, so an empty or unreadable
    // result is the only thing that can still be caught — and it must be, because this file
    // is about to be renamed to `.exe`, offered as "ready to install", and executed.
    if (totalBytes === 0 && !writtenBytes) {
      await this.fileSystem.remove(partPath)
      return { status: 'error', message: 'The installer download arrived empty. Try again, or download it from the releases page.' }
    }

    try {
      // A stale installer of a different size is removed first: rename must not be relied on
      // to replace an existing file.
      await this.fileSystem.remove(targetPath)
      await this.fileSystem.rename(partPath, targetPath)
    } catch (error) {
      await this.fileSystem.remove(partPath)
      return { status: 'error', message: `Could not save the installer: ${describeFailure(error)}` }
    }

    await this.sweepSupersededInstallers(directory, installer.fileName)

    // The throttle can swallow the last chunk's frame, so completion is always reported once
    // the bytes are verified and in place.
    this.emitProgress({ version, receivedBytes, totalBytes: totalBytes > 0 ? totalBytes : receivedBytes })
    this.ready = { filePath: targetPath, fileName: installer.fileName, version }
    return { status: 'ready', version, fileName: installer.fileName }
  }

  private async discardPartial<TResult extends UpdateDownloadResult>(
    partPath: string,
    stream: InstallerWriteStream,
    result: TResult
  ): Promise<TResult> {
    try {
      await stream.close()
    } catch {
      // The stream is already closed, or closing is what failed; either way the partial file
      // still has to go.
    }
    await this.fileSystem.remove(partPath)
    return result
  }

  private emitProgress(progress: UpdateDownloadProgress): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(progress)
      } catch {
        // A subscriber failure must not abort the download or starve other subscribers.
      }
    }
  }
}
