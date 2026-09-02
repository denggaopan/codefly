import type { RepoHost, RepoRemote } from '../../shared/contracts'

// `[user@]host:path` — Git's scp-like syntax. The lookahead rejects `host://…` (a URL with a
// scheme is handled by the URL branch) and the one-letter host check rejects Windows drive
// paths such as `C:\repos\app`, which Git itself treats as local paths, not remotes.
const SCP_LIKE_REMOTE = /^(?:[^@/\\:]+@)?([^/\\:]{2,}):(?!\/\/)(.+)$/u

const WEB_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'ssh:', 'git:', 'git+ssh:', 'ssh+git:'])

const hostFor = (hostname: string): RepoHost => {
  if (hostname.includes('github')) return 'github'
  if (hostname.includes('gitlab')) return 'gitlab'
  return 'git'
}

const repositoryPath = (rawPath: string): string =>
  rawPath.replace(/^\/+/u, '').replace(/\/+$/u, '').replace(/\.git$/iu, '')

const build = (scheme: 'http' | 'https', hostname: string, rawPath: string): RepoRemote | undefined => {
  const host = hostname.toLowerCase()
  const path = repositoryPath(rawPath)
  if (!host || !path) return undefined
  return { host: hostFor(host), webUrl: `${scheme}://${host}/${path}` }
}

/**
 * Resolves a Git remote URL to the browsable repository page, or `undefined` when the remote
 * is not something a browser can open: local directories, `file:` URLs, and anything that
 * fails to parse. ssh/git transports are mapped onto https on the same host; an explicit
 * plain-http remote stays http, because a self-hosted server that only speaks http would not
 * answer on https. Credentials and ports in the remote never reach the returned URL.
 */
export const parseRemoteWebUrl = (remote: string): RepoRemote | undefined => {
  const trimmed = remote.trim()
  if (!trimmed) return undefined

  if (trimmed.includes('://')) {
    let url: URL
    try {
      url = new URL(trimmed)
    } catch {
      return undefined
    }
    if (!WEB_SCHEMES.has(url.protocol)) return undefined
    return build(url.protocol === 'http:' ? 'http' : 'https', url.hostname, url.pathname)
  }

  const scpLike = SCP_LIKE_REMOTE.exec(trimmed)
  if (!scpLike) return undefined
  return build('https', scpLike[1]!, scpLike[2]!)
}
