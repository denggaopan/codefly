import { resolve } from 'node:path'

import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // The pty-host rides along as a SECOND main-process input rather than a build of its own:
  // electron-vite hard-codes its three targets, but the main preset happily takes multiple
  // inputs and keeps the same externals (node-pty stays external, everything else inlines).
  //
  // The host's files are emitted as .mjs while the main entry stays .js. Both are ESM — the
  // package is `"type": "module"` — but only the main entry is loaded from inside the app,
  // where that package.json is there to say so. The host is copied out to a staging directory
  // that has no package.json (see PtyHostRuntime), and Node would read a bare .js there as
  // CommonJS and refuse to run it. The extension carries the module type instead.
  main: {
    // zod is used by the shared wire schemas and must travel inside the staged bundle; the
    // detached runtime intentionally carries no general-purpose node_modules tree.
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          'pty-host': resolve(import.meta.dirname, 'src/pty-host/index.ts')
        },
        output: {
          entryFileNames: (chunk) => (chunk.name === 'pty-host' ? 'pty-host.mjs' : '[name].js'),
          // Shared modules (shared/pty-protocol.ts, shared/agent-kinds.ts) land here, imported
          // by both entries; .mjs for the same reason as above, since the staged copy needs
          // them alongside the host.
          chunkFileNames: 'chunks/[name]-[hash].mjs'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].js'
        }
      }
    }
  },
  renderer: {
    plugins: [react()]
  }
})
