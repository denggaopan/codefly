import { z } from 'zod'

/**
 * Everything both the update *check* (AppInfoService) and the update *download*
 * (UpdaterService) need to know about the GitHub releases API: where to ask, how to ask,
 * how much of the answer to trust, and which published asset is the Windows installer.
 * Keeping it here means the two services cannot drift into disagreeing about which asset a
 * release offers — the check advertises exactly the file the download will fetch.
 */

export const LATEST_RELEASE_URL = 'https://api.github.com/repos/denggaopan/codefly/releases/latest'

// GitHub rejects unauthenticated API calls without a User-Agent, and pins the response
// shape to the documented v3 schema via the Accept header.
export const REQUEST_HEADERS: Readonly<Record<string, string>> = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'CodeFly'
}

// The asset endpoint answers with the binary itself, not JSON, so it asks for the raw bytes.
export const DOWNLOAD_HEADERS: Readonly<Record<string, string>> = {
  Accept: 'application/octet-stream',
  'User-Agent': 'CodeFly'
}

export const REQUEST_TIMEOUT_MS = 10_000

// Release assets live on github.com, which redirects to this CDN host. Anything else means
// the API answer was tampered with somewhere, and CodeFly is about to run the file it
// downloads, so a foreign host disqualifies the download rather than merely warning.
const TRUSTED_DOWNLOAD_HOSTS: readonly string[] = ['github.com', 'objects.githubusercontent.com']

// The asset name becomes a path under userData/updates and is then executed, so it is
// accepted only when it is a plain file name of the shape electron-builder produces.
// Anything else (path separators, drive letters, `..`, control characters) disqualifies
// the asset rather than being rewritten into a name that merely looks safe.
const SAFE_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._+-]*$/

const WINDOWS_INSTALLER_EXTENSION = '.exe'

// electron-builder names the NSIS package "<product>-Setup-<version>.exe".
const INSTALLER_NAME_HINT = 'setup'

// Only the fields the update flow reads. Every asset field is optional so a GitHub payload
// change can never fail the parse, and the array itself falls back to "no assets" rather
// than failing the whole release parse — a release CodeFly cannot download an installer
// from is still a release it must be able to report a version for.
const releaseAssetSchema = z.object({
  name: z.string().optional(),
  size: z.number().optional(),
  browser_download_url: z.string().optional()
})

export const latestReleaseSchema = z.object({
  tag_name: z.string(),
  html_url: z.string().optional(),
  assets: z.array(releaseAssetSchema).optional().catch(undefined)
})

export type ReleaseAsset = z.infer<typeof releaseAssetSchema>
export type LatestRelease = z.infer<typeof latestReleaseSchema>

/** A published asset that CodeFly is willing to download and run, with its resolved URL. */
export type WindowsInstaller = { fileName: string; size: number; downloadUrl: string }

const safeFileName = (name: string | undefined): string | undefined => {
  const trimmed = name?.trim()
  if (!trimmed) return undefined
  if (!SAFE_FILE_NAME_PATTERN.test(trimmed) || trimmed.includes('..')) return undefined
  return trimmed
}

/**
 * Picks the Windows installer out of a release's assets: an `.exe` with a usable name and a
 * download URL, preferring the `Setup` package when a release also ships other executables
 * (a portable build, for example). Returns undefined when the release ships no installer,
 * which is what tells the UI to fall back to the download page.
 */
export const pickWindowsInstaller = (assets: readonly ReleaseAsset[] | undefined): WindowsInstaller | undefined => {
  const candidates = (assets ?? []).flatMap((asset): WindowsInstaller[] => {
    const fileName = safeFileName(asset.name)
    if (!fileName || !fileName.toLowerCase().endsWith(WINDOWS_INSTALLER_EXTENSION)) return []
    if (!asset.browser_download_url) return []
    return [{ fileName, size: asset.size ?? 0, downloadUrl: asset.browser_download_url }]
  })

  return candidates.find((candidate) => candidate.fileName.toLowerCase().includes(INSTALLER_NAME_HINT)) ?? candidates[0]
}

/** True only for an https URL served by GitHub itself or its release-asset CDN. */
export const isTrustedInstallerUrl = (value: string): boolean => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return url.protocol === 'https:' && TRUSTED_DOWNLOAD_HOSTS.includes(url.hostname.toLowerCase())
}
