import { app, shell } from 'electron'
import { z } from 'zod'

import type { AppInfo, UpdateCheckResult } from '../../shared/contracts'
import { EXTERNAL_LINKS, type ExternalLinkTarget } from '../../shared/links'

const LATEST_RELEASE_URL = 'https://api.github.com/repos/denggaopan/codefly/releases/latest'

// GitHub rejects unauthenticated API calls without a User-Agent, and pins the response
// shape to the documented v3 schema via the Accept header.
const REQUEST_HEADERS: Readonly<Record<string, string>> = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'CodeFly'
}

const REQUEST_TIMEOUT_MS = 10_000

// Only the two fields the update check needs; every other release field is ignored so a
// GitHub payload change cannot fail the parse.
const latestReleaseSchema = z.object({
  tag_name: z.string(),
  html_url: z.string().optional()
})

export type HttpResponseLike = {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal }
) => Promise<HttpResponseLike>

export type OpenExternal = (url: string) => Promise<void>
export type TimeoutSignalFactory = (milliseconds: number) => AbortSignal | undefined
export type GetVersion = () => string

// Narrow slice of Electron's login-item API so tests can substitute an in-memory fake and
// never touch the real Windows "Run" registry key.
export type LoginItemSettings = {
  getOpenAtLogin(): boolean
  setOpenAtLogin(openAtLogin: boolean): void
}

export type SemVer = {
  major: number
  minor: number
  patch: number
  prerelease: readonly string[]
}

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/

/** Strips a leading `v`/`V` from a release tag (`v0.4.1` -> `0.4.1`). */
export const stripVersionPrefix = (tag: string): string => {
  const trimmed = tag.trim()
  return /^v/i.test(trimmed) ? trimmed.slice(1) : trimmed
}

export const parseSemVer = (value: string): SemVer | null => {
  const match = SEMVER_PATTERN.exec(value.trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : []
  }
}

const isNumericIdentifier = (identifier: string): boolean => /^\d+$/.test(identifier)

const comparePrerelease = (left: readonly string[], right: readonly string[]): number => {
  // A version with no prerelease identifiers outranks one that has them (1.0.0 > 1.0.0-alpha).
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1

  const shared = Math.min(left.length, right.length)
  for (let index = 0; index < shared; index += 1) {
    const a = left[index]!
    const b = right[index]!
    if (a === b) continue
    const aNumeric = isNumericIdentifier(a)
    const bNumeric = isNumericIdentifier(b)
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (aNumeric && bNumeric) return Number(a) < Number(b) ? -1 : 1
    if (aNumeric) return -1
    if (bNumeric) return 1
    return a < b ? -1 : 1
  }
  // Every shared identifier matched, so the larger set of identifiers wins.
  return left.length === right.length ? 0 : left.length < right.length ? -1 : 1
}

/** Returns a negative number when `left` precedes `right`, 0 when equal, positive otherwise. */
export const compareSemVer = (left: SemVer, right: SemVer): number => {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1
  return comparePrerelease(left.prerelease, right.prerelease)
}

/** Compares two version strings; returns null when either side is not valid SemVer. */
export const compareVersionStrings = (left: string, right: string): number | null => {
  const parsedLeft = parseSemVer(left)
  const parsedRight = parseSemVer(right)
  if (!parsedLeft || !parsedRight) return null
  return compareSemVer(parsedLeft, parsedRight)
}

// AbortSignal.timeout surfaces as a TimeoutError; an explicit abort surfaces as AbortError.
// Both mean "we never got an answer", which reads very differently from a DNS/socket failure.
const describeRequestFailure = (error: unknown): string => {
  const name = error instanceof Error ? error.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') return 'The update check timed out.'
  return 'Network request failed.'
}

const defaultGetVersion: GetVersion = () => app.getVersion()

const defaultFetch: FetchLike = (url, init) => fetch(url, init)

const defaultOpenExternal: OpenExternal = (url) => shell.openExternal(url)

const defaultTimeoutSignal: TimeoutSignalFactory = (milliseconds) => AbortSignal.timeout(milliseconds)

const defaultLoginItemSettings: LoginItemSettings = {
  getOpenAtLogin: () => app.getLoginItemSettings().openAtLogin,
  setOpenAtLogin: (openAtLogin) => app.setLoginItemSettings({ openAtLogin })
}

/**
 * Backs the Settings dialog's About section: the running version, a GitHub release check,
 * the vetted outbound links, and the launch-at-login toggle. checkForUpdates never rejects —
 * every failure mode is folded into an `error` result so the renderer, which can only read
 * `error.message` across the IPC boundary, always gets a displayable outcome instead of an
 * unhandled rejection.
 */
export class AppInfoService {
  constructor(
    private readonly getVersion: GetVersion = defaultGetVersion,
    private readonly fetch: FetchLike = defaultFetch,
    private readonly openExternal: OpenExternal = defaultOpenExternal,
    private readonly loginItemSettings: LoginItemSettings = defaultLoginItemSettings,
    private readonly createTimeoutSignal: TimeoutSignalFactory = defaultTimeoutSignal
  ) {}

  info(): AppInfo {
    return { version: this.getVersion(), links: EXTERNAL_LINKS }
  }

  async checkForUpdates(): Promise<UpdateCheckResult> {
    const currentVersion = this.getVersion()

    let response: HttpResponseLike
    try {
      response = await this.fetch(LATEST_RELEASE_URL, {
        headers: { ...REQUEST_HEADERS },
        signal: this.createTimeoutSignal(REQUEST_TIMEOUT_MS)
      })
    } catch (error) {
      return { status: 'error', message: describeRequestFailure(error) }
    }

    // A repository that has never published a release answers 404 here; that is the current
    // real-world response for CodeFly, so it is a first-class outcome rather than a failure.
    if (response.status === 404) return { status: 'none', currentVersion }
    if (!response.ok) return { status: 'error', message: `GitHub returned HTTP ${response.status}.` }

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return { status: 'error', message: 'GitHub returned a response CodeFly could not read.' }
    }

    const release = latestReleaseSchema.safeParse(payload)
    if (!release.success) return { status: 'error', message: 'GitHub returned a response CodeFly could not read.' }

    const latestVersion = stripVersionPrefix(release.data.tag_name)
    if (!parseSemVer(latestVersion)) {
      return { status: 'error', message: `Could not read a version number from the release tag "${release.data.tag_name}".` }
    }

    const comparison = compareVersionStrings(latestVersion, currentVersion)
    if (comparison === null) {
      return { status: 'error', message: `Could not compare the installed version "${currentVersion}" with the latest release.` }
    }

    if (comparison > 0) {
      return {
        status: 'available',
        currentVersion,
        latestVersion,
        releaseUrl: release.data.html_url ?? EXTERNAL_LINKS.download
      }
    }
    return { status: 'up-to-date', currentVersion, latestVersion }
  }

  async openLink(target: ExternalLinkTarget): Promise<void> {
    if (!Object.hasOwn(EXTERNAL_LINKS, target)) throw new Error(`Unknown external link target: ${String(target)}`)
    await this.openExternal(EXTERNAL_LINKS[target])
  }

  // A read failure (an OS that refuses to report the login item) must not block the Settings
  // dialog from opening, so it degrades to "off"; a write failure is reported, because the
  // user asked for a change and needs to know it did not happen.
  autoLaunch(): boolean {
    try {
      return this.loginItemSettings.getOpenAtLogin()
    } catch {
      return false
    }
  }

  // Reads the value back after writing so the renderer reflects what the OS accepted rather
  // than echoing the request.
  setAutoLaunch(enabled: boolean): boolean {
    this.loginItemSettings.setOpenAtLogin(enabled)
    return this.autoLaunch()
  }
}
