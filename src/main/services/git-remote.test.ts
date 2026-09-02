import { describe, expect, it } from 'vitest'

import { parseRemoteWebUrl } from './git-remote'

describe('parseRemoteWebUrl', () => {
  it('turns an https GitHub remote into its repository page', () => {
    expect(parseRemoteWebUrl('https://github.com/denggaopan/codefly.git')).toEqual({
      host: 'github',
      webUrl: 'https://github.com/denggaopan/codefly'
    })
  })

  it('turns an scp-like ssh remote into an https page on the same host', () => {
    expect(parseRemoteWebUrl('git@github.com:denggaopan/codefly.git')).toEqual({
      host: 'github',
      webUrl: 'https://github.com/denggaopan/codefly'
    })
  })

  it('drops the ssh user and port and recognizes self-hosted GitLab by hostname', () => {
    expect(parseRemoteWebUrl('ssh://git@gitlab.example.com:2222/group/sub/repo.git')).toEqual({
      host: 'gitlab',
      webUrl: 'https://gitlab.example.com/group/sub/repo'
    })
  })

  it('classifies any other host as plain git and keeps a plain-http scheme', () => {
    expect(parseRemoteWebUrl('http://git.internal.corp/team/repo.git')).toEqual({
      host: 'git',
      webUrl: 'http://git.internal.corp/team/repo'
    })
  })

  it('strips credentials, lowercases the host, and ignores surrounding whitespace and slashes', () => {
    expect(parseRemoteWebUrl('  https://user:token@GitHub.Example.COM/Team/Repo.GIT/ \n')).toEqual({
      host: 'github',
      webUrl: 'https://github.example.com/Team/Repo'
    })
    expect(parseRemoteWebUrl('Git@GitLab.com:/group/repo.git')).toEqual({
      host: 'gitlab',
      webUrl: 'https://gitlab.com/group/repo'
    })
  })

  it('maps the git transport onto https', () => {
    expect(parseRemoteWebUrl('git://example.com/foo/bar.git')).toEqual({ host: 'git', webUrl: 'https://example.com/foo/bar' })
  })

  it('returns undefined for remotes without a repository path or with a non-web scheme', () => {
    expect(parseRemoteWebUrl('https://github.com')).toBeUndefined()
    expect(parseRemoteWebUrl('https://github.com/.git')).toBeUndefined()
    expect(parseRemoteWebUrl('svn://example.com/foo/bar')).toBeUndefined()
    expect(parseRemoteWebUrl('https://')).toBeUndefined()
  })

  it('returns undefined for local remotes', () => {
    expect(parseRemoteWebUrl('C:\\repos\\bar')).toBeUndefined()
    expect(parseRemoteWebUrl('C:/repos/bar')).toBeUndefined()
    expect(parseRemoteWebUrl('/srv/git/bar.git')).toBeUndefined()
    expect(parseRemoteWebUrl('\\\\fileserver\\share\\repo.git')).toBeUndefined()
    expect(parseRemoteWebUrl('file:///C:/repos/bar')).toBeUndefined()
    expect(parseRemoteWebUrl('../sibling-repo')).toBeUndefined()
    expect(parseRemoteWebUrl('')).toBeUndefined()
  })
})
