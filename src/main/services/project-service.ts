import { realpath, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { ProjectRecord } from '../../shared/contracts'
import { commandRunner } from '../infrastructure/command-runner'
import type { CommandRunner } from '../infrastructure/command-runner'
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

export class InvalidProjectPathError extends Error {
  readonly selectedPath: string

  constructor(selectedPath: string, cause?: unknown) {
    super(`Invalid project path: ${selectedPath}${cause instanceof Error ? ` (${cause.message})` : ''}`, { cause })
    this.name = 'InvalidProjectPathError'
    this.selectedPath = selectedPath
  }
}

const productionFileSystem: ProjectFileSystem = { realpath, stat }

const normalizeProjectPath = (value: string): string => {
  const withWindowsSeparators = value.replace(/\//g, '\\')
  const withoutTrailingSeparators = withWindowsSeparators.replace(/\\+$/u, '')
  return (withoutTrailingSeparators || withWindowsSeparators).toLocaleLowerCase('en-US')
}

const projectWithPath = (projects: readonly ProjectRecord[], candidatePath: string): ProjectRecord | undefined => {
  const normalizedCandidate = normalizeProjectPath(candidatePath)
  return projects.find((project) => normalizeProjectPath(project.path) === normalizedCandidate)
}

export class ProjectService {
  constructor(
    private readonly store: SessionStore,
    private readonly runner: CommandRunner = commandRunner,
    private readonly fileSystem: ProjectFileSystem = productionFileSystem,
    private readonly clock: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID
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
    const existing = projectWithPath(current.projects, realPath)
    if (existing) return existing

    const repoRoot = await this.findRepoRoot(realPath)
    const name = basename(realPath) || realPath
    const project: ProjectRecord = {
      id: this.createId(),
      name,
      path: realPath,
      ...(repoRoot ? { repoRoot } : {}),
      createdAt: this.clock().toISOString()
    }

    let persisted = project
    await this.store.update((latest) => {
      const concurrentExisting = projectWithPath(latest.projects, realPath)
      if (concurrentExisting) {
        persisted = concurrentExisting
        return latest
      }
      return { ...latest, projects: [...latest.projects, project] }
    })
    return persisted
  }

  async get(projectId: string): Promise<ProjectRecord> {
    const project = (await this.store.load()).projects.find((candidate) => candidate.id === projectId)
    if (!project) throw new ProjectNotFoundError(projectId)
    return project
  }

  private async findRepoRoot(realPath: string): Promise<string | undefined> {
    try {
      const result = await this.runner.run('git', ['-C', realPath, 'rev-parse', '--show-toplevel'])
      const output = result.stdout.trim()
      return output ? resolve(output) : undefined
    } catch {
      return undefined
    }
  }
}
