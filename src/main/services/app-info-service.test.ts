import { describe, expect, it } from 'vitest'

import { EXTERNAL_LINKS, type ExternalLinkTarget } from '../../shared/links'
import {
  AppInfoService,
  compareSemVer,
  compareVersionStrings,
  parseSemVer,
  stripVersionPrefix,
  type FetchLike,
  type HttpResponseLike,
  type LoginItemSettings
} from './app-info-service'

const CURRENT_VERSION = '0.4.1'

const jsonResponse = (status: number, body: unknown): HttpResponseLike => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body
})

const release = (tagName: string, htmlUrl = 'https://github.com/denggaopan/codefly/releases/tag/x'): unknown => ({
  tag_name: tagName,
  html_url: htmlUrl,
  // Extra fields mirror the real GitHub payload; the service must ignore them.
  id: 1,
  draft: false,
  body: 'notes'
})

class FakeLoginItem implements LoginItemSettings {
  readonly reads: number[] = []
  readonly writes: boolean[] = []

  constructor(
    private openAtLogin = false,
    private readonly behavior: { readThrows?: Error; writeThrows?: Error; ignoreWrites?: boolean } = {}
  ) {}

  getOpenAtLogin(): boolean {
    this.reads.push(this.reads.length)
    if (this.behavior.readThrows) throw this.behavior.readThrows
    return this.openAtLogin
  }

  setOpenAtLogin(openAtLogin: boolean): void {
    this.writes.push(openAtLogin)
    if (this.behavior.writeThrows) throw this.behavior.writeThrows
    if (this.behavior.ignoreWrites) return
    this.openAtLogin = openAtLogin
  }
}

type Harness = {
  service: AppInfoService
  requests: Array<{ url: string; headers: Record<string, string>; signal?: AbortSignal }>
  timeouts: number[]
  opened: string[]
  loginItem: FakeLoginItem
}

const buildHarness = (
  options: {
    version?: string
    respond?: FetchLike
    openExternalThrows?: Error
    loginItem?: FakeLoginItem
  } = {}
): Harness => {
  const requests: Harness['requests'] = []
  const timeouts: number[] = []
  const opened: string[] = []
  const loginItem = options.loginItem ?? new FakeLoginItem()

  const respond = options.respond ?? (async () => jsonResponse(404, { message: 'Not Found' }))

  const service = new AppInfoService(
    () => options.version ?? CURRENT_VERSION,
    async (url, init) => {
      requests.push({ url, headers: init.headers, signal: init.signal })
      return respond(url, init)
    },
    async (url) => {
      opened.push(url)
      if (options.openExternalThrows) throw options.openExternalThrows
    },
    loginItem,
    (milliseconds) => {
      timeouts.push(milliseconds)
      return undefined
    }
  )

  return { service, requests, timeouts, opened, loginItem }
}

const named = (name: string, message = name): Error => {
  const error = new Error(message)
  error.name = name
  return error
}

describe('AppInfoService.info', () => {
  it('reports the running version alongside the vetted external links', () => {
    const { service } = buildHarness({ version: '1.2.3' })

    expect(service.info()).toEqual({ version: '1.2.3', links: EXTERNAL_LINKS })
  })
})

describe('AppInfoService.checkForUpdates: request shape', () => {
  it('calls the GitHub latest-release endpoint with the documented headers and a 10s timeout', async () => {
    const { service, requests, timeouts } = buildHarness()

    await service.checkForUpdates()

    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe('https://api.github.com/repos/denggaopan/codefly/releases/latest')
    expect(requests[0]!.headers).toEqual({ Accept: 'application/vnd.github+json', 'User-Agent': 'CodeFly' })
    expect(timeouts).toEqual([10_000])
  })
})

describe('AppInfoService.checkForUpdates: outcomes', () => {
  it('maps HTTP 404 to `none` because the repository has published no release yet', async () => {
    const { service } = buildHarness({ respond: async () => jsonResponse(404, { message: 'Not Found' }) })

    await expect(service.checkForUpdates()).resolves.toEqual({ status: 'none', currentVersion: CURRENT_VERSION })
  })

  it('reports `available` with the release URL when the latest tag is newer', async () => {
    const { service } = buildHarness({
      version: '0.4.1',
      respond: async () => jsonResponse(200, release('v0.5.0', 'https://github.com/denggaopan/codefly/releases/tag/v0.5.0'))
    })

    await expect(service.checkForUpdates()).resolves.toEqual({
      status: 'available',
      currentVersion: '0.4.1',
      latestVersion: '0.5.0',
      releaseUrl: 'https://github.com/denggaopan/codefly/releases/tag/v0.5.0'
    })
  })

  it('falls back to the download link when the release payload carries no html_url', async () => {
    const { service } = buildHarness({ version: '0.4.1', respond: async () => jsonResponse(200, { tag_name: '0.5.0' }) })

    await expect(service.checkForUpdates()).resolves.toEqual({
      status: 'available',
      currentVersion: '0.4.1',
      latestVersion: '0.5.0',
      releaseUrl: EXTERNAL_LINKS.download
    })
  })

  it('describes the Windows installer the release publishes, without leaking its URL', async () => {
    const { service } = buildHarness({
      version: '0.4.1',
      respond: async () =>
        jsonResponse(200, {
          ...(release('v0.5.0') as object),
          assets: [
            {
              name: 'CodeFly-Setup-0.5.0-win-x64.exe',
              size: 84_231_680,
              browser_download_url: 'https://github.com/denggaopan/codefly/releases/download/v0.5.0/CodeFly-Setup-0.5.0-win-x64.exe',
              // Extra asset fields mirror the real payload and must be ignored.
              content_type: 'application/x-msdownload',
              download_count: 42
            }
          ]
        })
    })

    await expect(service.checkForUpdates()).resolves.toMatchObject({
      status: 'available',
      asset: { fileName: 'CodeFly-Setup-0.5.0-win-x64.exe', size: 84_231_680 }
    })
    // The download URL stays in the main process: UpdaterService re-resolves it itself.
    await expect(service.checkForUpdates()).resolves.not.toHaveProperty('asset.browser_download_url')
  })

  it('prefers the Setup package when a release publishes several executables', async () => {
    const { service } = buildHarness({
      version: '0.4.1',
      respond: async () =>
        jsonResponse(200, {
          ...(release('v0.5.0') as object),
          assets: [
            { name: 'CodeFly-Portable-0.5.0.exe', size: 10, browser_download_url: 'https://github.com/a.exe' },
            { name: 'CodeFly-Setup-0.5.0-win-x64.exe', size: 20, browser_download_url: 'https://github.com/b.exe' }
          ]
        })
    })

    await expect(service.checkForUpdates()).resolves.toMatchObject({
      asset: { fileName: 'CodeFly-Setup-0.5.0-win-x64.exe', size: 20 }
    })
  })

  it('omits the asset when the release ships no Windows installer, leaving the download page as the fallback', async () => {
    const { service } = buildHarness({
      version: '0.4.1',
      respond: async () =>
        jsonResponse(200, {
          ...(release('v0.5.0') as object),
          assets: [{ name: 'CodeFly-0.5.0-win-x64.zip', size: 12, browser_download_url: 'https://github.com/a.zip' }]
        })
    })

    const result = await service.checkForUpdates()

    expect(result).not.toHaveProperty('asset')
    expect(result).toMatchObject({ status: 'available', latestVersion: '0.5.0' })
  })

  it('omits the asset when the published name is not a plain file name', async () => {
    const { service } = buildHarness({
      version: '0.4.1',
      respond: async () =>
        jsonResponse(200, {
          ...(release('v0.5.0') as object),
          assets: [{ name: '../CodeFly-Setup.exe', size: 12, browser_download_url: 'https://github.com/a.exe' }]
        })
    })

    await expect(service.checkForUpdates()).resolves.not.toHaveProperty('asset')
  })

  it('still reports the new version when the assets array itself is unreadable', async () => {
    const { service } = buildHarness({
      version: '0.4.1',
      respond: async () => jsonResponse(200, { ...(release('v0.5.0') as object), assets: 'not-an-array' })
    })

    const result = await service.checkForUpdates()

    expect(result).toMatchObject({ status: 'available', latestVersion: '0.5.0' })
    expect(result).not.toHaveProperty('asset')
  })

  it('reports `up-to-date` when the latest tag equals the running version', async () => {
    const { service } = buildHarness({ version: '0.4.1', respond: async () => jsonResponse(200, release('v0.4.1')) })

    await expect(service.checkForUpdates()).resolves.toEqual({
      status: 'up-to-date',
      currentVersion: '0.4.1',
      latestVersion: '0.4.1'
    })
  })

  it('reports `up-to-date` when the published release is older than the running build', async () => {
    const { service } = buildHarness({ version: '0.5.0', respond: async () => jsonResponse(200, release('v0.4.1')) })

    await expect(service.checkForUpdates()).resolves.toEqual({
      status: 'up-to-date',
      currentVersion: '0.5.0',
      latestVersion: '0.4.1'
    })
  })

  it('compares numerically, not lexicographically: 0.10.0 is newer than 0.9.0', async () => {
    const { service } = buildHarness({ version: '0.9.0', respond: async () => jsonResponse(200, release('v0.10.0')) })

    await expect(service.checkForUpdates()).resolves.toMatchObject({ status: 'available', latestVersion: '0.10.0' })
  })

  it('does not offer an older release just because its tag string sorts higher', async () => {
    const { service } = buildHarness({ version: '0.10.0', respond: async () => jsonResponse(200, release('v0.9.0')) })

    await expect(service.checkForUpdates()).resolves.toMatchObject({ status: 'up-to-date', latestVersion: '0.9.0' })
  })

  it('treats a stable release as newer than the running prerelease of the same version', async () => {
    const { service } = buildHarness({ version: '1.0.0-alpha', respond: async () => jsonResponse(200, release('v1.0.0')) })

    await expect(service.checkForUpdates()).resolves.toMatchObject({ status: 'available', latestVersion: '1.0.0' })
  })

  it('does not offer a prerelease as an upgrade over the matching stable build', async () => {
    const { service } = buildHarness({ version: '1.0.0', respond: async () => jsonResponse(200, release('v1.0.0-alpha')) })

    await expect(service.checkForUpdates()).resolves.toMatchObject({ status: 'up-to-date', latestVersion: '1.0.0-alpha' })
  })
})

describe('AppInfoService.checkForUpdates: failures never cross the IPC boundary as rejections', () => {
  it('maps a non-404 HTTP status to a readable error message', async () => {
    const { service } = buildHarness({ respond: async () => jsonResponse(503, { message: 'Service Unavailable' }) })

    await expect(service.checkForUpdates()).resolves.toEqual({ status: 'error', message: 'GitHub returned HTTP 503.' })
  })

  it('maps a rejected request to a network error message', async () => {
    const { service } = buildHarness({
      respond: async () => {
        throw new Error('getaddrinfo ENOTFOUND api.github.com')
      }
    })

    await expect(service.checkForUpdates()).resolves.toEqual({ status: 'error', message: 'Network request failed.' })
  })

  it.each(['TimeoutError', 'AbortError'])('maps an aborted request (%s) to a timeout message', async (name) => {
    const { service } = buildHarness({
      respond: async () => {
        throw named(name, 'The operation was aborted due to timeout')
      }
    })

    await expect(service.checkForUpdates()).resolves.toEqual({ status: 'error', message: 'The update check timed out.' })
  })

  it('maps an unreadable body to an error instead of throwing', async () => {
    const { service } = buildHarness({
      respond: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON')
        }
      })
    })

    await expect(service.checkForUpdates()).resolves.toEqual({
      status: 'error',
      message: 'GitHub returned a response CodeFly could not read.'
    })
  })

  it('maps a payload without a tag_name to an error', async () => {
    const { service } = buildHarness({ respond: async () => jsonResponse(200, { html_url: 'https://example.invalid' }) })

    await expect(service.checkForUpdates()).resolves.toEqual({
      status: 'error',
      message: 'GitHub returned a response CodeFly could not read.'
    })
  })

  it('explains which tag it could not read a version number from', async () => {
    const { service } = buildHarness({ respond: async () => jsonResponse(200, release('nightly-build')) })

    await expect(service.checkForUpdates()).resolves.toEqual({
      status: 'error',
      message: 'Could not read a version number from the release tag "nightly-build".'
    })
  })

  it('reports an error when the installed version itself is not valid SemVer', async () => {
    const { service } = buildHarness({ version: 'dev', respond: async () => jsonResponse(200, release('v0.5.0')) })

    await expect(service.checkForUpdates()).resolves.toEqual({
      status: 'error',
      message: 'Could not compare the installed version "dev" with the latest release.'
    })
  })
})

describe('AppInfoService.openLink', () => {
  it.each(Object.keys(EXTERNAL_LINKS) as ExternalLinkTarget[])('opens the whitelisted URL for target %s', async (target) => {
    const { service, opened } = buildHarness()

    await service.openLink(target)

    expect(opened).toEqual([EXTERNAL_LINKS[target]])
  })

  it('refuses an unknown target and never reaches the OS browser', async () => {
    const { service, opened } = buildHarness()

    await expect(service.openLink('https://evil.invalid' as ExternalLinkTarget)).rejects.toThrow(/unknown external link target/i)
    await expect(service.openLink('toString' as ExternalLinkTarget)).rejects.toThrow(/unknown external link target/i)
    expect(opened).toEqual([])
  })
})

describe('AppInfoService auto-launch', () => {
  it('reads openAtLogin from the login item settings', () => {
    const { service } = buildHarness({ loginItem: new FakeLoginItem(true) })

    expect(service.autoLaunch()).toBe(true)
  })

  it('degrades to false when the login item cannot be read, so Settings can still open', () => {
    const { service } = buildHarness({ loginItem: new FakeLoginItem(true, { readThrows: new Error('EACCES') }) })

    expect(service.autoLaunch()).toBe(false)
  })

  it('writes the requested value and returns what the OS reports afterwards', () => {
    const { service, loginItem } = buildHarness({ loginItem: new FakeLoginItem(false) })

    expect(service.setAutoLaunch(true)).toBe(true)
    expect(loginItem.writes).toEqual([true])
    expect(service.setAutoLaunch(false)).toBe(false)
  })

  it('returns the read-back value rather than echoing the request when the OS ignores the write', () => {
    const { service } = buildHarness({ loginItem: new FakeLoginItem(false, { ignoreWrites: true }) })

    expect(service.setAutoLaunch(true)).toBe(false)
  })

  it('propagates a write failure so the renderer can surface why the toggle did not stick', () => {
    const { service } = buildHarness({ loginItem: new FakeLoginItem(false, { writeThrows: new Error('Access is denied.') }) })

    expect(() => service.setAutoLaunch(true)).toThrow('Access is denied.')
  })
})

describe('SemVer helpers', () => {
  it('strips a leading v from release tags', () => {
    expect(stripVersionPrefix('v1.2.3')).toBe('1.2.3')
    expect(stripVersionPrefix('V1.2.3')).toBe('1.2.3')
    expect(stripVersionPrefix(' 1.2.3 ')).toBe('1.2.3')
  })

  it('rejects strings that are not valid SemVer', () => {
    for (const value of ['', 'nightly', '1', '1.2', '1.2.3.4', '01.2.3', 'v1.2.3']) {
      expect(parseSemVer(value)).toBeNull()
    }
  })

  it('parses core, prerelease, and build metadata', () => {
    expect(parseSemVer('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] })
    expect(parseSemVer('1.2.3-alpha.1')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: ['alpha', '1'] })
    expect(parseSemVer('1.2.3+20130313')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] })
  })

  it('orders core versions numerically', () => {
    expect(compareVersionStrings('0.10.0', '0.9.0')).toBeGreaterThan(0)
    expect(compareVersionStrings('0.9.0', '0.10.0')).toBeLessThan(0)
    expect(compareVersionStrings('1.0.0', '0.99.99')).toBeGreaterThan(0)
    expect(compareVersionStrings('1.2.10', '1.2.9')).toBeGreaterThan(0)
    expect(compareVersionStrings('1.2.3', '1.2.3')).toBe(0)
  })

  it('ignores build metadata when comparing', () => {
    expect(compareVersionStrings('1.0.0+20130313', '1.0.0+exp.sha.5114f85')).toBe(0)
  })

  it('follows the SemVer prerelease precedence chain', () => {
    const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0']
    for (let index = 0; index < ordered.length - 1; index += 1) {
      expect(compareVersionStrings(ordered[index]!, ordered[index + 1]!)).toBeLessThan(0)
      expect(compareVersionStrings(ordered[index + 1]!, ordered[index]!)).toBeGreaterThan(0)
    }
  })

  it('returns null when either side is unparseable', () => {
    expect(compareVersionStrings('dev', '1.0.0')).toBeNull()
    expect(compareVersionStrings('1.0.0', 'v1.0.1')).toBeNull()
  })

  it('compares parsed structures directly', () => {
    expect(compareSemVer(parseSemVer('2.0.0')!, parseSemVer('1.9.9')!)).toBeGreaterThan(0)
    expect(compareSemVer(parseSemVer('1.0.0-alpha')!, parseSemVer('1.0.0')!)).toBeLessThan(0)
  })
})
