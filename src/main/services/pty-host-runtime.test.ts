import { posix, win32 } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  PtyHostRuntime,
  PtyHostStagingError,
  type PtyHostDirectoryEntry,
  type PtyHostRuntimeFileSystem,
  type PtyHostRuntimeOptions
} from './pty-host-runtime'

const INSTALL_DIRECTORY = 'C:\\Program Files\\CodeFly'
const EXEC_PATH = win32.join(INSTALL_DIRECTORY, 'CodeFly.exe')
const RESOURCES = win32.join(INSTALL_DIRECTORY, 'resources')
const APP_PATH = win32.join(RESOURCES, 'app.asar')
const UNPACKED_PATH = win32.join(RESOURCES, 'app.asar.unpacked')
const USER_DATA = 'C:\\Users\\tester\\AppData\\Roaming\\CodeFly'
const APP_VERSION = '0.16.0'
const STAGING_ROOT = win32.join(USER_DATA, 'pty-host')
const VERSION_DIRECTORY = win32.join(STAGING_ROOT, APP_VERSION)
const STAGING_ID = 'ffff0000'
const STAGING_DIRECTORY = win32.join(STAGING_ROOT, `${APP_VERSION}.staging-${STAGING_ID}`)

const EXE_BYTES = 244_000_000
const ICU_BYTES = 10_000_000
const SNAPSHOT_BYTES = 700_000
const SCRIPT_BYTES = 4_096
const CHUNK_BYTES = [2_048, 1_024] as const

const CHUNK_NAMES = ['pty-protocol-A1b2C3d4.mjs', 'agent-kinds-Z9y8X7w6.mjs'] as const

/** Relative to the source tree's node-pty root; the nesting is what proves the walk recurses. */
const NODE_PTY_FILES = [
  'package.json',
  win32.join('lib', 'index.js'),
  win32.join('prebuilds', 'win32-x64', 'pty.node'),
  win32.join('prebuilds', 'win32-x64', 'conpty.dll'),
  win32.join('third_party', 'conpty', '1.0', 'conpty.dll')
] as const

const nodePtyBytes = (index: number): number => 1_000 + index

/**
 * Exactly what a staged runtime must contain — paths relative to the version directory, with
 * the size each one has to end up at. Both the install fixture and the "already staged"
 * fixture are derived from this, so a staged copy can never drift from what is expected.
 */
const STAGED_SIZES: ReadonlyMap<string, number> = new Map<string, number>([
  ['codefly-pty-host.exe', EXE_BYTES],
  ['icudtl.dat', ICU_BYTES],
  ['v8_context_snapshot.bin', SNAPSHOT_BYTES],
  ['pty-host.mjs', SCRIPT_BYTES],
  ...CHUNK_NAMES.map((name, index): [string, number] => [win32.join('chunks', name), CHUNK_BYTES[index] ?? 0]),
  ...NODE_PTY_FILES.map((name, index): [string, number] => [
    win32.join('node_modules', 'node-pty', name),
    nodePtyBytes(index)
  ])
])

const EXPECTED_STAGED_FILES = [...STAGED_SIZES.keys()].sort()

const named = (code: string, message: string): Error => {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

/**
 * In-memory stand-in for the runtime's filesystem surface, so a test can stage a 256 MB
 * runtime without moving a byte. Files are tracked as sizes only, which is all the service
 * ever reads back — it compares sizes to decide whether a staged copy is complete and never
 * looks at contents.
 *
 * Paths are treated as Windows paths: every test that touches the filesystem is a packaged
 * Windows test, because that is the only configuration that stages anything at all.
 */
class FakeFileSystem implements PtyHostRuntimeFileSystem {
  readonly files = new Map<string, number>()
  readonly directories = new Set<string>()
  readonly linked: Array<{ from: string; to: string }> = []
  readonly copied: Array<{ from: string; to: string }> = []
  readonly written: string[] = []
  readonly renamed: Array<{ from: string; to: string }> = []
  readonly removed: string[] = []
  readonly readDirectoryFailures = new Map<string, Error>()
  readonly removeFailures = new Map<string, Error>()
  linkFailure: Error | undefined
  renameFailure: Error | undefined
  fileSizeFailure: Error | undefined
  /** Called with the destination before every link/copy/write; throw to fail mid-staging. */
  beforeWrite: ((target: string) => void) | undefined

  addFile(filePath: string, bytes: number): void {
    this.files.set(filePath, bytes)
    this.addDirectory(win32.dirname(filePath))
  }

  addDirectory(directory: string): void {
    let current = directory
    for (;;) {
      this.directories.add(current)
      const parent = win32.dirname(current)
      if (parent === current) return
      current = parent
    }
  }

  /** File paths under `directory`, relative to it and sorted: the shape of a staged tree. */
  contentsOf(directory: string): string[] {
    const prefix = `${directory}${win32.sep}`
    return [...this.files.keys()]
      .filter((filePath) => filePath.startsWith(prefix))
      .map((filePath) => filePath.slice(prefix.length))
      .sort()
  }

  exists(path: string): boolean {
    if (this.files.has(path) || this.directories.has(path)) return true
    const prefix = `${path}${win32.sep}`
    return [...this.files.keys()].some((filePath) => filePath.startsWith(prefix))
  }

  async ensureDirectory(directory: string): Promise<void> {
    this.beforeWrite?.(directory)
    this.addDirectory(directory)
  }

  async readDirectory(directory: string): Promise<readonly PtyHostDirectoryEntry[]> {
    const failure = this.readDirectoryFailures.get(directory)
    if (failure) throw failure
    if (!this.exists(directory)) throw named('ENOENT', `ENOENT: no such directory, scandir '${directory}'`)

    const prefix = `${directory}${win32.sep}`
    const entries = new Map<string, boolean>()
    const record = (path: string, leafIsDirectory: boolean): void => {
      if (!path.startsWith(prefix)) return
      const rest = path.slice(prefix.length)
      if (rest.length === 0) return
      const cut = rest.indexOf(win32.sep)
      if (cut === -1) {
        if (leafIsDirectory) entries.set(rest, true)
        else entries.set(rest, false)
        return
      }
      const name = rest.slice(0, cut)
      if (!entries.has(name)) entries.set(name, true)
    }
    for (const filePath of this.files.keys()) record(filePath, false)
    for (const directoryPath of this.directories) record(directoryPath, true)
    return [...entries].map(([name, isDirectory]) => ({ name, isDirectory }))
  }

  async fileSize(filePath: string): Promise<number | undefined> {
    // The contract says this never rejects; a test breaks it on purpose to prove the service
    // guards it rather than letting the rejection escape.
    if (this.fileSizeFailure) throw this.fileSizeFailure
    return this.files.get(filePath)
  }

  async link(from: string, to: string): Promise<void> {
    if (this.linkFailure) throw this.linkFailure
    this.beforeWrite?.(to)
    const bytes = this.files.get(from)
    if (bytes === undefined) throw named('ENOENT', `ENOENT: no such file, link '${from}'`)
    this.addFile(to, bytes)
    this.linked.push({ from, to })
  }

  async copyFile(from: string, to: string): Promise<void> {
    this.beforeWrite?.(to)
    const bytes = this.files.get(from)
    if (bytes === undefined) throw named('ENOENT', `ENOENT: no such file, copyfile '${from}'`)
    this.addFile(to, bytes)
    this.copied.push({ from, to })
  }

  async readFile(filePath: string): Promise<Uint8Array> {
    const bytes = this.files.get(filePath)
    if (bytes === undefined) throw named('ENOENT', `ENOENT: no such file, open '${filePath}'`)
    return new Uint8Array(bytes)
  }

  async writeFile(filePath: string, data: Uint8Array): Promise<void> {
    this.beforeWrite?.(filePath)
    this.addFile(filePath, data.byteLength)
    this.written.push(filePath)
  }

  async rename(from: string, to: string): Promise<void> {
    if (this.renameFailure) throw this.renameFailure
    // Windows refuses to rename onto an existing directory, which is how a concurrent staging
    // or an interrupted promote is discovered.
    if (this.exists(to)) throw named('EPERM', `EPERM: operation not permitted, rename '${from}' -> '${to}'`)

    const prefix = `${from}${win32.sep}`
    for (const [filePath, bytes] of [...this.files]) {
      if (!filePath.startsWith(prefix)) continue
      this.files.delete(filePath)
      this.addFile(win32.join(to, filePath.slice(prefix.length)), bytes)
    }
    for (const directory of [...this.directories]) {
      if (directory !== from && !directory.startsWith(prefix)) continue
      this.directories.delete(directory)
      this.addDirectory(directory === from ? to : win32.join(to, directory.slice(prefix.length)))
    }
    this.renamed.push({ from, to })
  }

  async removeDirectory(directory: string): Promise<void> {
    const failure = this.removeFailures.get(directory)
    if (failure) throw failure
    this.removed.push(directory)
    const prefix = `${directory}${win32.sep}`
    for (const filePath of [...this.files.keys()]) {
      if (filePath === directory || filePath.startsWith(prefix)) this.files.delete(filePath)
    }
    for (const existing of [...this.directories]) {
      if (existing === directory || existing.startsWith(prefix)) this.directories.delete(existing)
    }
  }
}

/** Seeds a packaged Windows install: the runtime files, the asar entries, and decoys that
 * must not be staged. */
const seedInstall = (fileSystem: FakeFileSystem, appPath = APP_PATH, unpackedPath = UNPACKED_PATH): void => {
  fileSystem.addFile(EXEC_PATH, EXE_BYTES)
  fileSystem.addFile(win32.join(INSTALL_DIRECTORY, 'icudtl.dat'), ICU_BYTES)
  fileSystem.addFile(win32.join(INSTALL_DIRECTORY, 'v8_context_snapshot.bin'), SNAPSHOT_BYTES)
  // Deliberately present and deliberately not staged: the measured minimum runtime is the
  // executable plus the two files above.
  fileSystem.addFile(win32.join(INSTALL_DIRECTORY, 'resources.pak'), 5_000_000)
  fileSystem.addFile(win32.join(INSTALL_DIRECTORY, 'ffmpeg.dll'), 2_000_000)
  fileSystem.addFile(win32.join(INSTALL_DIRECTORY, 'locales', 'en-US.pak'), 400_000)

  fileSystem.addFile(win32.join(appPath, 'out', 'main', 'pty-host.mjs'), SCRIPT_BYTES)
  // The main entry belongs to the UI process and has no business in the host's directory.
  fileSystem.addFile(win32.join(appPath, 'out', 'main', 'index.js'), 320_000)
  for (const [index, name] of CHUNK_NAMES.entries()) {
    fileSystem.addFile(win32.join(appPath, 'out', 'main', 'chunks', name), CHUNK_BYTES[index] ?? 0)
  }
  // A non-.mjs neighbour (a sourcemap, say) is not part of the module graph.
  fileSystem.addFile(win32.join(appPath, 'out', 'main', 'chunks', `${CHUNK_NAMES[0]}.map`), 8_192)

  for (const [index, name] of NODE_PTY_FILES.entries()) {
    fileSystem.addFile(win32.join(unpackedPath, 'node_modules', 'node-pty', name), nodePtyBytes(index))
  }
  // Another unpacked dependency: only node-pty is the host's business.
  fileSystem.addFile(win32.join(unpackedPath, 'node_modules', 'other-native', 'index.node'), 900_000)
}

/** Drops a complete, correctly sized runtime into `directory`: what a concurrent instance (or
 * a previous run of this one) would have left behind. */
const seedStagedRuntime = (fileSystem: FakeFileSystem, directory: string): void => {
  for (const [target, bytes] of STAGED_SIZES) fileSystem.addFile(win32.join(directory, target), bytes)
}

type Harness = {
  fileSystem: FakeFileSystem
  logs: string[]
  runtime: PtyHostRuntime
  /** A second service over the same disk: proves idempotency without the in-memory cache. */
  restart(): PtyHostRuntime
}

const buildWindowsHarness = (overrides: Partial<PtyHostRuntimeOptions> = {}): Harness => {
  const fileSystem = (overrides.fileSystem as FakeFileSystem | undefined) ?? new FakeFileSystem()
  if (!overrides.fileSystem) seedInstall(fileSystem)
  const logs: string[] = []
  const options: PtyHostRuntimeOptions = {
    platform: 'win32',
    isPackaged: true,
    execPath: EXEC_PATH,
    appPath: APP_PATH,
    userDataPath: USER_DATA,
    appVersion: APP_VERSION,
    fileSystem,
    newStagingId: () => STAGING_ID,
    log: (message) => logs.push(message),
    ...overrides
  }
  return {
    fileSystem,
    logs,
    runtime: new PtyHostRuntime(options),
    restart: () => new PtyHostRuntime(options)
  }
}

describe('PtyHostRuntime', () => {
  describe('platforms that need no staging', () => {
    it('runs the script inside the app bundle on macOS', async () => {
      const fileSystem = new FakeFileSystem()
      const appPath = '/Applications/CodeFly.app/Contents/Resources/app.asar'
      const execPath = '/Applications/CodeFly.app/Contents/MacOS/CodeFly'
      const runtime = new PtyHostRuntime({
        platform: 'darwin',
        isPackaged: true,
        execPath,
        appPath,
        userDataPath: '/Users/tester/Library/Application Support/CodeFly',
        appVersion: APP_VERSION,
        fileSystem
      })

      expect(await runtime.resolve()).toEqual({
        runtime: execPath,
        script: posix.join(appPath, 'out', 'main', 'pty-host.mjs')
      })
      // Nothing was copied, nothing was created: replacing a .app bundle cannot disturb a
      // process that already mapped the old one.
      expect(fileSystem.files.size).toBe(0)
      expect(fileSystem.directories.size).toBe(0)
    })

    it('runs the repository build in an unpackaged Windows checkout', async () => {
      const fileSystem = new FakeFileSystem()
      const { runtime } = buildWindowsHarness({
        isPackaged: false,
        execPath: 'E:\\repo\\node_modules\\electron\\dist\\electron.exe',
        appPath: 'E:\\repo',
        fileSystem
      })

      expect(await runtime.resolve()).toEqual({
        runtime: 'E:\\repo\\node_modules\\electron\\dist\\electron.exe',
        script: 'E:\\repo\\out\\main\\pty-host.mjs'
      })
      expect(fileSystem.linked).toHaveLength(0)
      expect(fileSystem.copied).toHaveLength(0)
      expect(fileSystem.written).toHaveLength(0)
    })
  })

  describe('packaged Windows staging', () => {
    it('stages the runtime outside the install directory under the app version', async () => {
      const { runtime, fileSystem } = buildWindowsHarness()

      const target = await runtime.resolve()

      expect(target).toEqual({
        runtime: win32.join(VERSION_DIRECTORY, 'codefly-pty-host.exe'),
        script: win32.join(VERSION_DIRECTORY, 'pty-host.mjs')
      })
      expect(fileSystem.contentsOf(VERSION_DIRECTORY)).toEqual(EXPECTED_STAGED_FILES)
      // The image name must not be CodeFly.exe: the NSIS installer's fallback branch kills by
      // image name, wherever the process lives.
      expect(fileSystem.files.get(win32.join(VERSION_DIRECTORY, 'codefly-pty-host.exe'))).toBe(EXE_BYTES)
      expect(fileSystem.exists(win32.join(VERSION_DIRECTORY, 'CodeFly.exe'))).toBe(false)
      // Nothing in the staged path may start with the install directory as a string.
      expect(target.runtime.startsWith(INSTALL_DIRECTORY)).toBe(false)
    })

    it('enumerates the hashed chunk file names instead of assuming them', async () => {
      const { fileSystem } = buildWindowsHarness()
      fileSystem.addFile(win32.join(APP_PATH, 'out', 'main', 'chunks', 'later-added-DEADBEEF.mjs'), 512)
      const { runtime } = buildWindowsHarness({ fileSystem })

      await runtime.resolve()

      expect(fileSystem.contentsOf(win32.join(VERSION_DIRECTORY, 'chunks')).sort()).toEqual(
        [...CHUNK_NAMES, 'later-added-DEADBEEF.mjs'].sort()
      )
    })

    it('copies node-pty whole so its loader still finds prebuilds by relative path', async () => {
      const { runtime, fileSystem } = buildWindowsHarness()

      await runtime.resolve()

      const nodePty = win32.join(VERSION_DIRECTORY, 'node_modules', 'node-pty')
      expect(fileSystem.contentsOf(nodePty)).toEqual([...NODE_PTY_FILES].sort())
      expect(fileSystem.exists(win32.join(VERSION_DIRECTORY, 'node_modules', 'other-native'))).toBe(false)
    })

    it('reads node-pty from the app directory for an unpacked build', async () => {
      const fileSystem = new FakeFileSystem()
      const appDirectory = win32.join(RESOURCES, 'app')
      seedInstall(fileSystem, appDirectory, appDirectory)
      const { runtime } = buildWindowsHarness({ fileSystem, appPath: appDirectory })

      await runtime.resolve()

      expect(fileSystem.contentsOf(win32.join(VERSION_DIRECTORY, 'node_modules', 'node-pty'))).toEqual(
        [...NODE_PTY_FILES].sort()
      )
    })

    it('hard links files that exist on disk and rewrites the ones inside app.asar', async () => {
      const { runtime, fileSystem } = buildWindowsHarness()

      await runtime.resolve()

      // The 244 MB executable and every real file arrive as a second directory entry: no bytes
      // move, and the staged name survives the installer renaming the one in the install dir.
      expect(fileSystem.linked.map((entry) => entry.to)).toEqual([
        win32.join(STAGING_DIRECTORY, 'codefly-pty-host.exe'),
        win32.join(STAGING_DIRECTORY, 'icudtl.dat'),
        win32.join(STAGING_DIRECTORY, 'v8_context_snapshot.bin'),
        ...NODE_PTY_FILES.map((name) => win32.join(STAGING_DIRECTORY, 'node_modules', 'node-pty', name))
      ])
      expect(fileSystem.copied).toHaveLength(0)
      // asar entries have no inode to link and are rewritten byte for byte instead.
      expect(fileSystem.written).toEqual([
        win32.join(STAGING_DIRECTORY, 'pty-host.mjs'),
        ...CHUNK_NAMES.map((name) => win32.join(STAGING_DIRECTORY, 'chunks', name))
      ])
    })

    it('falls back to copying when hard links are refused across volumes', async () => {
      const { runtime, fileSystem } = buildWindowsHarness()
      fileSystem.linkFailure = named('EXDEV', "EXDEV: cross-device link not permitted, link 'CodeFly.exe'")

      const target = await runtime.resolve()

      expect(target.runtime).toBe(win32.join(VERSION_DIRECTORY, 'codefly-pty-host.exe'))
      expect(fileSystem.linked).toHaveLength(0)
      expect(fileSystem.copied.map((entry) => entry.to)).toEqual([
        win32.join(STAGING_DIRECTORY, 'codefly-pty-host.exe'),
        win32.join(STAGING_DIRECTORY, 'icudtl.dat'),
        win32.join(STAGING_DIRECTORY, 'v8_context_snapshot.bin'),
        ...NODE_PTY_FILES.map((name) => win32.join(STAGING_DIRECTORY, 'node_modules', 'node-pty', name))
      ])
      expect(fileSystem.contentsOf(VERSION_DIRECTORY)).toEqual(EXPECTED_STAGED_FILES)
    })
  })

  describe('idempotency', () => {
    it('does not touch a complete staging directory again', async () => {
      const harness = buildWindowsHarness()
      await harness.runtime.resolve()
      const { fileSystem } = harness
      const linkCount = fileSystem.linked.length
      const writeCount = fileSystem.written.length
      const renameCount = fileSystem.renamed.length

      // A fresh service over the same disk: the app restarting, not a cached answer.
      const target = await harness.restart().resolve()

      expect(target).toEqual({
        runtime: win32.join(VERSION_DIRECTORY, 'codefly-pty-host.exe'),
        script: win32.join(VERSION_DIRECTORY, 'pty-host.mjs')
      })
      expect(fileSystem.linked).toHaveLength(linkCount)
      expect(fileSystem.copied).toHaveLength(0)
      expect(fileSystem.written).toHaveLength(writeCount)
      expect(fileSystem.renamed).toHaveLength(renameCount)
    })

    it('re-stages when a staged file is the wrong size', async () => {
      const harness = buildWindowsHarness()
      await harness.runtime.resolve()
      // A truncated executable is the exact failure the size check exists to catch.
      harness.fileSystem.files.set(win32.join(VERSION_DIRECTORY, 'codefly-pty-host.exe'), 1_024)

      await harness.restart().resolve()

      expect(harness.fileSystem.files.get(win32.join(VERSION_DIRECTORY, 'codefly-pty-host.exe'))).toBe(EXE_BYTES)
      expect(harness.fileSystem.contentsOf(VERSION_DIRECTORY)).toEqual(EXPECTED_STAGED_FILES)
    })

    it('answers a second call in the same run without walking the tree again', async () => {
      const { runtime, fileSystem } = buildWindowsHarness()
      const first = await runtime.resolve()
      const sizeReads = fileSystem.linked.length

      const second = await runtime.resolve()

      expect(second).toEqual(first)
      expect(fileSystem.linked).toHaveLength(sizeReads)
    })

    it('joins a staging already in flight instead of copying twice', async () => {
      const { runtime, fileSystem } = buildWindowsHarness()

      const [first, second] = await Promise.all([runtime.resolve(), runtime.resolve()])

      expect(second).toEqual(first)
      expect(fileSystem.linked.map((entry) => entry.to)).toHaveLength(3 + NODE_PTY_FILES.length)
      expect(fileSystem.renamed).toHaveLength(1)
    })
  })

  describe('atomicity', () => {
    it('leaves no directory that could be mistaken for a ready runtime when a copy fails', async () => {
      const { runtime, fileSystem } = buildWindowsHarness()
      const failure = named('ENOSPC', 'ENOSPC: no space left on device')
      fileSystem.beforeWrite = (target) => {
        if (target.endsWith('v8_context_snapshot.bin')) throw failure
      }

      await expect(runtime.resolve()).rejects.toBeInstanceOf(PtyHostStagingError)

      // The version name is never created, so nothing half-copied can be spawned; the
      // temporary directory is swept away with it.
      expect(fileSystem.exists(VERSION_DIRECTORY)).toBe(false)
      expect(fileSystem.exists(STAGING_DIRECTORY)).toBe(false)
      expect(fileSystem.removed).toContain(STAGING_DIRECTORY)
      expect(fileSystem.renamed).toHaveLength(0)
    })

    it('stages successfully on the next attempt after a failure', async () => {
      const harness = buildWindowsHarness()
      harness.fileSystem.beforeWrite = (target) => {
        if (target.endsWith('pty-host.mjs')) throw named('EPERM', 'EPERM: operation not permitted')
      }
      await expect(harness.runtime.resolve()).rejects.toBeInstanceOf(PtyHostStagingError)
      harness.fileSystem.beforeWrite = undefined

      await harness.restart().resolve()

      expect(harness.fileSystem.contentsOf(VERSION_DIRECTORY)).toEqual(EXPECTED_STAGED_FILES)
    })

    it('deletes staging directories a crash left behind', async () => {
      const fileSystem = new FakeFileSystem()
      seedInstall(fileSystem)
      const abandoned = win32.join(STAGING_ROOT, `${APP_VERSION}.staging-oldrun`)
      const abandonedOther = win32.join(STAGING_ROOT, '0.15.0.staging-evenolder')
      fileSystem.addFile(win32.join(abandoned, 'codefly-pty-host.exe'), 12_000)
      fileSystem.addFile(win32.join(abandonedOther, 'icudtl.dat'), 900)
      const { runtime, logs } = buildWindowsHarness({ fileSystem })

      await runtime.resolve()

      expect(fileSystem.exists(abandoned)).toBe(false)
      expect(fileSystem.exists(abandonedOther)).toBe(false)
      expect(fileSystem.contentsOf(VERSION_DIRECTORY)).toEqual(EXPECTED_STAGED_FILES)
      expect(logs.some((message) => message.includes('interrupted staging directory'))).toBe(true)
    })

    it('adopts a complete version directory left by another instance', async () => {
      const { runtime, fileSystem, logs } = buildWindowsHarness()
      seedStagedRuntime(fileSystem, VERSION_DIRECTORY)

      const target = await runtime.resolve()

      expect(target.runtime).toBe(win32.join(VERSION_DIRECTORY, 'codefly-pty-host.exe'))
      // Recognised as complete before any copying starts.
      expect(fileSystem.linked).toHaveLength(0)
      expect(fileSystem.written).toHaveLength(0)
      expect(logs).toHaveLength(0)
    })

    it('throws its own copy away when the version directory appears mid-flight', async () => {
      const { runtime, fileSystem, logs } = buildWindowsHarness()
      // Another instance finishes staging the same version while this copy is still running,
      // so the rename lands on a directory that is already complete.
      fileSystem.beforeWrite = (target) => {
        if (target.endsWith('pty-host.mjs')) seedStagedRuntime(fileSystem, VERSION_DIRECTORY)
      }

      const target = await runtime.resolve()

      expect(target.runtime).toBe(win32.join(VERSION_DIRECTORY, 'codefly-pty-host.exe'))
      expect(fileSystem.renamed).toHaveLength(0)
      expect(fileSystem.removed).toContain(STAGING_DIRECTORY)
      expect(fileSystem.contentsOf(VERSION_DIRECTORY)).toEqual(EXPECTED_STAGED_FILES)
      expect(logs.some((message) => message.includes('another instance staged'))).toBe(true)
    })

    it('replaces an incomplete version directory rather than trusting it', async () => {
      const { runtime, fileSystem } = buildWindowsHarness()
      // Only half the runtime is there: an interrupted promote from an older build.
      fileSystem.addFile(win32.join(VERSION_DIRECTORY, 'codefly-pty-host.exe'), EXE_BYTES)
      fileSystem.addFile(win32.join(VERSION_DIRECTORY, 'pty-host.mjs'), 4_096)

      await runtime.resolve()

      expect(fileSystem.removed).toContain(VERSION_DIRECTORY)
      expect(fileSystem.contentsOf(VERSION_DIRECTORY)).toEqual(EXPECTED_STAGED_FILES)
    })
  })

  describe('superseded versions', () => {
    it('deletes the version directories it can', async () => {
      const fileSystem = new FakeFileSystem()
      seedInstall(fileSystem)
      const older = win32.join(STAGING_ROOT, '0.15.0')
      fileSystem.addFile(win32.join(older, 'codefly-pty-host.exe'), EXE_BYTES)
      const { runtime, logs } = buildWindowsHarness({ fileSystem })

      await runtime.resolve()

      expect(fileSystem.exists(older)).toBe(false)
      expect(fileSystem.contentsOf(VERSION_DIRECTORY)).toEqual(EXPECTED_STAGED_FILES)
      expect(logs.some((message) => message.includes('removed the superseded host runtime 0.15.0'))).toBe(true)
    })

    it('keeps going when the previous host still holds its own executable', async () => {
      const fileSystem = new FakeFileSystem()
      seedInstall(fileSystem)
      const older = win32.join(STAGING_ROOT, '0.15.0')
      fileSystem.addFile(win32.join(older, 'codefly-pty-host.exe'), EXE_BYTES)
      // The whole point of the design: that host is still running the user's agents.
      fileSystem.removeFailures.set(older, named('EBUSY', 'EBUSY: resource busy or locked'))
      const { runtime, logs } = buildWindowsHarness({ fileSystem })

      const target = await runtime.resolve()

      expect(target.runtime).toBe(win32.join(VERSION_DIRECTORY, 'codefly-pty-host.exe'))
      expect(fileSystem.exists(older)).toBe(true)
      expect(logs.some((message) => message.includes('kept the superseded host runtime 0.15.0'))).toBe(true)
    })

    it('sweeps on a run that had nothing to stage', async () => {
      const harness = buildWindowsHarness()
      await harness.runtime.resolve()
      const older = win32.join(STAGING_ROOT, '0.15.0')
      harness.fileSystem.addFile(win32.join(older, 'codefly-pty-host.exe'), EXE_BYTES)

      await harness.restart().resolve()

      expect(harness.fileSystem.exists(older)).toBe(false)
    })
  })

  describe('failures', () => {
    it('reports a missing runtime file instead of staging a broken host', async () => {
      const fileSystem = new FakeFileSystem()
      seedInstall(fileSystem)
      fileSystem.files.delete(win32.join(INSTALL_DIRECTORY, 'icudtl.dat'))
      const { runtime } = buildWindowsHarness({ fileSystem })

      await expect(runtime.resolve()).rejects.toThrow(/missing runtime file .*icudtl\.dat/)
      expect(fileSystem.exists(VERSION_DIRECTORY)).toBe(false)
    })

    it('reports an unreadable node-pty', async () => {
      const fileSystem = new FakeFileSystem()
      seedInstall(fileSystem)
      const source = win32.join(UNPACKED_PATH, 'node_modules', 'node-pty')
      fileSystem.readDirectoryFailures.set(source, named('EACCES', 'EACCES: permission denied'))
      const { runtime } = buildWindowsHarness({ fileSystem })

      await expect(runtime.resolve()).rejects.toThrow(/could not read node-pty/)
    })

    it('stages without chunks when the build emitted none', async () => {
      const fileSystem = new FakeFileSystem()
      seedInstall(fileSystem)
      for (const name of [...CHUNK_NAMES, 'pty-protocol-A1b2C3d4.mjs.map']) {
        fileSystem.files.delete(win32.join(APP_PATH, 'out', 'main', 'chunks', name))
      }
      fileSystem.directories.delete(win32.join(APP_PATH, 'out', 'main', 'chunks'))
      const { runtime, logs } = buildWindowsHarness({ fileSystem })

      const target = await runtime.resolve()

      expect(target.script).toBe(win32.join(VERSION_DIRECTORY, 'pty-host.mjs'))
      expect(fileSystem.exists(win32.join(VERSION_DIRECTORY, 'chunks'))).toBe(false)
      expect(logs.some((message) => message.includes('no shared chunks staged'))).toBe(true)
    })

    it('reports a staging root it cannot create', async () => {
      const { runtime, fileSystem } = buildWindowsHarness()
      fileSystem.beforeWrite = (target) => {
        if (target === STAGING_ROOT) throw named('EACCES', 'EACCES: permission denied, mkdir')
      }

      await expect(runtime.resolve()).rejects.toBeInstanceOf(PtyHostStagingError)
      expect(fileSystem.exists(VERSION_DIRECTORY)).toBe(false)
    })

    it('reports a promote it cannot complete', async () => {
      const { runtime, fileSystem } = buildWindowsHarness()
      fileSystem.renameFailure = named('EPERM', 'EPERM: operation not permitted, rename')
      fileSystem.removeFailures.set(VERSION_DIRECTORY, named('EBUSY', 'EBUSY: resource busy or locked'))

      await expect(runtime.resolve()).rejects.toThrow(/could not replace/)
      expect(fileSystem.exists(VERSION_DIRECTORY)).toBe(false)
      expect(fileSystem.exists(STAGING_DIRECTORY)).toBe(false)
    })

    it('reports a rename that keeps failing after the obstacle is cleared', async () => {
      const { runtime, fileSystem } = buildWindowsHarness()
      fileSystem.renameFailure = named('EIO', 'EIO: i/o error, rename')

      await expect(runtime.resolve()).rejects.toThrow(/could not move the staged runtime/)
      expect(fileSystem.exists(STAGING_DIRECTORY)).toBe(false)
    })

    it('turns a filesystem that breaks its own contract into a typed error', async () => {
      const { runtime, fileSystem } = buildWindowsHarness()
      // fileSize is documented as never rejecting; the service must still not leak it.
      fileSystem.fileSizeFailure = named('EIO', 'EIO: i/o error, stat')

      await expect(runtime.resolve()).rejects.toBeInstanceOf(PtyHostStagingError)
    })
  })
})
