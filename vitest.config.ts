import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    // e2e/** holds Playwright Electron specs (run via `npm run test:e2e`), not Vitest
    // specs: they import '@playwright/test', not vitest, and must never be collected here.
    // .worktrees/** (CodeFly sessions) and .claude/worktrees/** (Claude Code) hold local
    // Git worktree checkouts whose duplicated test files must not run as part of this
    // checkout's suite — their nested e2e/ specs would be collected too, because the
    // 'e2e/**' pattern above only matches the top-level directory.
    exclude: [...configDefaults.exclude, 'e2e/**', '**/.worktrees/**', '**/.claude/worktrees/**'],
    coverage: {
      reporter: ['text', 'html'],
      exclude: ['out/**', 'release/**']
    }
  }
})
