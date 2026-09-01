import { spawn } from 'node:child_process'
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import { app } from 'electron'

import type { UpdateDownloadProgress, UpdateDownloadResult, UpdateInstallResult } from '../../shared/contracts'
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
// real installer into a real userData directory.
export type UpdaterFileSystem = {
  ensureDirectory(directory: string): Promise<void>
  /** Byte size of an existing file, or undefined when it is missing or is not a file. */
  fileSize(filePath: string): Promise<number | undefined>
  openWriteStream(filePath: string): Promise<InstallerWriteStream>
  rename(from: string, to: string): Promise<void>
  /** Best-effort delete: a file that is already gone is not an error. */
  remove(filePath: string): Promise<void>
}

export type SpawnedInstaller = { unref(): void }

export type InstallerSpawner = (
  file: string,
  args: readonly string[],
  options: { detached: true; stdio: 'ignore' }
) => SpawnedInstaller

export type QuitApp = () => void
export type Clock = () => number
export type UserDataPath = () => string

const defaultGetVersion: GetVersion = () => app.getVersion()

const defaultFetch: FetchLike = async (url, init) => {
  const response = await fetch(url, init)
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    json: () => response.json(),
    // Node's fetch answers with a web ReadableStream, which is async-iterable.
    body: response.body as AsyncIterable<Uint8Array> | null
  }
}

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

const UNREADABLE_RESPONSE = 'GitHub returned a response CodeFly could not read.'

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

  constructor(
    private readonly getVersion: GetVersion = defaultGetVersion,
    private readonly fetch: FetchLike = defaultFetch,
    private readonly getUserDataPath: UserDataPath = () => app.getPath('userData'),
    private readonly fileSystem: UpdaterFileSystem = defaultFileSystem,
    private readonly spawnInstaller: InstallerSpawner = defaultSpawnInstaller,
    private readonly quit: QuitApp = defaultQuit,
    private readonly createTimeoutSignal: TimeoutSignalFactory = defaultTimeoutSignal,
    private readonly now: Clock = Date.now
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
    const ready = this.ready
    if (!ready) return { status: 'error', message: 'No installer has been downloaded yet. Download the update first.' }

    if ((await this.fileSystem.fileSize(ready.filePath)) === undefined) {
      return { status: 'error', message: 'The downloaded installer is no longer on disk. Download the update again.' }
    }

    try {
      // Detached and unref'd so the installer outlives the quit below; it is the installer,
      // not CodeFly, that owns the rest of the flow from here.
      this.spawnInstaller(ready.filePath, [], { detached: true, stdio: 'ignore' }).unref()
    } catch (error) {
      // CodeFly stays open on failure: quitting would leave the user with neither a running
      // app nor a running installer.
      return { status: 'error', message: `Could not start the installer: ${describeFailure(error)}` }
    }

    // The installer overwrites files this process holds open, so CodeFly has to exit for it
    // to succeed. A failure to quit is not worth reporting — the installer is already up.
    try {
      this.quit()
    } catch (error) {
      console.error('UpdaterService: failed to quit after launching the installer.', error)
    }
    return { status: 'launched' }
  }

  private async runDownload(signal: AbortSignal): Promise<UpdateDownloadResult> {
    const currentVersion = this.getVersion()

    let response: UpdaterHttpResponse
    try {
      response = await this.fetch(LATEST_RELEASE_URL, {
        headers: { ...REQUEST_HEADERS },
        // The metadata request keeps the same short timeout as the update check; the asset
        // request below must not, because a large installer legitimately takes minutes.
        signal: this.createTimeoutSignal(REQUEST_TIMEOUT_MS)
      })
    } catch (error) {
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
    const existingBytes = await this.fileSystem.fileSize(targetPath)
    if (installer.size > 0 && existingBytes === installer.size) {
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

    const writtenBytes = await this.fileSystem.fileSize(partPath)
    if (totalBytes > 0 && writtenBytes !== totalBytes) {
      await this.fileSystem.remove(partPath)
      return {
        status: 'error',
        message: `The downloaded installer is incomplete: expected ${totalBytes} bytes but got ${writtenBytes ?? receivedBytes}.`
      }
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
