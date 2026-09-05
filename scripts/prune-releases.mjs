#!/usr/bin/env node
import { readdirSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const releaseDir = fileURLToPath(new URL('../release/', import.meta.url))
const KEEP_VERSIONS = 3
const VERSIONED_FILES = [
  /^CodeFly-(?:Setup-)?(.+)-(?:win|mac)-(?:x64|arm64|ia32|universal)\.(?:exe|zip|dmg)(?:\.blockmap)?$/i,
  /^CodeFly(?:-Setup-| Setup )(.+)\.exe(?:\.blockmap)?$/i,
  /^(?:current-release|release-notes|(?:mac-)?validation|tag)-(.+)\.(?:json|md)$/i
]

const fileVersion = (name) => {
  for (const pattern of VERSIONED_FILES) {
    const match = pattern.exec(name)
    const version = match && semver.valid(match[1])
    if (version) return version
  }
  return undefined
}

export const pruneReleases = (directory = releaseDir) => {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return { keptVersions: [], removedFiles: [] }
    throw error
  }

  // Only known top-level files participate; unpacked apps, caches and links stay intact.
  const files = entries.filter((entry) => entry.isFile()).flatMap((entry) => {
    const version = fileVersion(entry.name)
    return version ? [{ name: entry.name, version }] : []
  })
  const versions = [...new Set(files.map((file) => file.version))].sort(semver.rcompare)
  const keptVersions = versions.slice(0, KEEP_VERSIONS)
  const obsoleteVersions = new Set(versions.slice(KEEP_VERSIONS))
  const removedFiles = []
  for (const file of files) {
    if (!obsoleteVersions.has(file.version)) continue
    unlinkSync(path.join(directory, file.name))
    removedFiles.push(file.name)
  }
  return { keptVersions, removedFiles }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { keptVersions, removedFiles } = pruneReleases()
  console.log(`release:prune: kept ${keptVersions.join(', ') || 'no versions'}; removed ${removedFiles.length} old files`)
}
