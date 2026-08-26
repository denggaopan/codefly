import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    passWithNoTests: true,
    coverage: {
      reporter: ['text', 'html'],
      exclude: ['out/**', 'release/**']
    }
  }
})
