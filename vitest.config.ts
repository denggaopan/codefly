import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    // e2e/** holds Playwright Electron specs (run via `npm run test:e2e`), not Vitest
    // specs: they import '@playwright/test', not vitest, and must never be collected here.
    exclude: [...configDefaults.exclude, 'e2e/**'],
    coverage: {
      reporter: ['text', 'html'],
      exclude: ['out/**', 'release/**']
    }
  }
})
