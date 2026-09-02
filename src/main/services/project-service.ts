import { realpath, stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { ProjectRecord, RepoRemote } from '../../shared/contracts'
import { commandRunner } from '../infrastructure/command-runner'
import type { CommandRunner } from '../infrastructure/command-runner'
import { parseRemoteWebUrl } from './git-remote'
import { SessionStore } from './session-store'

export interface ProjectFileSystem {
  realpath(path: string): Promise<string>
  stat(path: string): Promise<{ isDirectory(): boolean }>
}

export class ProjectNotFoundError extends Error {
  readonly projectId: string

  constructor(projectId: string) {
    super(`Project not found: ${projectId}`)
    this.name = 'ProjectNotFoundError'
    this.projectId = projectId
  }
}

export class ProjectOrderMismatchError extends Error {
  constructor() {
    super('The requested project order does not match the current set of projects. Refresh and try again.')
    this.name = 'ProjectOrderMismatchError'
  }
}

export class InvalidProjectPathError extends Error {
  readonly selectedPath: string

  constructor(selectedPath: string, cause?: unknown) {
    super(`Invalid project path: ${selectedPath}${cause instanceof Error ? ` (${cause.message})` : ''}`, { cause })
    this.name = 'InvalidProjectPathError'
    this.selectedPath = selectedPath
  }
}

const productionFileSystem: ProjectFileSystem = { realpath, stat }

const normalizeProjectPath = (value: string, platform: NodeJS.Platform): string => {
  if (platform !== 'win32') {
    const withoutTrailingSeparators = value.replace(/\/+$/u, '')
    return withoutTrailingSeparators || '/'
  }
  const withWindowsSeparators = value.replace(/\//g, '\\')
  const withoutTrailingSeparators = withWindowsSeparators.replace(/\\+$/u, '')
  return (withoutTrailingSeparators || withWindowsSeparators).toLocaleLowerCase('en-US')
}

const sameRemote = (left: RepoRemote | undefined, right: RepoRemote | undefined): boolean =>
  left === right || (left !== undefined && right !== undefined && left.host === right.host && left.webUrl === right.webUrl)

const projectWithPath = (projects: readonly ProjectRecord[], candidatePath: string, platform: NodeJS.Platform): ProjectRecord | undefined => {
  const normalizedCandidate = normalizeProjectPath(candidatePath, platform)
  return projects.find((project) => normalizeProjectPath(project.path, platform) === normalizedCandidate)
}

export class ProjectService {
  constructor(
    private readonly store: SessionStore,
    private readonly runner: CommandRunner = commandRunner,
    private readonly fileSystem: ProjectFileSystem = productionFileSystem,
    private readonly clock: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  async register(selectedPath: string): Promise<ProjectRecord> {
    if (!selectedPath.trim()) throw new InvalidProjectPathError(selectedPath)

    let realPath: string
    try {
      realPath = await this.fileSystem.realpath(selectedPath)
    } catch (error) {
      throw new InvalidProjectPathError(selectedPath, error)
    }
    let directory: { isDirectory(): boolean }
    try {
      directory = await this.fileSystem.stat(realPath)
    } catch (error) {
      throw new InvalidProjectPathError(selectedPath, error)
    }
    if (!directory.isDirectory()) throw new InvalidProjectPathError(selectedPath)

    const current = await this.store.load()
    const existing = projectWithPath(current.projects, realPath, this.platform)
    if (existing) return existing

    const repoRoot = await this.findRepoRoot(realPath)
    const repoRemote = repoRoot ? await this.findRepoRemote(realPath).catch(() => undefined) : undefined
    const name = (this.platform === 'win32' ? win32 : posix).basename(realPath) || realPath
    const project: ProjectRecord = {
      id: this.createId(),
      name,
      path: realPath,
      ...(repoRoot ? { repoRoot } : {}),
      ...(repoRemote ? { repoRemote } : {}),
      createdAt: this.clock().toISOString()
    }

    let persisted = project
    await this.store.update((latest) => {
      const concurrentExisting = projectWithPath(latest.projects, realPath, this.platform)
      if (concurrentExisting) {
        persisted = concurrentExisting
        return latest
      }
      return { ...latest, projects: [...latest.projects, project] }
    })
    return persisted
  }

  /**
   * Persists a new display order for the projects. The order must be an exact permutation
   * of the projects persisted at commit time — validated inside the update transaction so a
   * project registered concurrently (after the renderer read its stale list) is never
   * silently dropped. Returns the reordered records.
   */
  async reorder(orderedProjectIds: readonly string[]): Promise<ProjectRecord[]> {
    let reordered: ProjectRecord[] = []
    await this.store.update((latest) => {
      const byId = new Map(latest.projects.map((project) => [project.id, project]))
      const isPermutation =
        orderedProjectIds.length === byId.size &&
        new Set(orderedProjectIds).size === orderedProjectIds.length &&
        orderedProjectIds.every((id) => byId.has(id))
      if (!isPermutation) throw new ProjectOrderMismatchError()

      reordered = orderedProjectIds.map((id) => byId.get(id)!)
      return { ...latest, projects: reordered }
    })
    return reordered
  }

  async get(projectId: string): Promise<ProjectRecord> {
    const project = (await this.store.load()).projects.find((candidate) => candidate.id === projectId)
    if (!project) throw new ProjectNotFoundError(projectId)
    return project
  }

  /**
   * Re-resolves every project's browsable remote and persists the result in one write when
   * anything differs. Run on startup so projects registered before remotes were recorded
   * pick theirs up, and so a remote that was added, changed, or removed since the last run
   * is reflected. A project whose `git` invocation fails (folder gone, git missing) keeps
   * whatever it had — a transient failure must not strip the menu entry. Never rejects: the
   * snapshot this feeds must still load when Git is unavailable altogether.
   */
  async refreshRemotes(): Promise<void> {
    try {
      const { projects } = await this.store.load()
      const resolved = await Promise.all(
        projects.map(async (project) => {
          try {
            return { id: project.id, repoRemote: await this.findRepoRemote(project.path) }
          } catch {
            return { id: project.id, repoRemote: project.repoRemote }
          }
        })
      )
      const remoteById = new Map(resolved.map((entry) => [entry.id, entry.repoRemote]))
      const changed = projects.some((project) => !sameRemote(project.repoRemote, remoteById.get(project.id)))
      if (!changed) return

      await this.store.update((latest) => ({
        ...latest,
        projects: latest.projects.map((project) => {
          if (!remoteById.has(project.id)) return project
          const { repoRemote: _previous, ...rest } = project
          const repoRemote = remoteById.get(project.id)
          return repoRemote ? { ...rest, repoRemote } : rest
        })
      }))
    } catch (error) {
      console.error('ProjectService: failed to refresh repository remotes.', error)
    }
  }

  /**
   * The browsable page of the project's remote, preferring `origin` and otherwise the first
   * remote Git lists. Resolves `undefined` when there is no remote or it is not a web URL
   * (see parseRemoteWebUrl); rejects only when `git` itself fails to run.
   */
  private async findRepoRemote(realPath: string): Promise<RepoRemote | undefined> {
    const listed = await this.runner.run('git', ['-C', realPath, 'remote'])
    const names = listed.stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0)
    const name = names.includes('origin') ? 'origin' : names[0]
    if (!name) return undefined

    const url = await this.runner.run('git', ['-C', realPath, 'remote', 'get-url', name])
    return parseRemoteWebUrl(url.stdout)
  }

  private async findRepoRoot(realPath: string): Promise<string | undefined> {
    try {
      const result = await this.runner.run('git', ['-C', realPath, 'rev-parse', '--show-toplevel'])
      const output = result.stdout.trim()
      return output ? (this.platform === 'win32' ? win32 : posix).resolve(output) : undefined
    } catch {
      return undefined
    }
  }
}
