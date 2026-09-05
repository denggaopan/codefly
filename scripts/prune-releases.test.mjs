// @vitest-environment node
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pruneReleases } from './prune-releases.mjs'

let directory
const writeFiles = (names) => {
  for (const name of names) writeFileSync(path.join(directory, name), '')
}
const releaseFiles = (version) => [
  `CodeFly-Setup-${version}-win-x64.exe`,
  `CodeFly-Setup-${version}-win-x64.exe.blockmap`,
  `CodeFly-${version}-mac-x64.zip`,
  `CodeFly-${version}-mac-arm64.zip`,
  `CodeFly-${version}-mac-arm64.dmg`,
  `current-release-${version}.json`,
  `release-notes-${version}.md`,
  `validation-${version}.json`,
  `mac-validation-${version}.json`,
  `tag-${version}.json`
]

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'codefly-prune-releases-'))
})

afterEach(() => {
  const relative = path.relative(tmpdir(), directory)
  if (path.isAbsolute(relative) || relative.startsWith('..') || !relative.startsWith('codefly-prune-releases-')) {
    throw new Error(`Unexpected test directory: ${directory}`)
  }
  rmSync(directory, { recursive: true, force: true })
})

describe('release retention', () => {
  it('keeps three versions across platforms and removes every file belonging to older versions', () => {
    const versions = ['0.15.99', '0.16.8', '0.16.9', '0.16.10', '0.17.0']
    writeFiles(versions.flatMap(releaseFiles))
    const future = new Date('2030-01-01')
    utimesSync(path.join(directory, releaseFiles('0.15.99')[0]), future, future)

    const result = pruneReleases(directory)

    expect(result.keptVersions).toEqual(['0.17.0', '0.16.10', '0.16.9'])
    expect(result.removedFiles.sort()).toEqual(['0.15.99', '0.16.8'].flatMap(releaseFiles).sort())
    expect(readdirSync(directory).sort()).toEqual(['0.16.9', '0.16.10', '0.17.0'].flatMap(releaseFiles).sort())
    expect(pruneReleases(directory).removedFiles).toEqual([])
  })

  it.each([0, 1, 2, 3])('leaves all files when there are %i versions', (count) => {
    const names = Array.from({ length: count }, (_, index) => releaseFiles(`0.16.${index}`)).flat()
    writeFiles(names)
    expect(pruneReleases(directory).removedFiles).toEqual([])
    expect(readdirSync(directory).sort()).toEqual(names.sort())
  })

  it('orders prereleases correctly and groups build metadata with the same version', () => {
    writeFiles(['1.0.0-beta.2', '1.0.0-beta.10', '1.0.0-rc.1', '1.0.0', '1.0.0+build.42'].flatMap(releaseFiles))

    const result = pruneReleases(directory)

    expect(result.keptVersions).toEqual(['1.0.0', '1.0.0-rc.1', '1.0.0-beta.10'])
    expect(result.removedFiles.sort()).toEqual(releaseFiles('1.0.0-beta.2').sort())
    expect(readdirSync(directory)).toEqual(expect.arrayContaining(releaseFiles('1.0.0+build.42')))
  })

  it('preserves directories, update manifests, unknown names and malformed versions', () => {
    writeFiles(['0.16.0', '0.16.1', '0.16.2', '0.16.3'].flatMap(releaseFiles))
    const unrelated = ['latest.yml', 'latest-mac.yml', 'builder-debug.yml', 'notes-0.1.0.txt',
      'OtherApp-Setup-0.1.0-win-x64.exe', 'CodeFly-Setup-invalid-win-x64.exe', 'CodeFly-0.1.0-mac-x64.zip.partial']
    writeFiles(unrelated)
    const directories = ['win-unpacked', 'cache', 'tools', 'tmp', 'CodeFly-0.1.0-mac-x64.zip']
    for (const name of directories) {
      mkdirSync(path.join(directory, name))
      writeFileSync(path.join(directory, name, 'keep.txt'), 'keep')
    }

    pruneReleases(directory)

    expect(readdirSync(directory).sort()).toEqual([
      ...['0.16.1', '0.16.2', '0.16.3'].flatMap(releaseFiles), ...unrelated, ...directories
    ].sort())
    for (const name of directories) expect(readdirSync(path.join(directory, name))).toEqual(['keep.txt'])
  })

  it('cleans legacy Windows installer names and their blockmaps', () => {
    const oldFiles = ['CodeFly Setup 0.1.0.exe', 'CodeFly Setup 0.1.0.exe.blockmap',
      'CodeFly-Setup-0.2.0.exe', 'CodeFly-Setup-0.2.0.exe.blockmap']
    writeFiles([...oldFiles, ...['0.16.1', '0.16.2', '0.16.3'].flatMap(releaseFiles)])
    expect(pruneReleases(directory).removedFiles.sort()).toEqual(oldFiles.sort())
  })

  it('allows a missing release directory but reports other filesystem errors', () => {
    expect(pruneReleases(path.join(directory, 'missing'))).toEqual({ keptVersions: [], removedFiles: [] })
    writeFiles(['file'])
    expect(() => pruneReleases(path.join(directory, 'file'))).toThrow()
  })
})
