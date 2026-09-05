import { describe, expect, it } from 'vitest'

import { cloneDirectoryName } from './git-clone'

describe('cloneDirectoryName', () => {
  it.each([
    ['https://github.com/owner/repo.git', 'repo'],
    [' https://gitlab.example.com/group/subgroup/repo/ ', 'repo'],
    ['git@github.com:owner/repo.git', 'repo'],
    ['ssh://git@example.com:2222/owner/repo.git', 'repo'],
    ['git://example.com/repo', 'repo'],
    ['https://example.com/my%20repo.git', 'my repo']
  ])('derives the destination for %s', (url, name) => {
    expect(cloneDirectoryName(url)).toBe(name)
  })

  it.each([
    '', '--upload-pack=evil', 'ext::command', 'ext::command/repo', 'file:///tmp/repo', 'C:\\repo',
    'https://example.com/', 'https://example.com/repo?x=1', 'https://example.com/repo#branch',
    'https://example.com/%2E%2E.git', 'https://example.com/a%2Fb.git', 'https://example.com/a%5Cb.git',
    'https://example.com/repo%00.git', 'https://example.com/CON.git', 'https://example.com/aux.txt.git',
    'https://example.com/repo./', 'https://example.com/bad%xx.git', 'git@host:repo\ncommand'
  ])('rejects unsupported addresses and unsafe directory names: %s', (url) => {
    expect(cloneDirectoryName(url)).toBeUndefined()
  })
})
