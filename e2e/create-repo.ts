import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Creates a temporary, disposable Git repository suitable for CodeFly's E2E worktree
 * scenarios: a real `git init`, a repo-local (not global) committer identity so this never
 * touches the developer's/CI runner's own Git configuration, one committed file so `HEAD` is
 * resolvable (WorktreeService requires a committed HEAD to offer worktree mode), and a
 * printed absolute path so it can also be inspected when run directly.
 *
 * Each call gets its own uniquely-named temp directory (mkdtemp), so parallel or repeated
 * E2E runs never collide, and CodeFly's own worktree sequence numbering (scoped per
 * repository root) always starts fresh at `worktree-YYMMDD-1` for a freshly created repo.
 */
export function createRepo(): string {
  const repoPath = mkdtempSync(join(tmpdir(), 'codefly-e2e-repo-'))

  const git = (args: readonly string[]): void => {
    execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' })
  }

  git(['init', '--initial-branch=main'])
  git(['config', 'user.email', 'codefly-e2e@example.com'])
  git(['config', 'user.name', 'CodeFly E2E'])
  git(['config', 'commit.gpgsign', 'false'])

  writeFileSync(join(repoPath, 'README.md'), '# CodeFly E2E fixture repository\n', 'utf8')
  git(['add', 'README.md'])
  git(['commit', '-m', 'Initial commit'])
  // A GitHub-shaped remote (never fetched or pushed) so the project menu offers its
  // "Open Git repository" entry with the GitHub mark; the E2E browser launch is mocked.
  git(['remote', 'add', 'origin', 'https://github.com/codefly-e2e/fixture.git'])

  return repoPath
}

const isMainModule = (): boolean => {
  const invokedPath = process.argv[1]
  return invokedPath !== undefined && fileURLToPath(import.meta.url) === invokedPath
}

if (isMainModule()) {
  // eslint-disable-next-line no-console
  console.log(createRepo())
}
