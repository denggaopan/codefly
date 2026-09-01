import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { UpdateDownloadProgress } from '../../shared/contracts'
import {
  UpdaterService,
  type FetchLike,
  type InstallerSpawner,
  type InstallerWriteStream,
  type UpdaterFileSystem,
  type UpdaterHttpResponse
} from './updater-service'

const RELEASE_URL = 'https://api.github.com/repos/denggaopan/codefly/releases/latest'
const CURRENT_VERSION = '0.4.1'
const LATEST_VERSION = '0.5.0'
const INSTALLER_NAME = 'CodeFly-Setup-0.5.0-win-x64.exe'
const INSTALLER_URL = `https://github.com/denggaopan/codefly/releases/download/v0.5.0/${INSTALLER_NAME}`
const USER_DATA = join('C:\\Users\\tester\\AppData\\Roaming\\CodeFly')
const UPDATES_DIRECTORY = join(USER_DATA, 'updates')
const INSTALLER_PATH = join(UPDATES_DIRECTORY, INSTALLER_NAME)
const PART_PATH = `${INSTALLER_PATH}.part`

const chunk = (size: number): Uint8Array => new Uint8Array(size)

const byteCount = (chunks: readonly Uint8Array[]): number => chunks.reduce((total, item) => total + item.byteLength, 0)

const releaseAsset = (overrides: Record<string, unknown> = {}): unknown => ({
  name: INSTALLER_NAME,
  size: 900,
  browser_download_url: INSTALLER_URL,
  // Extra fields mirror the real GitHub payload; the service must ignore them.
  content_type: 'application/x-msdownload',
  download_count: 12,
  ...overrides
})

const releasePayload = (overrides: { tag?: string; assets?: unknown[] } = {}): unknown => ({
  tag_name: overrides.tag ?? `v${LATEST_VERSION}`,
  html_url: `https://github.com/denggaopan/codefly/releases/tag/v${LATEST_VERSION}`,
  id: 7,
  draft: false,
  assets: overrides.assets ?? [releaseAsset()]
})

type Deferred = { promise: Promise<void>; resolve: () => void }

const deferred = (): Deferred => {
  let resolve = (): void => undefined
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const streamOf = (
  chunks: readonly Uint8Array[],
  beforeChunk?: (index: number) => Promise<void> | void
): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    for (let index = 0; index < chunks.length; index += 1) {
      await beforeChunk?.(index)
      yield chunks[index]!
    }
  }
})

const failingStream = (error: Error, before: readonly Uint8Array[]): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    for (const item of before) yield item
    throw error
  }
})

const named = (name: string, message = name): Error => {
  const error = new Error(message)
  error.name = name
  return error
}

/**
 * In-memory stand-in for the updater's filesystem surface. Files are tracked as byte counts,
 * which is everything the service reads back (it verifies sizes, never contents), and every
 * mutation is recorded so tests can assert that a failed or cancelled download leaves no
 * `.part` file behind.
 */
class FakeFileSystem implements UpdaterFileSystem {
  readonly files = new Map<string, number>()
  readonly directories: string[] = []
  readonly opened: string[] = []
  readonly removed: string[] = []
  readonly renamed: Array<{ from: string; to: string }> = []
  readonly failures: { ensureDirectory?: Error; openWriteStream?: Error; write?: Error; rename?: Error } = {}

  async ensureDirectory(directory: string): Promise<void> {
    if (this.failures.ensureDirectory) throw this.failures.ensureDirectory
    this.directories.push(directory)
  }

  async fileSize(filePath: string): Promise<number | undefined> {
    return this.files.get(filePath)
  }

  async openWriteStream(filePath: string): Promise<InstallerWriteStream> {
    if (this.failures.openWriteStream) throw this.failures.openWriteStream
    this.opened.push(filePath)
    this.files.set(filePath, 0)
    let closed = false
    return {
      write: async (data) => {
        if (this.failures.write) throw this.failures.write
        if (closed) throw new Error(`Write after close: ${filePath}`)
        this.files.set(filePath, (this.files.get(filePath) ?? 0) + data.byteLength)
      },
      close: async () => {
        closed = true
      }
    }
  }

  async rename(from: string, to: string): Promise<void> {
    if (this.failures.rename) throw this.failures.rename
    const size = this.files.get(from)
    if (size === undefined) throw new Error(`ENOENT: ${from}`)
    this.files.delete(from)
    this.files.set(to, size)
    this.renamed.push({ from, to })
  }

  async remove(filePath: string): Promise<void> {
    this.removed.push(filePath)
    this.files.delete(filePath)
  }
}

type HarnessOptions = {
  version?: string
  releaseStatus?: number
  releasePayload?: unknown
  releaseUnreadable?: boolean
  releaseFails?: unknown
  assetStatus?: number
  assetFails?: unknown
  assetBody?: AsyncIterable<Uint8Array> | null
  chunks?: readonly Uint8Array[]
  contentLength?: string | null
  beforeChunk?: (index: number) => Promise<void> | void
  existingFiles?: Record<string, number>
  fileSystem?: FakeFileSystem
  clockStepMs?: number
  spawnFails?: Error
}

type Harness = {
  service: UpdaterService
  fileSystem: FakeFileSystem
  requests: Array<{ url: string; headers: Record<string, string>; signal?: AbortSignal }>
  timeouts: number[]
  progress: UpdateDownloadProgress[]
  spawns: Array<{ file: string; args: readonly string[]; options: unknown }>
  calls: { unrefs: number; quits: number }
}

const buildHarness = (options: HarnessOptions = {}): Harness => {
  const chunks = options.chunks ?? [chunk(400), chunk(500)]
  const fileSystem = options.fileSystem ?? new FakeFileSystem()
  for (const [filePath, size] of Object.entries(options.existingFiles ?? {})) fileSystem.files.set(filePath, size)

  const requests: Harness['requests'] = []
  const timeouts: number[] = []
  const progress: UpdateDownloadProgress[] = []
  const spawns: Harness['spawns'] = []
  const calls = { unrefs: 0, quits: 0 }

  const releaseStatus = options.releaseStatus ?? 200
  const assetStatus = options.assetStatus ?? 200
  const contentLength = options.contentLength === undefined ? String(byteCount(chunks)) : options.contentLength

  const fetchImpl: FetchLike = async (url, init) => {
    requests.push({ url, headers: init.headers, signal: init.signal })

    if (url === RELEASE_URL) {
      if (options.releaseFails) throw options.releaseFails
      return {
        ok: releaseStatus >= 200 && releaseStatus < 300,
        status: releaseStatus,
        headers: { get: () => null },
        json: async () => {
          if (options.releaseUnreadable) throw new SyntaxError('Unexpected token < in JSON')
          return options.releasePayload ?? releasePayload()
        }
      } satisfies UpdaterHttpResponse
    }

    if (options.assetFails) throw options.assetFails
    return {
      ok: assetStatus >= 200 && assetStatus < 300,
      status: assetStatus,
      headers: { get: (name) => (name.toLowerCase() === 'content-length' ? contentLength : null) },
      json: async () => null,
      body: options.assetBody === undefined ? streamOf(chunks, options.beforeChunk) : options.assetBody
    } satisfies UpdaterHttpResponse
  }

  const spawnInstaller: InstallerSpawner = (file, args, spawnOptions) => {
    spawns.push({ file, args, options: spawnOptions })
    if (options.spawnFails) throw options.spawnFails
    return {
      unref: () => {
        calls.unrefs += 1
      }
    }
  }

  // A clock the test drives: frozen by default, so only the byte threshold can trigger a
  // progress frame and the throttle is observable without real timers.
  let clock = 0
  const now = (): number => {
    const current = clock
    clock += options.clockStepMs ?? 0
    return current
  }

  const service = new UpdaterService(
    () => options.version ?? CURRENT_VERSION,
    fetchImpl,
    () => USER_DATA,
    fileSystem,
    spawnInstaller,
    () => {
      calls.quits += 1
    },
    (milliseconds) => {
      timeouts.push(milliseconds)
      return undefined
    },
    now
  )

  service.onProgress((frame) => progress.push(frame))

  return { service, fileSystem, requests, timeouts, progress, spawns, calls }
}

describe('UpdaterService.download: happy path', () => {
  it('streams the release installer into userData/updates and reports it ready', async () => {
    const harness = buildHarness()

    await expect(harness.service.download()).resolves.toEqual({
      status: 'ready',
      version: LATEST_VERSION,
      fileName: INSTALLER_NAME
    })

    expect(harness.fileSystem.directories).toEqual([UPDATES_DIRECTORY])
    // Written to `.part` first, then renamed: an interrupted download can never be mistaken
    // for a ready installer.
    expect(harness.fileSystem.opened).toEqual([PART_PATH])
    expect(harness.fileSystem.renamed).toEqual([{ from: PART_PATH, to: INSTALLER_PATH }])
    expect(harness.fileSystem.files.get(INSTALLER_PATH)).toBe(900)
    expect(harness.fileSystem.files.has(PART_PATH)).toBe(false)
  })

  it('asks GitHub for the release with the documented headers and a 10s timeout, then follows the asset URL', async () => {
    const harness = buildHarness()

    await harness.service.download()

    expect(harness.requests.map((request) => request.url)).toEqual([RELEASE_URL, INSTALLER_URL])
    expect(harness.requests[0]!.headers).toEqual({ Accept: 'application/vnd.github+json', 'User-Agent': 'CodeFly' })
    expect(harness.requests[1]!.headers).toEqual({ Accept: 'application/octet-stream', 'User-Agent': 'CodeFly' })
    // Only the metadata request is time-boxed; a large installer legitimately takes minutes,
    // so the asset request carries the cancellation signal instead.
    expect(harness.timeouts).toEqual([10_000])
    expect(harness.requests[0]!.signal).toBeUndefined()
    expect(harness.requests[1]!.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('UpdaterService.download: progress reporting', () => {
  it('opens at 0 bytes and closes at 100% without a frame per chunk', async () => {
    const harness = buildHarness({ chunks: [chunk(100), chunk(100), chunk(100)] })

    await harness.service.download()

    expect(harness.progress).toEqual([
      { version: LATEST_VERSION, receivedBytes: 0, totalBytes: 300 },
      { version: LATEST_VERSION, receivedBytes: 300, totalBytes: 300 }
    ])
  })

  it('reports again once the throttle interval has elapsed', async () => {
    const harness = buildHarness({ chunks: [chunk(100), chunk(100), chunk(100)], clockStepMs: 250 })

    await harness.service.download()

    expect(harness.progress.map((frame) => frame.receivedBytes)).toEqual([0, 100, 200, 300, 300])
  })

  it('reports again once 256 KB have arrived, even when no time has passed', async () => {
    const harness = buildHarness({ chunks: [chunk(100_000), chunk(100_000), chunk(100_000), chunk(100_000)] })

    await harness.service.download()

    expect(harness.progress.map((frame) => frame.receivedBytes)).toEqual([0, 300_000, 400_000])
  })

  it('falls back to the asset size when the response declares no length', async () => {
    const harness = buildHarness({ contentLength: null })

    await harness.service.download()

    expect(harness.progress[0]).toEqual({ version: LATEST_VERSION, receivedBytes: 0, totalBytes: 900 })
  })

  it('reports 0 total bytes, which the UI renders indeterminate, when neither side knows the size', async () => {
    const harness = buildHarness({
      contentLength: null,
      releasePayload: releasePayload({ assets: [releaseAsset({ size: undefined })] })
    })

    await harness.service.download()

    expect(harness.progress[0]).toEqual({ version: LATEST_VERSION, receivedBytes: 0, totalBytes: 0 })
    expect(harness.progress.at(-1)).toEqual({ version: LATEST_VERSION, receivedBytes: 900, totalBytes: 900 })
  })

  it('stops delivering frames to an unsubscribed listener', async () => {
    const harness = buildHarness()
    const frames: UpdateDownloadProgress[] = []
    const unsubscribe = harness.service.onProgress((frame) => frames.push(frame))

    unsubscribe()
    await harness.service.download()

    expect(frames).toEqual([])
    expect(harness.progress.length).toBeGreaterThan(0)
  })

  it('keeps downloading when a progress subscriber throws', async () => {
    const harness = buildHarness()
    harness.service.onProgress(() => {
      throw new Error('renderer went away')
    })

    await expect(harness.service.download()).resolves.toMatchObject({ status: 'ready' })
  })
})

describe('UpdaterService.download: reusing an installer already on disk', () => {
  it('skips the transfer when the target file already has the expected size', async () => {
    const harness = buildHarness({ existingFiles: { [INSTALLER_PATH]: 900 } })

    await expect(harness.service.download()).resolves.toEqual({
      status: 'ready',
      version: LATEST_VERSION,
      fileName: INSTALLER_NAME
    })

    // Only the release lookup happened: no asset request, no write stream, no progress.
    expect(harness.requests.map((request) => request.url)).toEqual([RELEASE_URL])
    expect(harness.fileSystem.opened).toEqual([])
    expect(harness.progress).toEqual([])
  })

  it('replaces a file of a different size instead of resuming it', async () => {
    const harness = buildHarness({ existingFiles: { [INSTALLER_PATH]: 120 } })

    await expect(harness.service.download()).resolves.toMatchObject({ status: 'ready' })

    expect(harness.requests.map((request) => request.url)).toEqual([RELEASE_URL, INSTALLER_URL])
    expect(harness.fileSystem.files.get(INSTALLER_PATH)).toBe(900)
  })
})

describe('UpdaterService.download: only trusted GitHub URLs are followed', () => {
  it.each([
    ['a foreign host', 'https://evil.invalid/CodeFly-Setup-0.5.0-win-x64.exe'],
    ['plain http', 'http://github.com/denggaopan/codefly/releases/download/v0.5.0/CodeFly-Setup-0.5.0-win-x64.exe'],
    ['a lookalike host', 'https://github.com.evil.invalid/CodeFly-Setup-0.5.0-win-x64.exe'],
    ['a file URL', 'file:///C:/temp/CodeFly-Setup-0.5.0-win-x64.exe']
  ])('refuses to download from %s', async (_label, url) => {
    const harness = buildHarness({ releasePayload: releasePayload({ assets: [releaseAsset({ browser_download_url: url })] }) })

    await expect(harness.service.download()).resolves.toEqual({
      status: 'error',
      message: 'The installer download link does not point at GitHub, so it was not downloaded.'
    })
    expect(harness.requests.map((request) => request.url)).toEqual([RELEASE_URL])
    expect(harness.fileSystem.opened).toEqual([])
  })

  it('accepts the release-asset CDN host GitHub redirects to', async () => {
    const harness = buildHarness({
      releasePayload: releasePayload({
        assets: [releaseAsset({ browser_download_url: `https://objects.githubusercontent.com/gh/${INSTALLER_NAME}` })]
      })
    })

    await expect(harness.service.download()).resolves.toMatchObject({ status: 'ready' })
  })

  it.each([
    ['a path separator', 'sub/CodeFly-Setup.exe'],
    ['a parent segment', '..\\CodeFly-Setup.exe'],
    ['a drive letter', 'C:CodeFly-Setup.exe']
  ])('treats an asset named with %s as no installer at all', async (_label, name) => {
    const harness = buildHarness({ releasePayload: releasePayload({ assets: [releaseAsset({ name })] }) })

    await expect(harness.service.download()).resolves.toEqual({
      status: 'error',
      message: `Release ${LATEST_VERSION} does not publish a Windows installer to download.`
    })
    expect(harness.fileSystem.opened).toEqual([])
  })
})

describe('UpdaterService.download: failures are results, never rejections', () => {
  it('reports an HTTP failure on the release lookup', async () => {
    const harness = buildHarness({ releaseStatus: 503 })

    await expect(harness.service.download()).resolves.toEqual({ status: 'error', message: 'GitHub returned HTTP 503.' })
  })

  it('reports a repository with no published release', async () => {
    const harness = buildHarness({ releaseStatus: 404 })

    await expect(harness.service.download()).resolves.toEqual({
      status: 'error',
      message: 'No published release is available to download.'
    })
  })

  it('maps a rejected request to a network error', async () => {
    const harness = buildHarness({ releaseFails: new Error('getaddrinfo ENOTFOUND api.github.com') })

    await expect(harness.service.download()).resolves.toEqual({ status: 'error', message: 'Network request failed.' })
  })

  it.each(['TimeoutError', 'AbortError'])('maps an aborted release lookup (%s) to a timeout message', async (name) => {
    const harness = buildHarness({ releaseFails: named(name) })

    await expect(harness.service.download()).resolves.toEqual({ status: 'error', message: 'The update download timed out.' })
  })

  it('reports an unreadable release body', async () => {
    const harness = buildHarness({ releaseUnreadable: true })

    await expect(harness.service.download()).resolves.toEqual({
      status: 'error',
      message: 'GitHub returned a response CodeFly could not read.'
    })
  })

  it('reports a payload it cannot parse at all, and never rejects on a thrown non-Error', async () => {
    const harness = buildHarness({ releasePayload: { html_url: 'https://example.invalid' } })

    await expect(harness.service.download()).resolves.toEqual({
      status: 'error',
      message: 'GitHub returned a response CodeFly could not read.'
    })

    const thrown = buildHarness({ releaseFails: 'boom' })
    await expect(thrown.service.download()).resolves.toEqual({ status: 'error', message: 'Network request failed.' })
  })

  it('refuses to download a release that is not newer than the running build', async () => {
    const harness = buildHarness({ version: '0.5.0' })

    await expect(harness.service.download()).resolves.toEqual({ status: 'error', message: 'CodeFly is already up to date.' })
    expect(harness.requests.map((request) => request.url)).toEqual([RELEASE_URL])
  })

  it('reports a release tag it cannot read a version from', async () => {
    const harness = buildHarness({ releasePayload: releasePayload({ tag: 'nightly' }) })

    await expect(harness.service.download()).resolves.toEqual({
      status: 'error',
      message: 'Could not read a version number from the release tag "nightly".'
    })
  })

  it('reports a running version it cannot compare', async () => {
    const harness = buildHarness({ version: 'dev' })

    await expect(harness.service.download()).resolves.toEqual({
      status: 'error',
      message: 'Could not compare the installed version "dev" with the latest release.'
    })
  })

  it('reports a release that publishes no Windows installer', async () => {
    const harness = buildHarness({
      releasePayload: releasePayload({ assets: [releaseAsset({ name: 'CodeFly-0.5.0-win-x64.zip' })] })
    })

    await expect(harness.service.download()).resolves.toEqual({
      status: 'error',
      message: `Release ${LATEST_VERSION} does not publish a Windows installer to download.`
    })
  })

  it('reports an HTTP failure on the asset itself and leaves no partial file', async () => {
    const harness = buildHarness({ assetStatus: 500 })

    await expect(harness.service.download()).resolves.toEqual({
      status: 'error',
      message: 'The installer download failed with HTTP 500.'
    })
    expect(harness.fileSystem.opened).toEqual([])
    expect(harness.fileSystem.files.has(PART_PATH)).toBe(false)
  })

  it('reports an asset response with no body', async () => {
    const harness = buildHarness({ assetBody: null })

    await expect(harness.service.download()).resolves.toEqual({
      status: 'error',
      message: 'The installer download returned no content.'
    })
  })

  it('deletes the partial file when the transfer breaks mid-stream', async () => {
    const harness = buildHarness({ assetBody: failingStream(new Error('socket hang up'), [chunk(400)]) })

    await expect(harness.service.download()).resolves.toEqual({
      status: 'error',
      message: 'The installer download could not be completed: socket hang up'
    })
    expect(harness.fileSystem.opened).toEqual([PART_PATH])
    expect(harness.fileSystem.removed).toContain(PART_PATH)
    expect(harness.fileSystem.files.has(PART_PATH)).toBe(false)
    expect(harness.fileSystem.renamed).toEqual([])
  })

  it('deletes the partial file when writing to disk fails', async () => {
    const fileSystem = new FakeFileSystem()
    fileSystem.failures.write = new Error('ENOSPC: no space left on device')
    const harness = buildHarness({ fileSystem })

    await expect(harness.service.download()).resolves.toMatchObject({ status: 'error' })
    expect(harness.fileSystem.files.has(PART_PATH)).toBe(false)
  })

  it('reports a short transfer instead of renaming an incomplete installer into place', async () => {
    // Content-Length promises 900 bytes but the body only delivers 400.
    const harness = buildHarness({ chunks: [chunk(400)], contentLength: '900' })

    await expect(harness.service.download()).resolves.toEqual({
      status: 'error',
      message: 'The downloaded installer is incomplete: expected 900 bytes but got 400.'
    })
    expect(harness.fileSystem.renamed).toEqual([])
    expect(harness.fileSystem.files.has(PART_PATH)).toBe(false)
  })

  it('reports a filesystem that will not accept the download folder', async () => {
    const fileSystem = new FakeFileSystem()
    fileSystem.failures.ensureDirectory = new Error('EACCES: permission denied')
    const harness = buildHarness({ fileSystem })

    await expect(harness.service.download()).resolves.toEqual({
      status: 'error',
      message: 'Could not create the download folder: EACCES: permission denied'
    })
  })

  it('reports a rename failure and cleans up after itself', async () => {
    const fileSystem = new FakeFileSystem()
    fileSystem.failures.rename = new Error('EPERM: operation not permitted')
    const harness = buildHarness({ fileSystem })

    await expect(harness.service.download()).resolves.toEqual({
      status: 'error',
      message: 'Could not save the installer: EPERM: operation not permitted'
    })
    expect(harness.fileSystem.files.has(PART_PATH)).toBe(false)
  })
})

describe('UpdaterService.download: concurrency', () => {
  it('hands a second caller the download already in flight instead of starting another', async () => {
    const harness = buildHarness()

    const first = harness.service.download()
    const second = harness.service.download()

    expect(second).toBe(first)
    await expect(first).resolves.toMatchObject({ status: 'ready' })
    expect(harness.requests).toHaveLength(2)
  })

  it('starts a fresh download once the previous one has settled', async () => {
    const harness = buildHarness()

    await harness.service.download()
    await harness.service.download()

    expect(harness.requests).toHaveLength(3)
    // The second run found the finished installer on disk and skipped the transfer.
    expect(harness.requests.at(-1)!.url).toBe(RELEASE_URL)
  })
})

describe('UpdaterService.cancel', () => {
  it('aborts the transfer, deletes the partial file, and resolves the download as cancelled', async () => {
    const reachedSecondChunk = deferred()
    const releaseSecondChunk = deferred()
    const harness = buildHarness({
      chunks: [chunk(300), chunk(300), chunk(300)],
      beforeChunk: async (index) => {
        if (index !== 1) return
        reachedSecondChunk.resolve()
        await releaseSecondChunk.promise
      }
    })

    const download = harness.service.download()
    await reachedSecondChunk.promise
    const cancelled = harness.service.cancel()
    releaseSecondChunk.resolve()

    await expect(download).resolves.toEqual({ status: 'cancelled' })
    await cancelled
    expect(harness.requests[1]!.signal!.aborted).toBe(true)
    expect(harness.fileSystem.removed).toContain(PART_PATH)
    expect(harness.fileSystem.files.has(PART_PATH)).toBe(false)
    expect(harness.fileSystem.files.has(INSTALLER_PATH)).toBe(false)
    expect(harness.fileSystem.renamed).toEqual([])
  })

  it('reports cancelled rather than an error when the aborted body throws', async () => {
    const reached = deferred()
    const release = deferred()
    const harness = buildHarness({
      assetBody: {
        async *[Symbol.asyncIterator]() {
          yield chunk(300)
          reached.resolve()
          await release.promise
          throw named('AbortError', 'This operation was aborted')
        }
      }
    })

    const download = harness.service.download()
    await reached.promise
    const cancelled = harness.service.cancel()
    release.resolve()

    await expect(download).resolves.toEqual({ status: 'cancelled' })
    await cancelled
    expect(harness.fileSystem.files.has(PART_PATH)).toBe(false)
  })

  it('is a harmless no-op when no download is running', async () => {
    const harness = buildHarness()

    await expect(harness.service.cancel()).resolves.toBeUndefined()
    expect(harness.requests).toEqual([])
  })

  it('leaves nothing installable behind', async () => {
    const reached = deferred()
    const release = deferred()
    const harness = buildHarness({
      chunks: [chunk(300), chunk(300), chunk(300)],
      beforeChunk: async (index) => {
        if (index !== 1) return
        reached.resolve()
        await release.promise
      }
    })

    const download = harness.service.download()
    await reached.promise
    const cancelled = harness.service.cancel()
    release.resolve()
    await download
    await cancelled

    await expect(harness.service.install()).resolves.toEqual({
      status: 'error',
      message: 'No installer has been downloaded yet. Download the update first.'
    })
    expect(harness.spawns).toEqual([])
    expect(harness.calls.quits).toBe(0)
  })
})

describe('UpdaterService.install', () => {
  it('launches the downloaded installer detached and quits so it can replace the running files', async () => {
    const harness = buildHarness()
    await harness.service.download()

    await expect(harness.service.install()).resolves.toEqual({ status: 'launched' })

    expect(harness.spawns).toEqual([{ file: INSTALLER_PATH, args: [], options: { detached: true, stdio: 'ignore' } }])
    expect(harness.calls.unrefs).toBe(1)
    expect(harness.calls.quits).toBe(1)
  })

  it('refuses to install when nothing has been downloaded, without spawning or quitting', async () => {
    const harness = buildHarness()

    await expect(harness.service.install()).resolves.toEqual({
      status: 'error',
      message: 'No installer has been downloaded yet. Download the update first.'
    })
    expect(harness.spawns).toEqual([])
    expect(harness.calls.quits).toBe(0)
  })

  it('reports an installer that disappeared from disk after the download', async () => {
    const harness = buildHarness()
    await harness.service.download()
    harness.fileSystem.files.delete(INSTALLER_PATH)

    await expect(harness.service.install()).resolves.toEqual({
      status: 'error',
      message: 'The downloaded installer is no longer on disk. Download the update again.'
    })
    expect(harness.spawns).toEqual([])
    expect(harness.calls.quits).toBe(0)
  })

  it('keeps CodeFly running when the installer cannot be started', async () => {
    const harness = buildHarness({ spawnFails: new Error('EACCES: permission denied') })
    await harness.service.download()

    await expect(harness.service.install()).resolves.toEqual({
      status: 'error',
      message: 'Could not start the installer: EACCES: permission denied'
    })
    expect(harness.calls.quits).toBe(0)
  })

  it('installs an installer that was already on disk when the download ran', async () => {
    const harness = buildHarness({ existingFiles: { [INSTALLER_PATH]: 900 } })
    await harness.service.download()

    await expect(harness.service.install()).resolves.toEqual({ status: 'launched' })
    expect(harness.spawns[0]!.file).toBe(INSTALLER_PATH)
  })
})
