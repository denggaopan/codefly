import { randomUUID } from 'node:crypto'
import { copyFile, link, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { posix, win32 as windowsPath } from 'node:path'

/** An executable plus the script to hand it: ready for `child_process.spawn(runtime, [script])`. */
export type PtyHostLaunchTarget = { runtime: string; script: string }

/** Everything the staged host needs lives under `<userData>/pty-host/<appVersion>/`. */
const STAGING_ROOT = 'pty-host'

/**
 * Deliberately NOT `CodeFly.exe`. electron-builder's NSIS installer kills the running app
 * before it writes: its PowerShell branch matches every process whose image path starts with
 * the install directory, and where PowerShell is missing it falls back to matching the image
 * NAME `CodeFly.exe`. The staged copy escapes the first test by living outside the install
 * directory and the second one by being called something else.
 */
const HOST_EXECUTABLE_NAME = 'codefly-pty-host.exe'

const HOST_SCRIPT_NAME = 'pty-host.mjs'
const CHUNKS_DIRECTORY = 'chunks'
const NODE_MODULES_DIRECTORY = 'node_modules'
const NODE_PTY_DIRECTORY = 'node-pty'
const ASAR_DIRECTORY_NAME = 'app.asar'
const SCRIPT_SUFFIX = '.mjs'

/**
 * The whole Windows Node runtime: `electron.exe` (which becomes `<INSTDIR>\CodeFly.exe` in a
 * packaged build, hence `execPath`) plus these two siblings. Measured, not guessed — under
 * `ELECTRON_RUN_AS_NODE=1` those three files alone start Node, `require('node-pty')` and open
 * a ConPTY, with no DLLs, no `locales/` and no `resources.pak`. They also weigh ~256 MB, which
 * is why they are hard-linked rather than copied when the filesystem allows it.
 */
const RUNTIME_SIDE_FILES = ['icudtl.dat', 'v8_context_snapshot.bin'] as const

/**
 * Marks a half-built staging directory. It has to be recognisable from the outside: a crash
 * mid-copy leaves one behind, and the next run has to be able to tell it apart from a finished
 * version directory by name alone.
 */
const STAGING_MARKER = '.staging-'

export type PtyHostDirectoryEntry = { name: string; isDirectory: boolean }

/**
 * Narrow filesystem surface, injected so tests can stage a 256 MB runtime in memory.
 *
 * `fileSize` is interrogative and MUST NOT reject — a missing file and an unreadable one lead
 * to the same decision everywhere it is used — though the service still guards it, because an
 * injected implementation is not this class's to trust. Everything else may reject; the calls
 * that are allowed to fail are wrapped at the call site.
 *
 * `readFile`/`writeFile` exist alongside `copyFile` for one reason: `pty-host.mjs` and its
 * chunks live inside `app.asar`, which is a virtual path. Electron patches `fs.readFile`,
 * `fs.readdir` and `fs.stat` to see into the archive, so those entries can be read — but they
 * have no inode on disk, so they can be neither hard-linked nor (portably) `copyFile`d out.
 */
export type PtyHostRuntimeFileSystem = {
  ensureDirectory(directory: string): Promise<void>
  /** Entries directly inside `directory`; rejects when it cannot be read. */
  readDirectory(directory: string): Promise<readonly PtyHostDirectoryEntry[]>
  /** Byte size of an existing file, or undefined when it is missing, unreadable, or not a file. */
  fileSize(filePath: string): Promise<number | undefined>
  /** Adds a second name for the same data. Rejects across volumes (EXDEV) and on non-NTFS. */
  link(from: string, to: string): Promise<void>
  copyFile(from: string, to: string): Promise<void>
  readFile(filePath: string): Promise<Uint8Array>
  writeFile(filePath: string, data: Uint8Array): Promise<void>
  rename(from: string, to: string): Promise<void>
  /** Recursive delete of a directory that may not exist; rejects so callers can log why. */
  removeDirectory(directory: string): Promise<void>
}

const defaultFileSystem: PtyHostRuntimeFileSystem = {
  ensureDirectory: async (directory) => {
    await mkdir(directory, { recursive: true })
  },
  readDirectory: async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
  },
  fileSize: async (filePath) => {
    try {
      const stats = await stat(filePath)
      return stats.isFile() ? stats.size : undefined
    } catch {
      return undefined
    }
  },
  link: (from, to) => link(from, to),
  copyFile: (from, to) => copyFile(from, to),
  readFile: (filePath) => readFile(filePath),
  writeFile: (filePath, data) => writeFile(filePath, data),
  rename: (from, to) => rename(from, to),
  removeDirectory: async (directory) => {
    await rm(directory, { recursive: true, force: true })
  }
}

export type PtyHostRuntimeLogger = (message: string) => void

const defaultLogger: PtyHostRuntimeLogger = (message) => {
  console.log(`PtyHostRuntime: ${message}`)
}

export type PtyHostRuntimeOptions = {
  platform: NodeJS.Platform
  isPackaged: boolean
  /** `process.execPath`: the packaged `<INSTDIR>\CodeFly.exe`, or Electron's dev binary. */
  execPath: string
  /** `app.getAppPath()`: `<INSTDIR>\resources\app.asar` when packaged, the repo root in dev. */
  appPath: string
  userDataPath: string
  appVersion: string
  fileSystem?: PtyHostRuntimeFileSystem
  /** Injected so a test can pin the staging directory's name. */
  newStagingId?: () => string
  log?: PtyHostRuntimeLogger
}

const describeFailure = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : String(error)

/**
 * Thrown when the host runtime cannot be staged. Typed rather than folded into a result
 * because there is exactly one caller — the composition root — and it has a real decision to
 * make (run without a resident host, and say so) rather than a message to display.
 */
export class PtyHostStagingError extends Error {
  readonly step: string

  constructor(step: string, cause?: unknown) {
    const detail = cause === undefined ? '.' : `: ${describeFailure(cause)}`
    super(`Could not prepare the pty-host runtime (${step})${detail}`)
    this.name = 'PtyHostStagingError'
    this.step = step
    if (cause !== undefined) this.cause = cause
  }
}

/** One planned file. `target` is relative to the staging root so it can be joined onto either
 * the temporary directory being built or the final one being checked. */
type PlannedFile = {
  source: string
  target: string
  bytes: number
  /** `archive` entries live inside app.asar and have to be read and rewritten byte for byte. */
  origin: 'disk' | 'archive'
}

/** Per-run link state: one refusal is enough to stop asking for the rest of the run. */
type LinkState = { supported: boolean }

/**
 * Puts the resident pty-host's runtime somewhere an in-place upgrade cannot reach, and keeps
 * one copy per app version.
 *
 * The problem this solves is entirely Windows-and-packaged. electron-builder's NSIS installer
 * kills every process whose image path *starts with* the install directory (falling back to
 * matching the image name `CodeFly.exe`), and the outgoing version's uninstaller then runs
 * `un.atomicRMDir`, which renames every single file in the install directory and `Abort`s the
 * whole upgrade if even one rename fails. A host running straight out of `<INSTDIR>` would be
 * killed by the first mechanism — losing every agent CLI, which is the one thing this design
 * exists to prevent — and its open files would risk failing the second. So the host's
 * executable, its Node runtime files, its JS and its copy of node-pty all move to
 * `<userData>/pty-host/<version>/`, which neither an upgrade nor an ordinary uninstall touches.
 *
 * There is deliberately no fallback to launching `execPath` in place on packaged Windows: a
 * host inside `<INSTDIR>` is worse than no host at all, because it turns "the agents did not
 * survive the upgrade" into "the upgrade itself hangs or fails". Staging failures are reported
 * to the composition root, which decides how to degrade.
 *
 * macOS and dev builds need none of this and get `execPath` plus the app's own script: see
 * `resolve`.
 */
export class PtyHostRuntime {
  private readonly platform: NodeJS.Platform
  private readonly isPackaged: boolean
  private readonly execPath: string
  private readonly appPath: string
  private readonly userDataPath: string
  private readonly appVersion: string
  private readonly fileSystem: PtyHostRuntimeFileSystem
  private readonly newStagingId: () => string
  private readonly log: PtyHostRuntimeLogger

  /** Cached success. Staging is idempotent, but re-walking node-pty on every host respawn is
   * hundreds of stat calls for an answer that cannot have changed within one app run. */
  private staged: PtyHostLaunchTarget | undefined
  /** In-flight staging, so two callers never copy the same 256 MB at once. */
  private pending: Promise<PtyHostLaunchTarget> | undefined

  constructor(options: PtyHostRuntimeOptions) {
    this.platform = options.platform
    this.isPackaged = options.isPackaged
    this.execPath = options.execPath
    this.appPath = options.appPath
    this.userDataPath = options.userDataPath
    this.appVersion = options.appVersion
    this.fileSystem = options.fileSystem ?? defaultFileSystem
    this.newStagingId = options.newStagingId ?? (() => randomUUID())
    this.log = options.log ?? defaultLogger
  }

  async resolve(): Promise<PtyHostLaunchTarget> {
    if (this.staged) return this.staged
    if (!this.stagingRequired()) return this.inPlaceTarget()

    // Not `async`-and-await inline: a second caller has to join the running staging rather
    // than start a competing copy into a second temporary directory.
    if (!this.pending) {
      this.pending = this.stageRuntime().finally(() => {
        this.pending = undefined
      })
    }
    const target = await this.pending
    this.staged = target
    return target
  }

  /**
   * Only a packaged Windows build has an install directory an installer will empty out.
   *
   * macOS never stages. An "upgrade" there is the user replacing the whole `.app` bundle, and
   * Unix semantics make that a non-event for a running process: the executable and the dylibs
   * it mapped are held by inode, so the old bundle's files stay alive until the last handle
   * closes. Nothing kills the process, nothing fails because a file is open, and a staged copy
   * would buy 250 MB of duplicated bundle for no benefit.
   *
   * Unpackaged Windows never stages either: `execPath` is `node_modules/electron/dist/
   * electron.exe`, there is no install directory and no installer, and staging would only put
   * a stale copy of the host between the developer and their own rebuilt code.
   */
  private stagingRequired(): boolean {
    return this.platform === 'win32' && this.isPackaged
  }

  private inPlaceTarget(): PtyHostLaunchTarget {
    return { runtime: this.execPath, script: this.appScriptPath() }
  }

  /** Path building follows the *target* platform, not the host running the tests. */
  private get path(): typeof windowsPath | typeof posix {
    return this.platform === 'win32' ? windowsPath : posix
  }

  /** `out/main/pty-host.mjs` inside the app — the repo's `out/` in dev, inside app.asar when
   * packaged (Electron's patched `fs` reads both). */
  private appScriptPath(): string {
    return this.path.join(this.appPath, 'out', 'main', HOST_SCRIPT_NAME)
  }

  /**
   * node-pty is `asarUnpack`ed, so the only place it exists as real files is the sibling
   * `app.asar.unpacked`. Falls back to `appPath` itself for an unpacked (`--dir`) build, where
   * there is no archive and `node_modules` sits in the app directory.
   */
  private unpackedRoot(): string {
    return this.path.basename(this.appPath) === ASAR_DIRECTORY_NAME ? `${this.appPath}.unpacked` : this.appPath
  }

  private async stageRuntime(): Promise<PtyHostLaunchTarget> {
    const root = this.path.join(this.userDataPath, STAGING_ROOT)
    const versionDirectory = this.path.join(root, this.appVersion)
    const target: PtyHostLaunchTarget = {
      runtime: this.path.join(versionDirectory, HOST_EXECUTABLE_NAME),
      script: this.path.join(versionDirectory, HOST_SCRIPT_NAME)
    }

    // Before anything else, because a crash during a previous copy leaves a directory that is
    // pure garbage and could be tens of megabytes of it.
    await this.sweepStagingLeftovers(root)

    const plan = await this.buildPlan()

    if (await this.isComplete(versionDirectory, plan)) {
      await this.sweepSupersededVersions(root)
      return target
    }

    const staging = this.path.join(root, `${this.appVersion}${STAGING_MARKER}${this.newStagingId()}`)
    try {
      await this.fileSystem.ensureDirectory(root)
      await this.copyPlan(staging, plan)
      await this.promote(staging, versionDirectory, plan)
    } catch (error) {
      // The half-built directory must not survive: its name would become a version directory
      // on the next run only if it were renamed, but leaving it costs disk and confuses the
      // next sweep's log. Best-effort — the error being reported is the interesting one.
      await this.discard(staging)
      throw error instanceof PtyHostStagingError ? error : new PtyHostStagingError('staging', error)
    }

    await this.sweepSupersededVersions(root)
    return target
  }

  /**
   * Enumerates every file that has to end up in the staging directory, with the size the copy
   * is expected to have. Sizes are read here rather than during the copy because they are what
   * makes the completeness check cheap: one `stat` per file, no hashing.
   */
  private async buildPlan(): Promise<readonly PlannedFile[]> {
    const runtimeDirectory = this.path.dirname(this.execPath)
    const plan: PlannedFile[] = []

    // The executable is renamed on the way out; see HOST_EXECUTABLE_NAME.
    await this.planFile(plan, this.execPath, HOST_EXECUTABLE_NAME, 'disk')
    for (const name of RUNTIME_SIDE_FILES) {
      await this.planFile(plan, this.path.join(runtimeDirectory, name), name, 'disk')
    }

    await this.planFile(plan, this.appScriptPath(), HOST_SCRIPT_NAME, 'archive')
    await this.planChunks(plan)
    await this.planNodePty(plan)

    return plan
  }

  private async planFile(
    plan: PlannedFile[],
    source: string,
    target: string,
    origin: PlannedFile['origin']
  ): Promise<void> {
    const bytes = await this.fileSize(source)
    // A required file that cannot be measured is a broken installation, and staging a runtime
    // that is missing a piece would only move the failure to the host's own startup, where it
    // is invisible to everything but the host's log file.
    if (bytes === undefined) throw new PtyHostStagingError(`missing runtime file ${source}`)
    plan.push({ source, target, bytes, origin })
  }

  /**
   * `out/main/chunks/*.mjs` holds the modules shared between the main entry and the host
   * (the PTY protocol, the agent registry). The names carry a content hash, so they are
   * enumerated rather than listed.
   *
   * A chunks directory that cannot be read is tolerated: whether Rollup emits shared chunks at
   * all is a build-shape detail, and failing here would break staging outright on a build that
   * happened to inline everything. If chunks really are missing the host fails to import them
   * on startup, which the e2e suite catches.
   */
  private async planChunks(plan: PlannedFile[]): Promise<void> {
    const directory = this.path.join(this.appPath, 'out', 'main', CHUNKS_DIRECTORY)
    let entries: readonly PtyHostDirectoryEntry[]
    try {
      entries = await this.fileSystem.readDirectory(directory)
    } catch (error) {
      this.log(`no shared chunks staged from ${directory}: ${describeFailure(error)}`)
      return
    }

    for (const entry of entries) {
      if (entry.isDirectory || !entry.name.endsWith(SCRIPT_SUFFIX)) continue
      await this.planFile(
        plan,
        this.path.join(directory, entry.name),
        this.path.join(CHUNKS_DIRECTORY, entry.name),
        'archive'
      )
    }
  }

  /**
   * The whole node-pty package, copied recursively into the staging root's `node_modules` so
   * the host resolves it by walking up from its own directory.
   *
   * Not trimmed to a minimal set on purpose. node-pty's loader probes relative paths at
   * runtime — `build/Release`, then `prebuilds/<platform>-<arch>` — and it ships the ConPTY
   * binaries and a `winpty.dll` alongside. Guessing wrong about which of the 179 files matter
   * would only fail on a user's machine, and the whole package is under 10 MB.
   *
   * Unlike the chunks, an unreadable node-pty is fatal: there is no build of CodeFly where a
   * host without it could do anything at all.
   */
  private async planNodePty(plan: PlannedFile[]): Promise<void> {
    const source = this.path.join(this.unpackedRoot(), NODE_MODULES_DIRECTORY, NODE_PTY_DIRECTORY)
    const target = this.path.join(NODE_MODULES_DIRECTORY, NODE_PTY_DIRECTORY)
    try {
      await this.planTree(plan, source, target)
    } catch (error) {
      if (error instanceof PtyHostStagingError) throw error
      throw new PtyHostStagingError(`could not read node-pty at ${source}`, error)
    }
  }

  private async planTree(plan: PlannedFile[], source: string, target: string): Promise<void> {
    const entries = await this.fileSystem.readDirectory(source)
    for (const entry of entries) {
      const from = this.path.join(source, entry.name)
      const to = this.path.join(target, entry.name)
      if (entry.isDirectory) {
        await this.planTree(plan, from, to)
        continue
      }
      await this.planFile(plan, from, to, 'disk')
    }
  }

  private async copyPlan(staging: string, plan: readonly PlannedFile[]): Promise<void> {
    const linkState: LinkState = { supported: true }
    const created = new Set<string>()

    for (const file of plan) {
      const destination = this.path.join(staging, file.target)
      const parent = this.path.dirname(destination)
      if (!created.has(parent)) {
        created.add(parent)
        await this.fileSystem.ensureDirectory(parent)
      }

      if (file.origin === 'archive') {
        // Read and rewrite: an app.asar entry is a slice of an archive, not a file with an
        // inode, so there is nothing to link and nothing for a plain copy to open.
        await this.fileSystem.writeFile(destination, await this.fileSystem.readFile(file.source))
        continue
      }
      await this.linkOrCopy(file.source, destination, linkState)
    }
  }

  /**
   * Hard link first, copy on any refusal.
   *
   * A hard link is free — no bytes move, which matters most for the 244 MB executable — and it
   * satisfies every constraint the staging exists for. A link is an independent directory
   * entry, so the host process reports the staged path as its image path and escapes the
   * installer's `StartsWith($INSTDIR)` sweep; and when the uninstaller renames the install
   * directory's entry for the same data, the staged name keeps pointing at it (Windows allows
   * renaming a running image, which is exactly why `un.atomicRMDir` works at all).
   *
   * Linking fails in ordinary situations, not just broken ones: the installer lets the user
   * choose an install directory on another volume (EXDEV), the volume may not be NTFS, and a
   * locked-down profile can refuse the second link. All of those fall back to a real copy,
   * silently — a slower start is not worth a message. The first refusal turns linking off for
   * the rest of the run: the reason is almost always a property of the pair of volumes, so
   * asking again for each of the remaining ~180 files would only slow the copy down and fill
   * the log.
   */
  private async linkOrCopy(from: string, to: string, state: LinkState): Promise<void> {
    if (state.supported) {
      try {
        await this.fileSystem.link(from, to)
        return
      } catch (error) {
        state.supported = false
        this.log(`hard links unavailable, copying the host runtime instead: ${describeFailure(error)}`)
      }
    }
    await this.fileSystem.copyFile(from, to)
  }

  /**
   * Moves the finished directory into place under its version name, which is what makes a
   * version directory's existence mean "complete". Copying straight into the final name would
   * let a crash halfway through the 244 MB executable leave a directory that looks ready and
   * spawns a truncated exe.
   */
  private async promote(staging: string, versionDirectory: string, plan: readonly PlannedFile[]): Promise<void> {
    try {
      await this.fileSystem.rename(staging, versionDirectory)
      return
    } catch (error) {
      // Windows refuses to rename onto an existing directory, so this is the expected outcome
      // when something is already there. If that something is complete, someone else won the
      // race with an identical copy and the work here is simply thrown away.
      if (await this.isComplete(versionDirectory, plan)) {
        this.log(`another instance staged ${versionDirectory} first; discarding this copy.`)
        await this.discard(staging)
        return
      }
      this.log(`replacing an incomplete ${versionDirectory}: ${describeFailure(error)}`)
    }

    // An incomplete directory under the version name cannot be trusted or repaired in place,
    // and something has to give: a partial exe would be spawned and fail.
    try {
      await this.fileSystem.removeDirectory(versionDirectory)
    } catch (error) {
      throw new PtyHostStagingError(`could not replace ${versionDirectory}`, error)
    }
    try {
      await this.fileSystem.rename(staging, versionDirectory)
    } catch (error) {
      throw new PtyHostStagingError(`could not move the staged runtime to ${versionDirectory}`, error)
    }
  }

  /**
   * Cheap completeness test: every planned file exists at the same size. Deliberately not a
   * hash — this runs on every app start, over ~180 files including a 244 MB executable, and
   * the failure it has to catch is a truncated or missing file rather than a corrupted one.
   */
  private async isComplete(directory: string, plan: readonly PlannedFile[]): Promise<boolean> {
    for (const file of plan) {
      if ((await this.fileSize(this.path.join(directory, file.target))) !== file.bytes) return false
    }
    return true
  }

  /**
   * `PtyHostRuntimeFileSystem.fileSize` is documented as never rejecting, but every decision
   * made from its answer treats "missing" and "unreadable" identically, and an injected
   * implementation is not this class's to trust.
   */
  private async fileSize(filePath: string): Promise<number | undefined> {
    try {
      return await this.fileSystem.fileSize(filePath)
    } catch {
      return undefined
    }
  }

  /** Removes the temporary directory of a failed or superseded copy; failure is only logged. */
  private async discard(staging: string): Promise<void> {
    try {
      await this.fileSystem.removeDirectory(staging)
    } catch (error) {
      this.log(`could not delete the temporary directory ${staging}: ${describeFailure(error)}`)
    }
  }

  /**
   * Deletes `<version>.staging-*` directories left behind by a crash or a kill during a copy.
   * Runs before this run creates its own, so a live staging directory is never a candidate.
   */
  private async sweepStagingLeftovers(root: string): Promise<void> {
    for (const entry of await this.listDirectories(root)) {
      if (!entry.includes(STAGING_MARKER)) continue
      this.log(`removing an interrupted staging directory ${entry}.`)
      await this.discard(this.path.join(root, entry))
    }
  }

  /**
   * Drops every version directory but the current one, so the roaming profile does not grow by
   * a quarter of a gigabyte per update.
   *
   * Failure here is the *normal* case immediately after an upgrade: the previous version's host
   * is still running, still holding the agents, and Windows will not delete the executable it
   * has mapped. That is precisely the behaviour this whole class exists to produce, so a
   * refusal is logged and ignored, and the next run — by which time the old host has retired —
   * tries again. A partially deleted old directory is harmless: nothing reads it, its own
   * completeness check would fail, and the next sweep finishes the job.
   */
  private async sweepSupersededVersions(root: string): Promise<void> {
    for (const entry of await this.listDirectories(root)) {
      // Staging directories are left to sweepStagingLeftovers: deleting one here could hit a
      // copy another process is in the middle of writing.
      if (entry === this.appVersion || entry.includes(STAGING_MARKER)) continue
      try {
        await this.fileSystem.removeDirectory(this.path.join(root, entry))
        this.log(`removed the superseded host runtime ${entry}.`)
      } catch (error) {
        this.log(`kept the superseded host runtime ${entry} (still in use?): ${describeFailure(error)}`)
      }
    }
  }

  /** Directory names inside `root`; an empty list when it does not exist or cannot be read,
   * because every caller is housekeeping that must never fail a resolve. */
  private async listDirectories(root: string): Promise<readonly string[]> {
    try {
      const entries = await this.fileSystem.readDirectory(root)
      return entries.filter((entry) => entry.isDirectory).map((entry) => entry.name)
    } catch {
      return []
    }
  }
}
